// embed.ts — OpenAI 兼容嵌入端点客户端 + 分块嵌入缓存 + 混合召回（纯函数，不依赖 Cordis）。
//
// 形状对齐 rerank.ts：**可选增强、默认关闭、失败降级**而不是抛给用户。与重排的分工：
//   - 重排（rerank.ts）：对关键词 shortlist **定序**（候选已经捞回来了）；
//   - 嵌入（本文件）：**全量召回**——关键词一个词都没命中的语义相近片段也能进候选。
// 两者可同时启用，顺序固定：关键词候选 ∪ 嵌入候选 → RRF 融合 →（配了 Jev/TypeSafe 则）既有重排 → top-k。
//
// 缓存：`<论文>.embeddings.json`，键 = {model, dimensions, 内容哈希}；命中时**不请求分块嵌入**。
// 隐私：分块文本会发往配置的端点（README 有明确提示）；缓存与错误信息里都不出现 apiKey。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pageForOffset } from "./search.js";
import { sanitizeDetail } from "./mineru.js";
export const EMBED_DEFAULTS = {
    /**
     * 保守默认：主流 OpenAI 兼容端点的单批上限参差——阿里云百炼 text-embedding-v3/v4 是 10 条、
     * qwen3.7-text-embedding 是 20 条（issue #14），OpenAI 官方则宽松得多。取已知最严格的 10：
     * 对宽松端点只是多几个小请求，对严格端点则是「开箱即用 vs 首次检索必失败」的差别。
     * 端点允许更大批量时可在设置面板 / profile 调高。
     */
    batchSize: 10,
    timeoutMs: 30_000,
    candidateSize: 20,
};
/** 嵌入链路错误的统一类型：调用方据此**整体降级**为纯关键词，不把它抛给用户。 */
export class EmbedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EmbedError';
    }
}
/** `<论文>.txt` → `<论文>.embeddings.json`（与 .txt/.pages.json 同目录同前缀）。 */
export function embeddingsPathFor(txtPath) {
    return txtPath.replace(/\.txt$/i, '') + '.embeddings.json';
}
/**
 * 分块集合的内容哈希（缓存失效条件之一）：分块大小 + 分块数 + 每块长度 + 每块文本，顺序敏感。
 * `.txt` 变了 / 分块大小变了 / 重新转录了 → 哈希变 → 缓存判定失效并重算。
 */
export function chunkSetHash(chunks, chunkSize = 1500) {
    const h = createHash('sha256');
    h.update(`chunkSize:${chunkSize};count:${chunks.length}\n`);
    for (const c of chunks)
        h.update(`${c.text.length}:${c.text}\n`);
    return h.digest('hex');
}
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}
/**
 * 校验嵌入响应：形状（条数一致）、维度一致、**必须都是有限数**（NaN/Infinity/字符串一律拒绝）。
 * 同时容忍两种常见形状：OpenAI 的 `{index, embedding}` 与部分本地实现直接给的数组。
 */
export function validateEmbeddings(raw, expected, where) {
    if (!Array.isArray(raw))
        throw new EmbedError(`${where}：data 不是数组`);
    if (raw.length !== expected)
        throw new EmbedError(`${where}：返回 ${raw.length} 条嵌入，期望 ${expected} 条`);
    const out = [];
    let dim = -1;
    for (const row of raw) {
        const vec = Array.isArray(row) ? row : isRecord(row) ? row['embedding'] : undefined;
        if (!Array.isArray(vec))
            throw new EmbedError(`${where}：条目缺少 embedding 数组`);
        if (vec.length === 0)
            throw new EmbedError(`${where}：嵌入维度为 0`);
        for (const v of vec) {
            if (!isFiniteNumber(v))
                throw new EmbedError(`${where}：嵌入含非数值/NaN，已拒绝`);
        }
        if (dim === -1)
            dim = vec.length;
        else if (vec.length !== dim)
            throw new EmbedError(`${where}：同批嵌入维度不一致（${dim} vs ${vec.length}）`);
        out.push(vec);
    }
    return out;
}
/** 端点 URL：允许用户直接填到 `/embeddings`，否则拼在根后面。 */
export function embeddingsUrl(baseUrl) {
    const base = baseUrl.replace(/\/+$/, '');
    return /\/embeddings$/i.test(base) ? base : `${base}/embeddings`;
}
function networkMessage(err) {
    if (err instanceof Error) {
        const cause = err.cause instanceof Error ? `：${err.cause.message}` : '';
        return `${err.name === 'TimeoutError' ? '请求超时' : err.message}${cause}`;
    }
    return String(err);
}
/**
 * 一次 `/embeddings` 调用（一批文本）。任何失败都抛 EmbedError（调用方整体降级）。
 * 错误文案里的端点响应体片段一律经 sanitizeDetail(…, apiKey) 脱敏。
 */
