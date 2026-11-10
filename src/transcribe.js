// transcribe.ts — PDF 转录（纯函数，不依赖 Cordis）。
//
// 三级策略：
//  1. 缓存：.txt 已存在直接复用（来源由 .transcript.json 标记；缺失 = legacy，等价 pdfjs）
//  2. 快路径：pdfjs-dist（pdf.js）本地提取文本层（文本型 PDF 毫秒级，纯 Node，无需 Python）
//  3. MinerU 后端：本地 legacy API / mineru.net v4 云端（扫描件/OCR 兜底，见 mineru.ts）
//
// 产出仍然是同一套 .txt + .pages.json（page 从 1 起），另加 .transcript.json（来源标记）
// 与 MinerU 富产物 .mineru.md/.mineru.json（Markdown + content_list，供人工核对）。
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseCloudMineru, parseLocalMineru, MineruError } from "./mineru.js";
import { MINERU_DEFAULTS } from "./mineru-config.js";
/** 扫描件/文本过短信号：文本层过少，上层据此决定 MinerU 兜底。 */
export class ShortTextError extends Error {
    constructor(message) {
        super(message);
        // 显式设 name：上层可据此区分（否则 err.name 只是 'Error'，见验证报告 O3）
        this.name = 'ShortTextError';
    }
}
/** 扫描件信号（pdfjs 提取内部使用）。 */
export class ScannedPdfError extends Error {
}
function isRecord(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
// ---- 以下为 PyMuPDF 版清洗规则的逐条 TS 移植 ----
const LIGATURES = [
    ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬀ', 'ff'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'], ['ﬅ', 'st'],
];
function ligature(s) {
    for (const [k, v] of LIGATURES)
        s = s.replaceAll(k, v);
    return s;
}
/** 页眉页脚归一化：去数字标点（对应 Python re.sub(r'[\d\W]+','',l).lower()，保留 unicode 字母）。 */
function norm(l) {
    return l.replace(/[^\p{L}_]/gu, '').toLowerCase();
}
const SENT_END = /[.!?:;]["'”’)\]]*$/;
/**
 * pdfjs 提取文本层 → 剔页眉页脚 → 清洗 → 带偏移拼页。
 * 扫描件（文本过少）抛 ScannedPdfError，交给上层决定兜底策略。
 * pdfjs-dist 体积不小，动态 import，首次转录时才加载。
 */
async function extractWithPdfjs(pdfPath) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await readFile(pdfPath));
    const loadingTask = getDocument({ data, disableFontFace: true, verbosity: 0 });
    const doc = await loadingTask.promise;
    try {
        // 每页拼行：getTextContent 的 hasEOL 标记行尾，等价于 PyMuPDF get_text().splitlines()
        const rawPages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            const lines = [];
            let cur = '';
            for (const item of tc.items) {
                if (typeof item.str !== 'string')
                    continue;
                cur += item.str;
                if (item.hasEOL) {
                    lines.push(cur.trim());
                    cur = '';
                }
            }
            if (cur.trim())
                lines.push(cur.trim());
            rawPages.push(lines.filter((l) => l));
            page.cleanup();
        }
        // 页眉页脚识别：页首 2 行/页尾 3 行归一化（去数字标点），
        // 在 >=1/5 页面边缘反复出现即剔除；只剔边缘行，正文相同行不受影响。
        const thresh = Math.max(3, Math.floor(rawPages.length / 5));
        const edge = new Map();
        for (const p of rawPages) {
            for (const l of [...p.slice(0, 2), ...p.slice(-3)]) {
                const n = norm(l);
                edge.set(n, (edge.get(n) ?? 0) + 1);
            }
        }
        const bad = new Set([...edge].filter(([, n]) => n >= thresh).map(([l]) => l));
        const pageTexts = [];
        for (const p of rawPages) {
            while (p.length && bad.has(norm(p[0])))
                p.shift();
            while (p.length && bad.has(norm(p[p.length - 1])))
                p.pop();
            let t = p.join('\n');
            t = ligature(t);
            t = t.replace(/(\w)-\n(\w)/g, '$1$2'); // 页内断词愈合
            pageTexts.push(t.trim());
        }
        const total = pageTexts.reduce((s, t) => s + t.length, 0);
        if (total < 100 * Math.max(1, doc.numPages))
            throw new ScannedPdfError();
        // 段落重排拼页：PDF 分页会把一个句子拆到相邻两页（页眉页脚剔除后就挨在一起）。
        // 上一页不以句末标点结束、且下一页以小写字母开头 → 同句延续，用空格衔接；
        // 该页的偏移区间只覆盖它自己的文字（跨页句引用起始页）。
        let buf = '';
        const spans = [];
        for (let i = 0; i < pageTexts.length; i++) {
            const t = pageTexts[i];
            if (!t)
                continue;
            if (!buf) {
                spans.push({ page: i + 1, start: 0, end: t.length });
                buf = t;
                continue;
            }
            let start;
            if (!SENT_END.test(buf) && /^\p{Ll}/u.test(t)) {
                buf = buf.replace(/[ \n]+$/, '');
                start = buf.length + 1;
                buf = buf + ' ' + t;
            }
            else {
                start = buf.length + 2;
                buf = buf + '\n\n' + t;
            }
            spans.push({ page: i + 1, start, end: buf.length });
        }
        return { pageCount: doc.numPages, chars: buf.length, text: buf, pages: spans };
    }
    finally {
        await loadingTask.destroy();
    }
}
/** 来源入参 → 目标 producer；auto 按配置 mode 决定。 */
function producerForSource(source) {
    if (source === 'pdfjs')
        return 'pdfjs';
    if (source === 'mineru-local')
        return 'mineru-local';
    if (source === 'mineru-cloud')
        return 'mineru-cloud';
    throw new Error(`内部错误：未知 source ${source}`);
}
function producerForMode(mode) {
    if (mode === 'local')
        return 'mineru-local';
    if (mode === 'cloud')
        return 'mineru-cloud';
    return 'pdfjs';
}
/** 缓存命中判定：source='pdfjs' 命中 legacy/pdfjs；显式 mineru-* 只命中同源。 */
function producerMatches(requested, actual) {
    if (requested === 'pdfjs')
        return actual === 'pdfjs' || actual === 'legacy';
    return requested === actual;
}
/** 读 .transcript.json 的来源标记；缺失/损坏/形状不对返回 null（归类 legacy）。 */
export async function readTranscriptMeta(ref) {
    try {
        const raw = JSON.parse(await readFile(ref.transcriptPath, 'utf8'));
        if (!isRecord(raw))
            return null;
        const producer = raw['producer'];
        if (producer !== 'pdfjs' && producer !== 'mineru-local' && producer !== 'mineru-cloud')
            return null;
        const engine = isRecord(raw['engine']) ? raw['engine'] : null;
        let backend = null;
        if (engine) {
            if (typeof engine['backend'] === 'string')
                backend = engine['backend'];
            else if (typeof engine['modelVersion'] === 'string')
                backend = engine['modelVersion'];
        }
        return { producer, backend };
    }
    catch {
        return null;
    }
}
/** 读现有缓存 + 来源标记；txt 缺失返回 null。 */
async function readCached(ref) {
    let text;
    try {
        text = await readFile(ref.txtPath, 'utf8');
    }
    catch {
        return null;
    }
    const pages = await readPages(ref);
    let producer = 'legacy';
    let backend = null;
    let corrupted = false;
    try {
        const raw = JSON.parse(await readFile(ref.transcriptPath, 'utf8'));
        if (isRecord(raw)) {
            const p = raw['producer'];
            if (p === 'pdfjs' || p === 'mineru-local' || p === 'mineru-cloud')
                producer = p;
            const engine = isRecord(raw['engine']) ? raw['engine'] : null;
            if (engine) {
                if (typeof engine['backend'] === 'string')
                    backend = engine['backend'];
                else if (typeof engine['modelVersion'] === 'string')
                    backend = engine['modelVersion'];
            }
            const tb = isRecord(raw['text']) ? raw['text']['bytes'] : undefined;
            if (typeof tb === 'number' && tb !== Buffer.byteLength(text, 'utf8'))
                corrupted = true;
        }
    }
    catch { /* transcript.json 缺失/损坏 → legacy，不判损坏 */ }
    return { text, pages, producer, backend, corrupted };
}
/**
 * 转录一篇文献：缓存优先（来源语义见 §8），否则按 source/mode 选引擎解析并落盘。
 * @param opts.source 入参来源（默认 auto）；auto 命中缓存即复用，无缓存按配置 mode。
 * @param opts.mineru 已解析的 MinerU 配置（缺省 mode=off，行为与改造前一致）。
 */
export async function transcribePaper(ref, opts = {}) {
    const source = opts.source ?? 'auto';
    const mineru = opts.mineru ?? { config: MINERU_DEFAULTS, source: 'none' };
    const force = opts.force === true;
    // auto 无缓存时按配置 mode 决定目标引擎；显式 source 优先于 mode（mode=off 不阻止显式来源）
    const targetProducer = source === 'auto' ? producerForMode(mineru.config.mode) : producerForSource(source);
    if (!force) {
        const cached = await readCached(ref);
        // 沿用 v1.2.0 的「缓存有效」门槛（.txt 字节数 > 1000）：过短的缓存视为无效，重新解析。
        const valid = cached !== null && !cached.corrupted && Buffer.byteLength(cached.text, 'utf8') > 1000;
        if (valid) {
            const hit = source === 'auto' ? true : producerMatches(targetProducer, cached.producer);
            if (hit) {
                let pages = cached.pages;
                // 兼容升级：pdfqa 时代的缓存只有 .txt 没有页码索引。重新提取生成页码索引；
                // 新旧文本长度接近才覆盖（视觉转录的扫描件缓存不容侵犯）。
                if (!pages && cached.producer === 'legacy') {
                    const upgraded = await tryUpgradePageIndex(ref, cached.text.length);
                    if (upgraded) {
                        pages = upgraded.pages;
                        return { text: upgraded.text, pages, pageCount: pages.length, chars: upgraded.text.length, source: 'cache', producer: 'legacy', backend: null };
                    }
                }
                return {
                    text: cached.text,
                    pages: pages ?? [],
                    pageCount: pages?.length ?? 0,
                    chars: cached.text.length,
                    source: 'cache',
                    producer: cached.producer,
                    backend: cached.backend,
                };
            }
            // 显式 source 与缓存 producer 不命中 → 判定 stale，重新解析并覆盖（§8）
        }
    }
    // 重新解析
    if (targetProducer === 'pdfjs') {
        return await parseAndStorePdfjs(ref, mineru);
    }
    if (targetProducer === 'mineru-local') {
        return await parseAndStoreMineru(ref, 'mineru-local', mineru.config);
    }
    return await parseAndStoreMineru(ref, 'mineru-cloud', mineru.config);
}
/** 本地提取（不落盘）。文本过少抛 ShortTextError，供上层做 MinerU 兜底。 */
export async function extractLocal(pdfPath) {
    let data;
    try {
        data = await extractWithPdfjs(pdfPath);
    }
    catch (err) {
        if (err instanceof ScannedPdfError) {
            // 文案只描述「发生了什么」，可执行指引由上层按 MinerU 是否启用补充（见 parseAndStorePdfjs）。
            // 不再声称「视觉转录兜底尚未实现」——1.3.0 起 MinerU 就是那个兜底（验证报告 O2）。
            throw new ShortTextError('本地提取的文本过少，该 PDF 可能是扫描件（没有可用文本层）。');
        }
        throw new Error(`PDF 文本提取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    if (data.text.length < 1000) {
        throw new ShortTextError(`转录结果过短(${data.text.length} 字符)，疑似失败，请重试`);
    }
    return { text: data.text, pages: data.pages, pageCount: data.pageCount, chars: data.chars, source: 'local', producer: 'pdfjs', backend: null };
}
/**
 * 原子写的临时文件路径：pid + 随机后缀。
 * 只用 pid 时，同一进程内并发写同一目标会撞名并交叉覆盖多文件提交序列（验证报告 F6）。
 */
export function atomicTempPath(path) {
    return `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
}
/** 原子写：写临时文件再 rename，POSIX rename 原子覆盖，避免半成品缓存。 */
async function atomicWrite(path, content) {
    const tmp = atomicTempPath(path);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
}
/** pdfjs 提取并落盘（.txt + .pages.json + .transcript.json），并清理 MinerU 富产物。 */
async function parseAndStorePdfjs(ref, mineru) {
    try {
        const t = await extractLocal(ref.pdfPath);
        await writeFile(ref.txtPath, t.text, 'utf8');
        await writeFile(ref.pagesPath, JSON.stringify({ pageCount: t.pageCount, pages: t.pages }, null, 2), 'utf8');
        await writeFile(ref.transcriptPath, JSON.stringify(pdfjsTranscriptMeta(t), null, 2), 'utf8');
        // 非 MinerU 来源重写成功后删除 MinerU 富产物（避免富产物与文本不同源，AC-C9）
        await rm(ref.mineruMdPath, { force: true });
        await rm(ref.mineruJsonPath, { force: true });
        return t;
    }
    catch (err) {
        // 扫描件/文本过短：若 MinerU 已配置可用 → 自动兜底改走 MinerU（S10）
        if (err instanceof ShortTextError && mineru.config.mode !== 'off') {
            const fallback = mineru.config.mode === 'cloud' ? 'mineru-cloud' : 'mineru-local';
            try {
                return await parseAndStoreMineru(ref, fallback, mineru.config);
            }
            catch (mineruErr) {
                // MinerU 兜底也失败：报扫描件错误 + MinerU 指引，不静默吞掉
                throw new ShortTextError(`${err.message}（已尝试 MinerU 兜底也失败：${mineruErr instanceof Error ? mineruErr.message : String(mineruErr)}）`);
            }
        }
        if (err instanceof ShortTextError) {
            throw new ShortTextError(`${err.message}（可在「设置 → 论文伴读」启用 MinerU 后端自动解析扫描件，或换文本型 PDF、手动放置同名 .txt 缓存）`);
        }
        throw err;
    }
}
/** MinerU 解析并落盘（§7.3/§7.5：先写富产物，最后写 .transcript.json 提交标记）。 */
async function parseAndStoreMineru(ref, producer, cfg) {
    const pdfBytes = new Uint8Array(await readFile(ref.pdfPath));
    const fileName = ref.name + '.pdf';
    const result = producer === 'mineru-local'
        ? await parseLocalMineru({
            baseUrl: cfg.local.baseUrl,
            apiKey: cfg.local.apiKey,
            backend: cfg.local.backend,
            effort: cfg.local.effort,
            parseMethod: cfg.local.parseMethod,
            serverUrl: cfg.local.serverUrl,
            langList: cfg.local.langList,
            imageAnalysis: cfg.local.imageAnalysis,
            requestTimeoutMs: cfg.local.requestTimeoutMs,
            pollIntervalMs: cfg.local.pollIntervalMs,
            noResponseTimeoutMs: cfg.local.noResponseTimeoutMs,
            jobTimeoutMs: cfg.local.jobTimeoutMs,
            pdfBytes,
            fileName,
        })
        : await parseCloudMineru({
            baseUrl: cfg.cloud.baseUrl,
            apiKey: cfg.cloud.apiKey,
            modelVersion: cfg.cloud.modelVersion,
            pollIntervalMs: cfg.cloud.pollIntervalMs,
            zipTimeoutMs: cfg.cloud.zipTimeoutMs,
            pdfBytes,
            fileName,
        });
    const { projection, markdown, blocks, meta } = result;
    const text = projection.text;
    const hasMd = markdown.trim().length > 0;
    // 写盘前校验（§7.5.1）：至少 md_content 或投影文本有一个非空；有 content_list 能建页码索引；文本 >=1000。
    // 任一不过直接抛错，不写任何文件（失败不得污染缓存）。
    // 顺序刻意把「content_list 缺失」放在「文本过短」之前：md 好但 content_list 为 null 时，
    // 真正原因是拿不到页码索引，而不是解析失败（验证报告 F4）。
    if (!hasMd && !text.trim())
        throw new MineruError('MinerU 未返回可用内容（md_content 与投影文本均为空）');
    if (projection.pages.length < 1) {
        throw new MineruError('MinerU 未返回 content_list（或该字段为空），无法建立页码索引；请确认服务端请求带了 return_content_list=true，或改用 pdfjs 后端。');
    }
    if (text.length < 1000)
        throw new MineruError(`MinerU 转录结果过短(${text.length} 字符)，疑似失败，请重试`);
    const createdAt = new Date().toISOString();
    const warnings = projection.warnings;
    // 写盘顺序：mineru.md → mineru.json → pages.json → txt → transcript.json（最后=提交标记）
    await atomicWrite(ref.mineruMdPath, markdown);
    await atomicWrite(ref.mineruJsonPath, JSON.stringify(mineruJsonPayload(producer, meta, projection, blocks, createdAt), null, 2));
    await atomicWrite(ref.pagesPath, JSON.stringify({ pageCount: projection.pageCount, pages: projection.pages }, null, 2));
    await atomicWrite(ref.txtPath, text);
    await atomicWrite(ref.transcriptPath, JSON.stringify(mineruTranscriptMeta(producer, meta, text, projection, warnings, createdAt), null, 2));
    const backend = producer === 'mineru-local' ? (meta.backend ?? null) : (meta.modelVersion ?? null);
    return {
        text,
        pages: projection.pages,
        pageCount: projection.pageCount,
        chars: text.length,
        source: producer,
        producer,
        backend,
    };
}
function pdfjsTranscriptMeta(t) {
    return {
        v: 1,
        producer: 'pdfjs',
        createdAt: new Date().toISOString(),
        text: { bytes: Buffer.byteLength(t.text, 'utf8'), chars: t.chars, pageCount: t.pageCount },
    };
}
function mineruTranscriptMeta(producer, meta, text, projection, warnings, createdAt) {
    const engine = producer === 'mineru-local'
        ? {
            kind: 'mineru-local',
            api: 'legacy',
            baseUrl: meta.baseUrl,
            ...(meta.serverVersion ? { serverVersion: meta.serverVersion } : {}),
            ...(meta.backend ? { backend: meta.backend } : {}),
            ...(meta.effort ? { effort: meta.effort } : {}),
            ...(meta.parseMethod ? { parseMethod: meta.parseMethod } : {}),
            ...(meta.langList ? { langList: meta.langList } : {}),
            ...(meta.taskId ? { taskId: meta.taskId } : {}),
            elapsedMs: meta.elapsedMs,
        }
        : {
            kind: 'mineru-cloud',
            api: 'v4',
            baseUrl: meta.baseUrl,
            ...(meta.batchId ? { batchId: meta.batchId } : {}),
            modelVersion: meta.modelVersion ?? 'pipeline',
        };
    return {
        v: 1,
        producer,
        createdAt,
        text: { bytes: Buffer.byteLength(text, 'utf8'), chars: text.length, pageCount: projection.pageCount },
        engine,
        warnings,
    };
}
function mineruJsonPayload(producer, meta, projection, blocks, createdAt) {
    return {
        v: 1,
        producer,
        createdAt,
        ...(meta.serverVersion ? { serverVersion: meta.serverVersion } : {}),
        ...(meta.backend ? { backend: meta.backend } : {}),
        pageCount: projection.pageCount,
        imagesAvailable: false,
        contentList: blocks,
    };
}
/** 为旧缓存补建页码索引：成功且长度相近才覆盖 .txt，返回新内容；否则返回 null。 */
async function tryUpgradePageIndex(ref, cachedLen) {
    try {
        const t = await extractLocal(ref.pdfPath);
        const ratio = t.text.length / Math.max(1, cachedLen);
        if (ratio < 0.5 || ratio > 2)
            return null; // 差异过大：旧文本可能来自视觉转录，不回写
        await writeFile(ref.txtPath, t.text, 'utf8');
        await writeFile(ref.pagesPath, JSON.stringify({ pageCount: t.pageCount, pages: t.pages }, null, 2), 'utf8');
        return { text: t.text, pages: t.pages };
    }
    catch {
        return null; // 提取失败或扫描件：保持旧缓存，页码索引缺席
    }
}
/** 读页码偏移表；旧缓存（pdfqa 时代）没有 pages.json 时返回 null。 */
export async function readPages(ref) {
    try {
        const raw = JSON.parse(await readFile(ref.pagesPath, 'utf8'));
        return raw.pages;
    }
    catch {
        return null;
    }
}
/** 读转录文本（不触发转录）；无缓存返回 null。 */
export async function readTranscript(ref) {
    try {
        const text = await readFile(ref.txtPath, 'utf8');
        return { text, pages: await readPages(ref) };
    }
    catch {
        return null;
    }
}
/** 转录缓存大小（供外部快速判断，保留 v1.2.0 语义）。 */
export function transcriptBytes(ref) {
    try {
        return statSync(ref.txtPath).size;
    }
    catch {
        return 0;
    }
}