export async function requestEmbeddings(req, texts) {
    if (texts.length === 0)
        return [];
    const timeoutMs = req.timeoutMs ?? EMBED_DEFAULTS.timeoutMs;
    const fetchImpl = req.fetchImpl ?? fetch;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (req.signal)
        signals.push(req.signal);
    let res;
    try {
        res = await fetchImpl(embeddingsUrl(req.baseUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
            body: JSON.stringify({ model: req.model, input: texts, encoding_format: 'float' }),
            signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        });
    }
    catch (err) {
        throw new EmbedError(`嵌入端点请求失败：${sanitizeDetail(networkMessage(err), req.apiKey)}`);
    }
    const body = await res.text().catch(() => '');
    if (!res.ok) {
        const detail = sanitizeDetail(body.slice(0, 200), req.apiKey);
        throw new EmbedError(`嵌入端点返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        throw new EmbedError('嵌入端点返回的不是合法 JSON');
    }
    return validateEmbeddings(isRecord(parsed) ? parsed['data'] : undefined, texts.length, '嵌入端点响应');
}
// ── 缓存 ────────────────────────────────────────────────────────────────
/** 读缓存：文件缺失/损坏/形状不对一律 null（与其余 *.json 读策略一致）。 */
export async function readEmbedCache(path) {
    try {
        const data = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(data))
            return null;
        const vectors = data['vectors'];
        if (!Array.isArray(vectors))
            return null;
        if (typeof data['model'] !== 'string' || typeof data['contentHash'] !== 'string')
            return null;
        if (!Number.isInteger(data['dimensions']))
            return null;
        return {
            v: 1,
            // 旧缓存没有 baseUrl 字段 → 记为空串 → 与任何真实 baseUrl 都不相等 → 判定失效重算（一次性的预期失效）
            baseUrl: typeof data['baseUrl'] === 'string' ? data['baseUrl'] : '',
            model: data['model'],
            dimensions: data['dimensions'],
            contentHash: data['contentHash'],
            createdAt: typeof data['createdAt'] === 'string' ? data['createdAt'] : '',
            vectors: vectors,
        };
    }
    catch {
        return null;
    }
}
/** 原子写缓存（临时文件 + rename），避免半截 JSON 被当成有效缓存。 */
export async function writeEmbedCache(path, cache) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    await writeFile(tmp, JSON.stringify(cache), 'utf8');
    await rename(tmp, path);
}
/** 删除缓存（模型/维度失效或用户显式清理时用）。 */
export async function clearEmbedCache(path) {
    await rm(path, { force: true });
}
/**
 * 惰性计算分块嵌入：缓存有效则直接复用（零分块请求），否则按 batchSize 分批请求。
 * 缓存键 = `{baseUrl, model, dimensions, 内容哈希}`（F-E2：baseUrl 与查询向量备忘对齐，
 * 换端点必须重算）；缓存有效性 = v=1 ∧ baseUrl 一致 ∧ model 一致 ∧ 内容哈希一致 ∧ 条数一致
 * ∧ 维度一致（含 expectedDimensions）∧ 全为有限数。
 * 任一批次失败都抛 EmbedError（调用方整体降级），**不写缓存** —— 绝不产生半截缓存。
 */
export async function ensureChunkVectors(o) {
    const model = o.req.model;
    const hash = chunkSetHash(o.chunks, o.chunkSize ?? 1500);
    const cached = await readEmbedCache(o.cachePath);
    const cacheOk = cached !== null &&
        cached.baseUrl === o.req.baseUrl &&
        cached.model === model &&
        cached.contentHash === hash &&
        cached.vectors.length === o.chunks.length &&
        cached.dimensions > 0 &&
        cached.vectors.every((v) => Array.isArray(v) && v.length === cached.dimensions && v.every(isFiniteNumber)) &&
        (o.expectedDimensions === undefined || o.expectedDimensions === cached.dimensions);
    if (cacheOk)
        return { vectors: cached.vectors, dimensions: cached.dimensions, fromCache: true };
    if (o.chunks.length === 0)
        return { vectors: [], dimensions: o.expectedDimensions ?? 0, fromCache: false };
    const batchSize = Math.max(1, o.batchSize ?? EMBED_DEFAULTS.batchSize);
    const vectors = [];
    let dimensions = -1;
    for (let i = 0; i < o.chunks.length; i += batchSize) {
        const part = o.chunks.slice(i, i + batchSize);
        const got = await requestEmbeddings(o.req, part.map((c) => c.text));
        for (const v of got) {
            if (dimensions === -1)
                dimensions = v.length;
            else if (v.length !== dimensions)
                throw new EmbedError(`分批嵌入维度不一致（${dimensions} vs ${v.length}）`);
            vectors.push(v);
        }
    }
    if (o.expectedDimensions !== undefined && dimensions !== o.expectedDimensions) {
        throw new EmbedError(`嵌入维度与查询向量不一致（${dimensions} vs ${o.expectedDimensions}），本次语义召回已放弃`);
    }
    await writeEmbedCache(o.cachePath, {
        v: 1,
        baseUrl: o.req.baseUrl,
        model,
        dimensions,
        contentHash: hash,
        createdAt: new Date().toISOString(),
        vectors,
    });
    return { vectors, dimensions, fromCache: false };
}
/**
 * 进程内查询向量备忘：同一查询重复检索（同一模型/端点）时**零网络请求**。
 * 键含 endpoint+model，换模型/换端点自动失效；只留最近 32 条，不落盘（查询文本不进缓存文件）。
 */
const queryMemo = new Map();
const QUERY_MEMO_MAX = 32;
function memoKey(req, text) {
    return `${req.baseUrl}|${req.model}|${text}`;
}
/** 清空查询向量备忘（测试/换模型时用）。 */
export function clearEmbedQueryMemo() {
    queryMemo.clear();
}
/** 查询向量（带进程内备忘）。 */
export async function embedQuery(req, text) {
    const key = memoKey(req, text);
    const hit = queryMemo.get(key);
    if (hit)
        return hit;
    const [vec] = await requestEmbeddings(req, [text]);
    if (!vec)
        throw new EmbedError('嵌入端点未返回查询向量');
    queryMemo.set(key, vec);
    if (queryMemo.size > QUERY_MEMO_MAX) {
        const oldest = queryMemo.keys().next().value;
        if (oldest !== undefined)
            queryMemo.delete(oldest);
    }
    return vec;
}
// ── 召回与融合 ──────────────────────────────────────────────────────────
/** 余弦相似度；维度不同/零向量一律返回 0（不抛错，避免脏数据中断检索）。 */
export function cosineSimilarity(a, b) {
    if (a.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/** 语义召回：按余弦取前 limit 块（相似度 ≤ 0 视为噪声，不进候选）。 */
export function embeddingRecall(chunks, pages, queryVector, vectors, limit) {
    const scored = [];
    const n = Math.min(chunks.length, vectors.length);
    for (let i = 0; i < n; i++) {
        const sim = cosineSimilarity(queryVector, vectors[i]);
        if (sim > 0) {
            scored.push({ chunk: chunks[i], score: Math.round(sim * 1000) / 1000, page: pageForOffset(pages, chunks[i].start) });
        }
    }
    scored.sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
    return scored.slice(0, Math.max(1, limit));
}
/**
 * RRF 融合（Reciprocal Rank Fusion，k=60）：关键词候选 ∪ 语义候选 → 按**名次**加权求和 → 去重。
 * 为什么用名次而不是原始分数：关键词分（词频×词长）与余弦相似度量纲完全不同，直接相加没有意义。
 *
 * **返回序 = RRF 相关性序**（issue #13）：调用方必须先按本序截取 top-k，再按 chunk.index 排展示序。
 * 这里绝不预先按原文排序——否则上层 `slice(0, k)` 会按文档位置而非相关性截取，丢掉更相关的片段。
 *
 * **实际语义（F-E1 如实记录，算法有意如此，不是 bug）**：
 *   - 只吃名次、**完全不看分数大小**：关键词第 i 名与语义第 j 名的贡献分别是 1/(60+i) 与 1/(60+j)，
 *     所以语义第 j 名会压过关键词第 i 名（当 j < i）——两列候选会**交替占用**最终 top-k 名额；
 *   - 「关键词优先」只在**精确同分**时生效（两列名次相同、分数相等时关键词那列排前面）；
 *   - 两列都命中的片段获得两份贡献，自然排最前。
 * 这正是「嵌入作为召回、与关键词候选交替占位」的预期形态：关键词检索仍在跑并持续贡献候选，
 * 并未被替换。**注意**：本机没有真实嵌入端点可用于调参，故不引入「按分数插值 / 名额保底」
 * 这类无法验证的融合策略；若将来要改（例如给关键词列加权或保底名额），需先回报队长并补可验证证据。
 */
export function fuseHybridCandidates(keyword, semantic, limit) {
    const RRF_K = 60;
    const byRank = (hits) => hits.slice().sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index);
    const kw = byRank(keyword);
    const sem = byRank(semantic);
    const byChunk = new Map();
    const score = new Map();
    const fromKeyword = new Set();
    kw.forEach((h, i) => {
        byChunk.set(h.chunk.index, h);
        fromKeyword.add(h.chunk.index);
        score.set(h.chunk.index, (score.get(h.chunk.index) ?? 0) + 1 / (RRF_K + i + 1));
    });
    sem.forEach((h, i) => {
        if (!byChunk.has(h.chunk.index))
            byChunk.set(h.chunk.index, h);
        score.set(h.chunk.index, (score.get(h.chunk.index) ?? 0) + 1 / (RRF_K + i + 1));
    });
    const picked = [...byChunk.keys()]
        .sort((a, b) => {
        const d = (score.get(b) ?? 0) - (score.get(a) ?? 0);
        if (d !== 0)
            return d;
        const ka = fromKeyword.has(a);
        const kb = fromKeyword.has(b);
        if (ka !== kb)
            return ka ? -1 : 1;
        return a - b;
    })
        .slice(0, Math.max(1, limit))
        .map((idx) => byChunk.get(idx));
    return picked; // 保持 RRF 相关性序；展示用的原文序由调用方在**选定 top-k 之后**再排（issue #13）
}
/**
 * 端点按模型限制单批条数时的典型拒绝文案特征（如百炼：`batch size is invalid, it should
 * not be larger than 20`）。命中就附一句可操作建议——降级原因必须能指导用户自救，
 * 不能只甩端点原文（issue #14）。只做提示，不做自动拆批重试：错误文案各家不一，
 * 盲目匹配重试反而可能对着任意 400 反复打请求。
 */
export function batchLimitHint(message) {
    const re = /batch\s*size|too\s+many\s+(inputs?|texts?|items?)|input.{0,40}(larger|exceed|limit|maximum)|(larger|exceed|maximum).{0,40}batch/i;
    return re.test(message) ? '端点可能限制了单批嵌入条数：在「嵌入模型检索」设置里调低批大小（或 profile config.embed 的 batchSize）后重试' : null;
}
/**
 * 惰性语义召回：查询向量（带进程内备忘）+ 分块向量（带磁盘缓存）→ 余弦 top-N。
 * 任何失败（不可达/超时/HTTP 错误/形状或维度非法/非数值）都**吞成 degraded 原因**，
 * 返回空候选让调用方继续用关键词结果——绝不抛错中断检索。
 */
export async function embeddingRecallFor(o) {
    if (!o.configured || !o.req) {
        return { hits: [], configured: false, used: false, fromCache: false, degraded: null };
    }
    try {
        const queryVector = await embedQuery(o.req, o.query);
        const { vectors, fromCache } = await ensureChunkVectors({
            cachePath: o.cachePath,
            chunks: o.chunks,
            ...(o.chunkSize !== undefined ? { chunkSize: o.chunkSize } : {}),
            req: o.req,
            expectedDimensions: queryVector.length,
            ...(o.batchSize !== undefined ? { batchSize: o.batchSize } : {}),
        });
        const hits = embeddingRecall(o.chunks, o.pages, queryVector, vectors, o.limit ?? EMBED_DEFAULTS.candidateSize);
        return { hits, configured: true, used: hits.length > 0, fromCache, degraded: null };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = batchLimitHint(msg);
        return { hits: [], configured: true, used: false, fromCache: false, degraded: hint ? `${msg}；${hint}` : msg };
    }
}
