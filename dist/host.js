// host.ts — webServer 路由：阅读器页面 + PDF 文件 + 转录数据接口 + 选中即问。
// 壳层代码：只做 HTTP ↔ 纯函数核心(library/transcribe)的转接。
import { createReadStream, existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { mkdir, readFile, stat, lstat, readdir, open, link, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { listTopics, resolveDataDir, resolvePaper, resolveUploadTopic, validateEntryName, } from "./library.js";
import { ManageError, assertInside, isManageError, realDataDir, renamePaper, renameTopic, validateName, validateNewPaperName, } from "./library-manage.js";
import { readFormulaIndex, readTextBlockIndex } from "./formulas.js";
import { MAX_CHUNKS, MAX_LATEX_CHARS, MAX_TEXT_CHARS, MAX_TOTAL_CHARS, SelectionTranslateError, assembleSource, formulaStatusOf, translateSelection, } from "./translate-selection.js";
import { MineruError, sanitizeDetail } from "./mineru.js";
import { readTranscript, transcribePaper, ScannedPdfError, ShortTextError } from "./transcribe.js";
import { pdfVariantPath, runQueuedTranslation, zhStatus } from "./translate.js";
import { TranslationQueue } from './translation-queue.js';
import { pdfAnnotations } from './pdf-annotations.js';
import { readInk, writeInk } from './ink-store.js';
import { translationHealth, detectPaperLanguage, sourceFingerprint, preserveTranslationHealth } from './paper-health.js';
import { LibraryAutomation } from './library-automation.js';
import { clearTranslateConfig, maskApiKey, readTranslateConfig, resolveTranslateEndpoint, testTranslateEndpoint, writeTranslateConfig, } from "./translate-config.js";
import { clearTypesafeConfig, readTypesafeConfig, resolveTypesafeConfig, testTypesafeEndpoint, writeTypesafeConfig, } from "./typesafe-config.js";
import { clearEmbedConfig, maskApiKey as maskEmbedApiKey, readEmbedConfig, resolveEmbedConfig, testEmbedEndpoint, writeEmbedConfig, } from "./embed-config.js";
import { clearMineruConfig, mergeMineruBody, precheckMineruConfig, resolveMineruConfig, testMineruCloud, testMineruLocal, writeMineruConfig, } from "./mineru-config.js";
import { noteOrigin } from "./origin.js";
import { getPaperRuntime } from './library-runtime.js';
import { bindPaperSessions, listBoundPaperSessions, newPaperSessionId, parsePaperSessionId } from './session-bindings.js';
import { CatalogError, claimKey, foldName, validateSegment } from './collection-paths.js';
import { applyPaperCandidate } from './paper-metadata.js';
function json(res, status, body) {
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
    res.end(buf);
}
/**
 * 错误文案判别：带 `.code` 的 Node errno 系统错误 → 固定中文文案（不回显原始错误，
 * 避免把 dataDir/目标绝对路径带进响应体）；不带 `.code` 的是我们自己抛的中文业务 Error
 * （专题不存在/已存在同名/名字不能包含… 等）→ 保留 `e.message`，用户仍能定位问题。
 */
function readableError(err) {
    const code = err?.code;
    if (typeof code === 'string' && code)
        return '系统错误，请稍后重试';
    return err instanceof Error ? err.message : String(err);
}
async function readBody(req, maxBytes = Infinity) {
    const chunks = [];
    let bytes = 0;
    for await (const c of req) {
        bytes += c.length;
        if (bytes > maxBytes) throw new ManageError('body-too-large', 413, '请求内容过大');
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw)
        return {};
    // 畸形 JSON / 整包 null / 非对象 → {}：路由据此给**可读 400**（原来是 JSON.parse 抛错 →
    // 外层兜底 500 internal，错误分类错误）。PR-1 的错误分类收口，rebase 时一并带入。
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {};
    }
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
}
/** header 元数据解码：客户端 encodeURIComponent 过（HTTP header 值不允许非 Latin-1，如中文文件名）；非字符串/未编码原样返回。 */
function decodeHdr(v) {
    if (typeof v !== 'string')
        return v;
    try {
        return decodeURIComponent(v);
    }
    catch {
        return v;
    }
}
export function registerRoutes(ctx, config, adapters = {}) {
    const ws = ctx.webServer;
    const connection = ctx.connection;
    const sessionController = ctx.sessionController;
    const workspaceController = ctx.workspaceController;
    const workspaceRegistry = ctx.workspaceRegistry;
    const dataDir = resolveDataDir(config.dataDir);
    const runtime = adapters.runtime || getPaperRuntime(dataDir, config);
    const publicEntity = ref => Object.fromEntries(['paperId', 'collectionId', 'parentId', 'name', 'segments', 'topic', 'revision', 'locationRevision', 'status', 'origin', 'ingestSeq', 'note'].filter(key => ref[key] !== undefined).map(key => [key, ref[key]]));
    runtime.setSessionInspector(async (paperIds, context = {}) => {
        const all = await sessionController.list({}, AbortSignal.timeout(15000));
        const migration = context.recovering === true ? { needsReview: [] } : await bindPaperSessions(runtime.catalog, all.items), snapshot = runtime.catalog.snapshot(), unresolved = new Set(migration.needsReview);
        for (const row of all.items) {
            if (!row.running) continue;
            let owners = snapshot.sessionBindings[row.sessionId] ? [snapshot.sessionBindings[row.sessionId]] : [];
            if (!owners.length && (context.recovering === true || unresolved.has(row.sessionId))) {
                const parsed = parsePaperSessionId(row.sessionId);
                if (parsed?.paperId && snapshot.papers[parsed.paperId]?.status === 'active') owners = [parsed.paperId];
                else if (parsed?.topic) owners = snapshot.claims[claimKey(parsed.topic.split('/'), parsed.name)] || [];
            }
            if (owners.some(id => paperIds.includes(id))) throw new ManageError('session-running', 409, '请等待关联文献会话结束后再修改文件位置');
        }
    });
    const sessionsReady = runtime.ready.then(async () => {
        const all = await sessionController.list({}, AbortSignal.timeout(15000));
        return bindPaperSessions(runtime.catalog, all.items);
    });
    sessionsReady.catch(() => {});
    // A Desktop transport may omit Origin. The authenticated details HTML carries an
    // instance-local non-simple-header capability; explicit cross-origin requests still fail.
    let uiCsrf = randomUUID();
    const hasUiCapability = req => Boolean(uiCsrf && req.headers['x-dpr-ui-csrf'] === uiCsrf
        && req.headers['sec-fetch-site'] !== 'cross-site');
    const uiConfirmation = (req, body) => {
        const expected = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
        const origin = req.headers.origin;
        const sourceAllowed = origin === expected || (!origin || origin === 'null') && hasUiCapability(req);
        if (!sourceAllowed || req.headers['sec-fetch-site'] === 'cross-site'
            || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || body.confirmCosts !== true)
            throw new ManageError('authorization-required', 403, '页面授权已失效，请关闭并重新打开当前操作页');
    };
    // dist/host.js → 包根/reader/index.html
    const readerHtml = new URL('../reader/index.html', import.meta.url);
    const readerVendorDir = new URL('../reader/vendor/', import.meta.url);
    // 插件版本（读包根 package.json，注入阅读器顶栏——用户截图反馈时一眼可见）
    const pluginVersion = 'v' + JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    const locate = (url) => {
        const path = url.searchParams.get('path') ?? undefined;
        const topic = url.searchParams.get('topic') ?? undefined;
        const name = url.searchParams.get('name') ?? undefined;
        const args = {};
        for (const key of ['paperId', 'collectionId', 'sessionId']) if (url.searchParams.has(key)) args[key] = url.searchParams.get(key);
        if (path)
            args.path = path;
        if (topic)
            args.topic = topic;
        if (name)
            args.name = name;
        try {
            return resolvePaper(dataDir, args);
        }
        catch (error) {
            if (error instanceof CatalogError) throw error;
            // 原先普通 Error 会冒泡成 500 且把「PDF 不存在: /abs/path」这类绝对路径写进响应体；
            // 这里统一成 404 + 只含名称的文案（读路径也一样，语义更准且不泄露服务端路径）。
            throw notFound(args.path ? '文献不存在（path 指向的文件不可用）' : `文献不存在：${args.topic ? `${args.topic}/` : ''}${args.name ?? ''}`);
        }
    };
    /** 每篇文献的伴读会话 id（确定性，重启/刷新后可续）；n 支持同文献多会话（会话1/2/…）。 */
    const sessionPrefixFor = (ref) => `dpr-v2-${ref.paperId}`;
    /** 扫描某文献的全部伴读会话（不过滤）：按 dsh 会话列表过滤 id 前缀；兼容 v1 无后缀旧会话=会话1。
     *  n 的分配必须基于这份全量扫描（含归档/空白）——用过滤后的列表算 maxN 会跟
     *  磁盘上已存在（可能还被别的进程 flock 着）的会话目录撞号，create 直接失败（实测）。 */
    const scanPaperSessions = async (ref) => {
        await sessionsReady;
        const all = await sessionController.list({}, AbortSignal.timeout(15_000));
        await bindPaperSessions(runtime.catalog, all.items);
        return listBoundPaperSessions(runtime.catalog, all.items, ref.paperId);
    };
    /** 列表视图：过滤归档集；空白会话（从未提问）只保留最新一个——更早的空会话是被遗弃的
     *  「新建对话」，顺手真归档（官方语义：日志保留、所有列表隐藏），不只是从树上消失。 */
    const listPaperSessions = async (ref) => {
        const archived = new Set(workspaceRegistry?.archivedSessionIds ?? []);
        const sorted = await scanPaperSessions(ref);
        const visible = sorted.filter((s) => !archived.has(s.sessionId));
        const newestBlank = [...visible].reverse().find((s) => s.blank);
        // 非最新的空白会话 = 被遗弃的草稿：后台归档（幂等；最新空白是活跃草稿，留给复用/显式归档）
        for (const s of visible) {
            if (s.blank && s !== newestBlank && !s.running) {
                workspaceRegistry?.archiveSession(s.sessionId).catch(() => { });
            }
        }
        return visible.filter((s) => !s.blank || s === newestBlank);
    };
    /** n → 实际 sessionId：旧格式存在时优先（历史不丢），否则新格式。全量扫描（含归档）。 */
    const sessionIdFor = async (ref, n, requestedSessionId) => {
        const sessions = await scanPaperSessions(ref);
        if (requestedSessionId !== undefined) {
            if (typeof requestedSessionId !== 'string' || runtime.catalog.snapshot().sessionBindings[requestedSessionId] !== ref.paperId || !sessions.some(s => s.sessionId === requestedSessionId)) throw new ManageError('session-mismatch', 409, '请选择当前文献绑定的会话');
            return requestedSessionId;
        }
        const hit = sessions.find((s) => s.n === n);
        return hit?.sessionId ?? newPaperSessionId(ref.paperId, n);
    };
    /** 专题目录 → dsh 工作区（幂等，进程内缓存）。会话挂到工作区后原生 composer 才可用。 */
    const workspaceCache = new Map();
    const ensureTopicWorkspace = async (topic) => {
        const dir = join(dataDir, topic);
        const cached = workspaceCache.get(dir);
        if (cached)
            return cached;
        try {
            const { workspace } = await workspaceController.create({ path: dir });
            workspaceCache.set(dir, workspace.workspaceId);
            return workspace.workspaceId;
        }
        catch (err) {
            console.warn('[dsh-paper-reader] workspace 注册失败(回退 cwd 模式):', readableError(err));
            return undefined;
        }
    };
    /** 创建/复用会话：论文伴读 preset 只注册到 dsh；论文入口不默认套用，避免替用户改变 agent。 */
    const createPaperSession = async (sessionId, topic) => {
        const workspaceId = await ensureTopicWorkspace(topic);
        let created = false, result;
        if (workspaceId) {
            try { result = await sessionController.create({ sessionId, workspaceId }); created = true; }
            catch { /* Existing sessions are verified through exact bindings by the caller. */ }
        }
        if (!created) result = await sessionController.create({ sessionId, cwd: join(dataDir, topic) });
        await bindPaperSessions(runtime.catalog, [{ sessionId }]);
        return result;
    };
    /* ── 破坏性操作（删除/重命名）的共用出口 ──────────────────────────────────
       契约：docs/reader-ux-requirements.md §2。错误文案一律不含服务端绝对路径；
       结构性字段（trashDir/trashRel）只在必须给用户恢复线索时出现（见 O4 说明）。 */
    const manageFail = (res, err) => {
        if (!isManageError(err))
            return false;
        json(res, err.status, { error: err.message, code: err.code, ...err.extra });
        return true;
    };
    /**
     * 某文献的伴读会话统计。**查不到就标 unknown**（不再吞成「0 个会话」）：
     * R4-F3 指出 fail-open 会削弱 S7「有运行中会话就拒绝」——会话服务不可用时无法证明「没有运行中会话」，
     * 破坏性操作据 unknown 走 fail-closed（见 requireSessionClear）。读路径不受影响（只有破坏性路由用它）。
     */
    /** 对外形状固定为 `{total, running}`（既有断言 deepEqual 它）；`unknown` 只在服务端内部用。 */
    const toWire = (i) => ({ total: i.total, running: i.running });
    const sessionInfo = async (ref) => {
        if (typeof sessionController?.list !== 'function')
            return { total: 0, running: 0, unknown: true };
        try {
            const s = await scanPaperSessions(ref);
            return { total: s.length, running: s.filter((x) => x.running).length, unknown: false };
        }
        catch {
            return { total: 0, running: 0, unknown: true };
        }
    };
    /**
     * 破坏性操作的会话准入（**fail-closed**）：查不到会话状态就**拒绝**，不冒险动手。
     * 取向理由：删除会把产物搬进回收站、重命名会改会话工作区下的文件名；若此时真有会话在跑，
     * 破坏的是用户当前正在用的工作目录。代价是「会话服务抖动时可能白拒一次」，用户重试即可——
     * 可恢复性远好于误删。unknown 用 503 + code=session-unknown，running 用 409 + code=session-running。
     */
    const requireSessionClear = async (ref, res) => {
        const info = await sessionInfo(ref);
        if (info.unknown) {
            json(res, 503, { error: '暂时无法确认该文献的伴读会话状态，为避免误删已取消本次操作；请稍后重试', code: 'session-unknown' });
            return false;
        }
        if (info.running > 0) {
            json(res, 409, { error: `该文献有 ${info.running} 个正在运行的伴读会话，请先结束后再操作`, code: 'session-running', sessions: toWire(info) });
            return false;
        }
        return true;
    };
    /**
     * 契约 R5「并发互斥」的最小在途守卫（R4-F2）：
     * 同一篇文献的删除/重命名在途时，第二个请求直接 409 `busy`（而不是让两个请求交错改同一批文件：
     * 实测后果是第二个请求拿到 404/500 的中间态）。进程内 Set 足够——本插件是单进程 ws 路由。
     * 机器码取 `busy` 而非契约 §5 R5 字面的 `in-progress`：两者语义完全一致（「有操作在途」），
     * `busy` 更短且与既有 `translation-busy`/`session-running` 的短词风格一致；前端 errText 已按 `busy` 对齐。
     */
    const inflight = new Set();
    const withInflight = async (key, res, fn) => {
        if (inflight.has(key)) {
            json(res, 409, { error: '同一篇文献的另一个删除/重命名操作正在进行，请稍后重试', code: 'busy' });
            return;
        }
        inflight.add(key);
        try {
            await fn();
        }
        finally {
            inflight.delete(key);
        }
    };
    /** 「文献不存在」的统一出口：404 + 不含服务端绝对路径的文案（原先普通 Error 会冒泡成 500 并带路径）。 */
    const notFound = (what) => new ManageError('not-found', 404, what);
    /**
     * **写路径**的文献定位（t3-O2：/api/transcribe 曾接受任意 `path` 并据此写盘）。
     * 规则与删除同级：只认 topic+name；给了 `path` 时其 **realpath 必须落在 dataDir 内**
     * （符号链接指向库外同样拒绝）。校验逻辑全部复用 library-manage 的既有实现，不另写一套。
     */
    const locateForWrite = (body, isUrlSearch = false) => {
        void isUrlSearch;
        if (body.paperId !== undefined || body.sessionId !== undefined || body.collectionId !== undefined && body.name !== undefined) return resolvePaper(dataDir, body);
        if (body.path) {
            const abs = resolve(String(body.path));
            let real;
            try {
                real = realpathSync(abs);
            }
            catch {
                throw notFound('文献不存在（path 指向的文件不可读）');
            }
            assertInside(realDataDir(dataDir), real); // 越界/符号链接逃逸 → 400 escape-rejected
            return resolvePaper(dataDir, { path: abs });
        }
        // exactOptionalPropertyTypes: true —— 不能把 undefined 直接挂到可选属性上
        const args = {};
        for (const key of ['paperId', 'collectionId', 'sessionId']) if (body[key] !== undefined) args[key] = body[key];
        if (body.topic !== undefined)
            args.topic = body.topic;
        if (body.name !== undefined)
            args.name = body.name;
        return resolvePaper(dataDir, args);
    };
    /**
     * 外层兜底文案脱敏：把任何**绝对路径**替换成 `<path>`。
     * 说明：这里没有采用「一律不回显 err.message」的极端做法——那会把 MinerU/转录等**可读的领域错误**
     * 一起变成不可读（既有测试明确断言这些文案要含 `MinerU` 等关键词，不许放宽）。改为：领域错误保留可读文案、
     * 但**先剥掉绝对路径**；未知内部错误则只给通用文案。两种情况都带机器可读 `code:'internal'`。
     */
    const stripAbsPaths = (msg) => msg.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"“”（）()]+)+/g, '<path>');
    /** 破坏性路由的统一前置检查：拒绝 path 参数（写路径只认 topic+name）。 */
    const rejectWritePath = (body, res) => {
        if (body.path === undefined || body.path === null || body.path === '')
            return false;
        json(res, 400, { error: '删除/重命名不接受 path 参数，请用 topic + name', code: 'escape-rejected' });
        return true;
    };
    // New persistent writes only accept exact library references and real, in-library files.
    const safeLibraryRef = (body) => {
        if (body.path) throw new ManageError('bad-reference', 400, '请选择文献库内的文献');
        const ref = resolvePaper(dataDir, body);
        assertInside(realDataDir(dataDir), realpathSync(ref.pdfPath));
        if (lstatSync(ref.pdfPath).isSymbolicLink()) throw new ManageError('symlink', 400, '批注和队列不接受符号链接 PDF');
        return ref;
    };
    let queue = null;
    let queueError = false;
    try {
        queue = new TranslationQueue(join(dataDir, '.dpr-translation-queue.json'), async (item, signal) => runtime.withPaperTask(safeLibraryRef(item).paperId, async ref => {
            const health = await translationHealth(ref, item.automatic ? { expectedSourceSignature: item.sourceSignature } : {});
            if (!item.force && health.state === 'translated') return { status: 'skipped', verified: true };
            if (!item.force && health.state !== 'missing') throw new Error('已有译本需要人工核对，未自动覆盖');
            // Bind automatic cost authority to the exact stable bytes, including after queue recovery.
            const sourceMatches = async () => typeof item.sourceSignature === 'string' && await sourceFingerprint(ref) === item.sourceSignature;
            if (item.automatic && (!(await sourceMatches()) || await detectPaperLanguage(ref) !== 'english')) throw new Error('自动任务原文语言或状态已变化，请人工确认');
            const { endpoint } = await resolveTranslateEndpoint(config.translate);
            signal.throwIfAborted();
            if (item.automatic && !(await sourceMatches())) throw new Error('自动任务原文已变化，请人工确认');
            const result = await runQueuedTranslation(item.automatic ? { ...ref, sourceSignature: item.sourceSignature } : ref, dataDir, endpoint, signal, item.force);
            signal.throwIfAborted();
            const verified = await translationHealth(ref, item.automatic ? { expectedSourceSignature: item.sourceSignature } : {});
            if (verified.state !== 'translated') throw new Error('译本完整性或原文版本未确认，请核对文件');
            return { status: result, verified: true };
        }));
    } catch {
        queueError = true;
        console.error('[dsh-paper-reader] queue unavailable: invalid persisted state retained');
    }
    const requireQueue = () => {
        if (!queue || queueError) throw new ManageError('queue-unavailable', 503, '翻译队列不可用，原队列文件已保留，请检查后再试');
        return queue;
    };
    const safePaperList = () => {
        const refs = [];
        for (const paper of runtime.catalog.listPapers()) {
            try { refs.push(safeLibraryRef({ paperId: paper.paperId })); } catch { /* Retain unavailable identities for explicit review. */ }
        }
        return refs;
    };
    const enqueueChecked = async (refs, manual = false, { authorize = () => false } = {}) => {
        const q = requireQueue(), eligible = [], skipped = [];
        for (const value of refs) {
            const ref = safeLibraryRef(value);
            const health = await translationHealth(ref);
            if (!manual && (!authorize() || !/^[a-f0-9]{64}$/.test(value.sourceSignature || '')
                || await sourceFingerprint(ref) !== value.sourceSignature || !authorize())) {
                skipped.push({ paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name, sourceSignature: value.sourceSignature, reason: 'source-or-authorization-changed' }); continue;
            }
            const active = q.snapshot().items.some(i => (i.paperId ? i.paperId === ref.paperId : i.topic === ref.topic && i.name === ref.name) && ['queued', 'running'].includes(i.status));
            if (health.state === 'translated' || active) {
                skipped.push({ paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name, sourceSignature: value.sourceSignature, reason: health.state === 'translated' ? 'translated' : 'active' });
            } else if (health.state !== 'missing') {
                if (manual) throw new ManageError('translation-review', 409, '已有译本损坏或状态未确认，请先核对，不会自动覆盖');
                skipped.push({ paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name, sourceSignature: value.sourceSignature, reason: '译本状态需要人工核对' });
            } else eligible.push({ paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name, ...(!manual ? { sourceSignature: value.sourceSignature } : {}) });
        }
        // No await between the last authorization decision and synchronous queue admission.
        if (!manual && !authorize()) return { enqueued: [], skipped: refs.map(({ paperId, collectionId, topic, name, sourceSignature }) => ({ paperId, collectionId, topic, name, sourceSignature, reason: 'authorization-revoked' })) };
        const added = eligible.length ? new Set(q.enqueue(eligible, { automatic: !manual }).added) : new Set();
        const enqueued = q.snapshot().items.filter(i => added.has(i.id)).map(({ paperId, collectionId, topic, name, sourceSignature }) => ({ paperId, collectionId, topic, name, sourceSignature }));
        // q.enqueue is synchronous; any concurrent scanner deduplication remains server-owned.
        return { enqueued, skipped };
    };
    const automation = new LibraryAutomation({ dataDir, list: safePaperList, inspect: translationHealth,
        catalog: runtime.catalog, discovery: {
            scan: async () => { await runtime.ready; return runtime.discovery.scan(); },
            getEligibility: args => runtime.discovery?.getEligibility(args) ?? null,
            withPolicyFence: async fn => { await runtime.ready; return runtime.discovery.withPolicyFence(fn); },
        }, language: detectPaperLanguage, enqueue: (refs, authority) => enqueueChecked(refs, false, authority) });
    runtime.setTranslationRulesProvider(() => automation.getRules());
    runtime.setTranslationGlobalProvider(() => automation.getGlobalRule());
    let automationError = false, disposed = false;
    const automationReady = runtime.ready.then(() => automation.initialize()).catch(() => { automationError = true; });
    const requireAutomation = async () => {
        await automationReady;
        if (automationError) throw new ManageError('automation-unavailable', 503, '自动翻译配置不可用，原文件已保留；请检查后再试');
        return automation;
    };
    const disableCollectionAutomation = async collectionId => {
        await automationReady;
        if (!automationError) await automation.setCollection(collectionId, false);
    };
    // Deletion previews are adapters over the same immutable service plan as apply.
    // sourceFiles is machine-readable; affectedFiles is presentation text (names may contain →).
    const deleteTarget = (input, mode) => {
        if (Object.hasOwn(input, 'path')) throw new ManageError('escape-rejected', 400, '删除只接受库内稳定身份或旧名称定位');
        if (Object.hasOwn(input, 'planId')) throw new ManageError('bad-request', 400, '旧名称入口不接受 planId，请使用统一计划提交入口');
        if (mode === 'paper') return safeLibraryRef(input);
        if (input.paperId !== undefined) throw new ManageError('bad-reference', 400, '请选择库身份');
        return runtime.catalog.resolveCollection(input.collectionId !== undefined ? { collectionId: input.collectionId } : { topic: input.topic ?? input.name });
    };
    const sourceFileStats = async (plan) => {
        const root = realDataDir(dataDir), files = [];
        for (const name of plan.sourceFiles) {
            const parts = typeof name === 'string' ? name.split('/') : [];
            if (!parts.length || name.includes('\\') || /^[A-Za-z]:/.test(name) || parts.some(p => !p || p === '.' || p === '..' || p.includes('\u0000'))) throw new ManageError('needs-review', 409, '删除源清单需重新核对');
            let path = root, info;
            try {
                for (let i = 0; i < parts.length; i++) {
                    path = join(path, parts[i]); info = await lstat(path);
                    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new Error('changed source kind');
                }
                assertInside(root, realpathSync(path));
            } catch { throw new ManageError('stale-plan', 409, '预览源文件已变化，请重新预览'); }
            if (!Number.isSafeInteger(info.size) || info.size < 0) throw new ManageError('needs-review', 409, '文件大小需人工核对');
            files.push({ name, bytes: info.size });
        }
        const total = files.reduce((n, file) => n + file.bytes, 0);
        if (!Number.isSafeInteger(total) || total !== plan.totalBytes) throw new ManageError('stale-plan', 409, '文件大小已变化，请重新预览');
        return files;
    };
    const deletePreview = async (target, mode) => {
        let rows;
        try {
            await sessionsReady;
            rows = (await sessionController.list({}, AbortSignal.timeout(15000))).items;
            await bindPaperSessions(runtime.catalog, rows);
        } catch (error) {
            if (error instanceof CatalogError || isManageError(error)) throw error;
            throw new ManageError('session-unknown', 503, '暂时无法确认伴读会话状态，请稍后重试');
        }
        const plan = await runtime.service.planDelete({ [mode === 'paper' ? 'paperId' : 'collectionId']: mode === 'paper' ? target.paperId : target.collectionId, mode });
        if (plan.conflicts.length) {
            const extra = { conflicts: plan.conflicts };
            if (mode === 'empty-collection') Object.assign(extra, { entries: (await readdir(target.dirPath)).filter(name => !name.startsWith('.')), papers: plan.paperIds.map(paperId => ({ paperId, name: runtime.catalog.resolvePaper({ paperId }).name })), clearEndpoint: '/api/library/topic/clear', clearPlanEndpoint: '/api/library/topic/clear-plan' });
            throw new ManageError(mode === 'empty-collection' ? 'topic-not-empty' : 'conflict', 409, plan.conflicts.join('；'), extra);
        }
        const files = await sourceFileStats(plan), papers = [];
        for (const paperId of plan.paperIds) {
            const ref = runtime.catalog.resolvePaper({ paperId });
            const owned = mode === 'paper' ? plan : await runtime.service.planDelete({ paperId, mode: 'paper' });
            const names = new Set(owned.sourceFiles), paperFiles = files.filter(file => names.has(file.name));
            const sessions = listBoundPaperSessions(runtime.catalog, rows, paperId), zh = zhStatus(ref);
            papers.push({ paperId, collectionId: ref.collectionId, name: ref.name, files: paperFiles, totalBytes: paperFiles.reduce((n, file) => n + file.bytes, 0), sessions: { total: sessions.length, running: sessions.filter(row => row.running).length }, translation: { busy: zh.busy, hasZh: zh.zh, hasDual: zh.dual } });
        }
        return { ...plan, [mode === 'paper' ? 'paperId' : 'collectionId']: plan.entityId, ...(mode === 'paper' ? { collectionId: target.collectionId, sessions: papers[0].sessions, translation: papers[0].translation } : {}), topic: mode === 'paper' ? target.topic : target.segments.join('/'), name: target.name,
            files, filesCount: files.length, papers, papersCount: plan.paperCount, hidden: plan.hidden,
            notDeleted: ['伴读会话历史与稳定身份关联（保存在 dsh 会话库中）', '按稳定ID保存的摘要、备注及元数据', '库外原始来源文件'], ...(mode === 'clear-collection' ? { clearEndpoint: '/api/library/topic/clear' } : {}) };
    };
    const afterDelete = async (result) => {
        if (result.receipt?.status !== 'committed' || result.receipt.mode === 'paper') return result;
        const warnings = [];
        for (const collectionId of result.receipt.collectionIds) {
            const row = runtime.catalog.snapshot().collections[collectionId];
            if (!row) continue;
            // A receipt owns a UUID, not a reusable directory spelling. Check on replay AND
            // delayed first cleanup; no active owner still permits cleanup of the old v1 path.
            const ownsPath = () => !Object.entries(runtime.catalog.snapshot().collections).some(([id, current]) => id !== collectionId && current.status !== 'trashed' && current.segments.length === row.segments.length && current.segments.every((segment, i) => foldName(segment) === foldName(row.segments[i])));
            // CID policy cleanup remains safe even after another UUID reuses the old spelling.
            try { await disableCollectionAutomation(collectionId); }
            catch { warnings.push('automation-cleanup-needs-review'); }
            if (!ownsPath()) continue;
            workspaceCache.delete(join(dataDir, ...row.segments));
        }
        // The service receipt remains intact, including idempotency and postCommit state.
        return warnings.length ? { ...result, cleanupWarnings: warnings } : result;
    };
    const legacyDelete = async (body, mode) => {
        const target = deleteTarget(body, mode);
        if (mode !== 'paper') {
            const canonical = { collectionId: target.collectionId, name: target.name, topic: target.segments.join('/') };
            const currentName = value => typeof value === 'string' && (value === canonical.name || value === canonical.topic);
            const staleHint = Object.hasOwn(body, 'topic') && body.topic !== canonical.topic || Object.hasOwn(body, 'name') && !currentName(body.name);
            if (staleHint || (mode === 'clear-collection' || body.confirmName !== undefined) && !currentName(body.confirmName)) throw new ManageError('confirm-mismatch', 400, '请刷新预览后按当前库名称确认：' + canonical.topic, { canonical });
        }
        const plan = await deletePreview(target, mode);
        if (mode === 'clear-collection' && plan.papersCount === 0) throw new ManageError('bad-request', 400, '专题已为空，请使用删除空库', { clearEndpoint: '/api/library/delete-topic' });
        const result = await afterDelete(await runtime.service.applyDelete({ planId: plan.planId, operationId: body.operationId || randomUUID() }));
        return { ...result, ok: true, topic: plan.topic, name: plan.name, moved: result.files, deleted: result.files, movedFiles: result.receipt.movedFiles, movedHidden: result.receipt.movedHidden, cleared: result.receipt.cleared,
            ...(mode === 'paper' ? { sessions: plan.sessions } : { detachedSessions: plan.papers.reduce((n, paper) => n + paper.sessions.total, 0), archivedSessionsNote: true }) };
    };
    const queueStatus = async () => {
        const q = requireQueue(), finished = [];
        for (const item of q.snapshot().items) {
            if (!['done', 'skipped'].includes(item.status)) continue;
            try { if ((await translationHealth(safeLibraryRef(item), item.automatic ? { expectedSourceSignature: item.sourceSignature } : {})).state === 'translated') finished.push(item.id); } catch { /* Retain unverified historical records. */ }
        }
        q.removeVerifiedFinished(finished);
        const snapshot = q.snapshot();
        for (const item of snapshot.items) {
            if (item.status !== 'running') continue;
            try { Object.assign(item, zhStatus(safeLibraryRef(item))); } catch { /* Failed references are handled by execution. */ }
        }
        return snapshot;
    };
    const dispatch = async (req, res, url) => {
        const sub = url.pathname.slice('/paper-reader'.length); // '' | '/' | '/api/...'
        if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`
            && !(req.headers.origin === 'null' && hasUiCapability(req))) throw new ManageError('origin', 403, '请从当前工作台执行操作');
        if (sub.startsWith('/api/')) await runtime.ready;
        if (['/paper-details.html', '/reader-sync.js'].includes(sub) && req.method === 'GET') {
            let body = await readFile(new URL('../reader' + sub, import.meta.url));
            if (sub === '/paper-details.html') {
                const html = body.toString('utf8');
                body = Buffer.from(html.includes('__DPR_UI_CSRF__') ? html.replace('__DPR_UI_CSRF__', uiCsrf || '')
                    : html.replace('</head>', `<meta name="dpr-ui-csrf" content="${uiCsrf || ''}"></head>`), 'utf8');
            }
            res.writeHead(200, { 'content-type': sub.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' }); res.end(body); return;
        }
        if (sub === '/api/library/tree' && req.method === 'GET') { json(res, 200, await runtime.service.listTree()); return; }
        if (sub === '/api/library/manage' && req.method === 'POST') {
            const body = await readBody(req, 256 * 1024); let result;
            switch (body.action) {
                case 'list': result = await runtime.service.listTree(); break;
                case 'create_collection': result = await runtime.service.createCollection(body, 'manual'); break;
                case 'update_collection':
                    if (body.planId !== undefined) {
                        if (typeof body.collectionId !== 'string') throw new ManageError('bad-reference', 400, '请选择要改名的文献库');
                        await sessionsReady;
                        result = await runtime.service.applyRename({ collectionId: body.collectionId, planId: body.planId, operationId: body.operationId });
                    } else result = await runtime.service.updateCollection(body, 'manual');
                    break;
                case 'import_pdfs': result = await runtime.service.importPdfs(body, 'manual'); break;
                case 'get_paper': { const value = await runtime.service.getDetails(body); result = { ...value, entity: publicEntity(value.entity) }; break; }
                case 'update_paper': result = await runtime.service.updateDetails(body, 'manual'); break;
                case 'plan_enrichment': result = { plan: await runtime.enrichment.plan(body) }; break;
                case 'run_enrichment': uiConfirmation(req, body); result = { job: await runtime.enrichment.run(body, runtime.createUiAuthorization('run', body)) }; break;
                case 'set_automation': {
                    const current = await runtime.enrichment.getAutomation();
                    if (body.autoSummary === true && !current.autoSummary || body.autoName === true && !current.autoName) uiConfirmation(req, body);
                    result = { automation: await runtime.enrichment.setAutomation(body, runtime.createUiAuthorization('set-automation', body)) }; break;
                }
                case 'job_status': result = { jobs: await runtime.enrichment.jobs(body.paperId === undefined ? {} : { paperId: body.paperId }) }; break;
                default: throw new ManageError('action', 400, '文献管理操作无效');
            }
            json(res, 200, { action: body.action, result }); return;
        }
        if (sub === '/api/library/collections' && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024);
            json(res, 200, await runtime.service.createCollection({ ...(body.parentId === undefined ? {} : { parentId: body.parentId }), name: body.name, ...(body.note === undefined ? {} : { note: body.note }), operationId: body.operationId }, 'manual')); return;
        }
        if (sub === '/api/library/details' && ['GET', 'POST'].includes(req.method)) {
            const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req, 256 * 1024);
            if (req.method === 'POST') { json(res, 200, await runtime.service.updateDetails(body, 'manual')); return; }
            const result = await runtime.service.getDetails(body);
            json(res, 200, { ...result, entity: publicEntity(result.entity), endpoint: await runtime.endpointInfo(), automation: await runtime.enrichment.getAutomation(), jobs: result.kind === 'paper' ? await runtime.enrichment.jobs({ paperId: result.entity.paperId }) : [] }); return;
        }
        if (sub === '/api/library/details/apply-candidate' && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024);
            const metadata = await runtime.withPaperWrite(body.paperId, () => applyPaperCandidate(dataDir, body.paperId, { revision: body.revision, operationId: body.operationId }));
            json(res, 200, { metadata }); return;
        }
        if (sub === '/api/library/changes/plan' && req.method === 'POST') {
            await sessionsReady;
            json(res, 200, { plan: await runtime.service.planRename(await readBody(req, 128 * 1024)) }); return;
        }
        if (sub === '/api/library/changes/delete' && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024);
            if (url.searchParams.size || Object.keys(body).length !== 2 || !['planId', 'operationId'].every(key => Object.hasOwn(body, key) && typeof body[key] === 'string' && body[key].length > 0)) throw new ManageError('bad-request', 400, '统一删除入口只接受 planId 与 operationId');
            await sessionsReady;
            json(res, 200, await afterDelete(await runtime.service.applyDelete(body))); return;
        }
        if (sub === '/api/library/changes/apply' && req.method === 'POST') {
            await sessionsReady;
            json(res, 200, await runtime.service.applyRename(await readBody(req, 128 * 1024))); return;
        }
        if (sub === '/api/enrichment/plan' && req.method === 'POST') {
            json(res, 200, { plan: await runtime.enrichment.plan(await readBody(req, 128 * 1024)) }); return;
        }
        if (sub === '/api/enrichment/run' && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024); uiConfirmation(req, body);
            json(res, 200, { job: await runtime.enrichment.run(body, runtime.createUiAuthorization('run', body)) }); return;
        }
        if (sub === '/api/enrichment/retry' && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024); uiConfirmation(req, body);
            json(res, 200, { job: await runtime.enrichment.retry(body, runtime.createUiAuthorization('retry', body)) }); return;
        }
        if (sub === '/api/enrichment/jobs' && req.method === 'GET') {
            json(res, 200, { jobs: await runtime.enrichment.jobs(Object.fromEntries(url.searchParams)) }); return;
        }
        if (sub === '/api/enrichment/automation' && ['GET', 'POST'].includes(req.method)) {
            if (req.method === 'GET') { json(res, 200, { automation: await runtime.enrichment.getAutomation() }); return; }
            const body = await readBody(req, 128 * 1024), current = await runtime.enrichment.getAutomation();
            if (body.autoSummary === true && !current.autoSummary || body.autoName === true && !current.autoName) uiConfirmation(req, body);
            json(res, 200, { automation: await runtime.enrichment.setAutomation(body, runtime.createUiAuthorization('set-automation', body)) }); return;
        }
        if (sub.startsWith('/api/readers/') && req.method === 'POST') {
            const action = sub.slice('/api/readers/'.length), body = await readBody(req, 128 * 1024);
            if (!['register', 'heartbeat', 'ack', 'unregister'].includes(action)) throw new ManageError('not-found', 404, '阅读器接口不存在');
            if (action === 'register') runtime.catalog.resolvePaper({ paperId: body.paperId });
            json(res, 200, runtime.gate[action](body)); return;
        }
        if ((sub === '' || sub === '/') && req.method === 'GET') {
            // no-cache：桌面端 webview 无法强刷（README 里浏览器 Cmd+Shift+R 的建议对桌面端
            // 无效），不带缓存头时升级插件后用户会一直看到缓存的旧阅读器页面（实测空白 bug
            // 「修了还在」正是这个）。版本号注入供用户截图反馈时一眼对版本。
            const dock = url.searchParams.get('dock') === '1';
            let html = (await readFile(readerHtml)).toString('utf8').replaceAll('__DPR_VERSION__', pluginVersion);
            if (dock) html = html.includes('__DPR_UI_CSRF__') ? html.replace('__DPR_UI_CSRF__', uiCsrf || '')
                : html.replace('</head>', `<meta name="dpr-ui-csrf" content="${uiCsrf || ''}"></head>`);
            else html = html.replace('__DPR_UI_CSRF__', '');
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': Buffer.byteLength(html),
                'cache-control': dock ? 'no-store' : 'no-cache',
                'referrer-policy': 'same-origin',
            });
            res.end(html);
            return;
        }
        // 阅读器静态资源（本地 vendor 的 pdf.js 等；拒绝路径穿越）
        if (sub.startsWith('/vendor/') && req.method === 'GET') {
            const name = sub.slice('/vendor/'.length);
            if (!/^[\w.-]+$/.test(name)) {
                json(res, 400, { error: 'bad asset name' });
                return;
            }
            const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
                // 字体（vendored KaTeX 的 woff2 就靠这条；不给对 MIME 时某些浏览器会拒绝 @font-face）
                '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
            try {
                const body = await readFile(new URL(name, readerVendorDir));
                const ext = name.slice(name.lastIndexOf('.'));
                const type = mime[ext] ?? 'application/octet-stream';
                // 只有文本类才追加 charset：给 font/woff2 这类二进制资源加 `; charset=utf-8` 是错的
                // （实测 font/woff2 被浏览器按未知类型处理的风险；见 test/reader-vendor-http.test.mjs）
                const texty = type.startsWith('text/') || type === 'application/json';
                res.writeHead(200, { 'content-type': texty ? type + '; charset=utf-8' : type, 'content-length': body.length, 'cache-control': 'no-cache' });
                res.end(body);
            }
            catch {
                json(res, 404, { error: 'not found' });
            }
            return;
        }
        if (sub === '/api/library' && req.method === 'GET') {
            const papers = [];
            for (const ref of safePaperList()) {
                papers.push({ ...publicEntity(ref), translation: await translationHealth(ref) });
            }
            json(res, 200, { dataDir, topics: listTopics(dataDir), collections: runtime.catalog.listCollections().map(publicEntity), papers, capabilities: { safeImport: true, verifiedTranslationQueue: true } });
            return;
        }
        if (sub === '/api/automation' && ['GET', 'POST'].includes(req.method)) {
            const service = await requireAutomation();
            if (req.method === 'POST') {
                const body = await readBody(req, 32 * 1024);
                if (body.action !== undefined) {
                    if (body.action !== 'dismiss-legacy' || Object.keys(body).some(key => !['action', 'id'].includes(key))
                        || body.id !== undefined && (typeof body.id !== 'string' || !/^[a-f0-9]{64}$/.test(body.id)))
                        throw new ManageError('automation-input', 400, '请选择有效历史提示');
                    if (service.corrupt) throw new ManageError('automation-unavailable', 503, '自动翻译配置需要人工核对，原文件已保留');
                    try { await service.dismissLegacy(body.id === undefined ? {} : { id: body.id }); }
                    catch (error) { if (service.corrupt) throw new ManageError('automation-unavailable', 503, '历史提示未保存，请检查后再试'); throw new ManageError('automation-input', 400, '历史提示已变化，请刷新后再试'); }
                    json(res, 200, service.snapshot()); return;
                }
                const global = body.scope === 'global';
                if (body.path || typeof body.enabled !== 'boolean' || body.scope !== undefined && !global
                    || global && (body.collectionId !== undefined || body.topic !== undefined)
                    || !global && body.collectionId === undefined && typeof body.topic !== 'string') {
                    throw new ManageError('automation-input', 400, '请选择有效文献库和开关状态');
                }
                if (service.corrupt) throw new ManageError('automation-unavailable', 503, '自动翻译配置需要人工核对，原文件已保留');
                if (body.enabled) {
                    if (body.confirmCosts !== true) throw new ManageError('automation-confirm', 400, '开启自动翻译前请确认后续 API 费用');
                    uiConfirmation(req, body);
                }
                if (global) await service.setGlobal(body.enabled);
                else {
                    const collections = runtime.catalog.snapshot().collections;
                    const retired = !body.enabled && typeof body.collectionId === 'string' && Object.hasOwn(collections, body.collectionId) ? collections[body.collectionId] : null;
                    const collection = retired || runtime.catalog.resolveCollection(body.collectionId !== undefined ? { collectionId: body.collectionId } : { topic: body.topic });
                    await service.setCollection(collection.collectionId, body.enabled);
                }
            }
            json(res, 200, service.snapshot()); return;
        }
        if (sub === '/api/library/location' && req.method === 'POST') {
            const body = await readBody(req, 32 * 1024);
            if (body.path || !['path', 'open-folder', 'reveal'].includes(body.action)) throw new ManageError('location-input', 400, '请选择文献库内的专题或文献');
            const paper = body.paperId || body.name !== undefined ? safeLibraryRef(body) : null;
            const collection = paper ? null : runtime.catalog.resolveCollection({ collectionId: body.collectionId || runtime.catalog.listCollections().find(c => foldName(c.segments.join('/')) === foldName(String(body.topic || '')))?.collectionId });
            const dir = paper ? dirname(paper.pdfPath) : collection.dirPath;
            const target = paper ? paper.pdfPath : dir;
            if (body.action !== 'path') {
                const reveal = body.action === 'reveal' && paper !== null;
                const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
                const args = process.platform === 'win32' ? (reveal ? ['/select,', target] : [dir])
                    : process.platform === 'darwin' ? (reveal ? ['-R', target] : [dir]) : [dir];
                await new Promise((resolveOpen, reject) => {
                    const child = spawn(command, args, { shell: false, windowsHide: false, detached: true, stdio: 'ignore' });
                    child.once('error', () => reject(new ManageError('location-open', 503, '无法打开文件管理器，请复制路径后手动打开')));
                    child.once('spawn', () => { child.unref(); resolveOpen(); });
                });
            }
            json(res, 200, { ok: true, path: target }); return;
        }
        if (sub === '/api/library/workspaces' && req.method === 'GET') {
            const paths = [];
            for (const collection of runtime.catalog.listCollections()) {
                try { paths.push(runtime.catalog.resolveCollection({ collectionId: collection.collectionId }).dirPath); } catch { /* Keep unavailable identities in the catalog for review. */ }
            }
            json(res, 200, { paths });
            return;
        }
        if (sub === '/batch' && req.method === 'GET') {
            const html = (await readFile(new URL('../reader/batch.html', import.meta.url), 'utf8')).replace('__DPR_UI_CSRF__', uiCsrf || '');
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' });
            res.end(html); return;
        }
        if (sub === '/api/translation-queue' && req.method === 'GET') {
            json(res, 200, await queueStatus()); return;
        }
        if (sub === '/api/translation-queue' && req.method === 'POST') {
            const body = await readBody(req, 256 * 1024), q = requireQueue();
            try {
                if (body.action === 'enqueue') {
                    if (!Array.isArray(body.papers) || !body.papers.length || body.papers.length > 500) throw new Error();
                    const refs = body.papers.map(safeLibraryRef);
                    await enqueueChecked(refs, true);
                } else if (body.action === 'pause') q.pause();
                else if (body.action === 'resume') q.resume();
                else if (body.action === 'retry') {
                    const item = q.snapshot().items.find(i => i.id === body.id && i.status === 'failed');
                    if (!item) throw new Error();
                    const health = await translationHealth(safeLibraryRef(item));
                    if (!['missing', 'translated'].includes(health.state)) throw new ManageError('translation-review', 409, '已有译本需要核对，未自动覆盖');
                    q.retry(body.id);
                }
                else if (body.action === 'clear-finished') await queueStatus();
                else throw new Error();
            } catch (err) {
                if (isManageError(err)) throw err;
                throw new ManageError('queue-action', 400, '队列操作失败，请检查所选文献和任务状态');
            }
            json(res, 200, await queueStatus()); return;
        }
        if (sub === '/api/ink-license' && req.method === 'GET') {
            res.setHeader('cache-control', 'no-store');
            try {
                const row = JSON.parse(await readFile(new URL('../runtime/ink-license.json', import.meta.url), 'utf8'));
                const licenseKey = typeof row.licenseKey === 'string' && /^tldraw-[A-Za-z0-9_+/.=-]{30,8192}$/.test(row.licenseKey) ? row.licenseKey : '';
                json(res, 200, { licenseKey });
            } catch { json(res, 200, { licenseKey: '' }); }
            return;
        }
        /* DPR_INK_ROUTE_START */
        if (sub === '/api/ink' && ['GET', 'POST'].includes(req.method)) {
            if (req.method === 'POST' && req.headers?.origin) {
                const expectedOrigin = `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
                if (req.headers.origin !== expectedOrigin) throw new ManageError('origin', 403, '请从当前工作台页面保存墨迹');
            }
            const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req, 12 * 1024 * 1024);
            const variant = body.variant || 'orig';
            if (!['orig', 'zh', 'dual'].includes(variant)) throw new ManageError('variant', 400, 'PDF 版本无效');
            const ref = safeLibraryRef(body);
            if (req.method === 'POST' && zhStatus(ref).busy) throw new ManageError('busy', 409, '文献正在翻译，请完成后保存墨迹');
            const operation = async (ref) => {
                const pdfPath = pdfVariantPath(ref, variant === 'orig' ? null : variant);
                if (!existsSync(pdfPath)) throw new ManageError('not-found', 404, '当前 PDF 版本不存在');
                assertInside(realDataDir(dataDir), realpathSync(pdfPath));
                if (lstatSync(pdfPath).isSymbolicLink()) throw new ManageError('symlink', 400, '请使用文献库内的实际 PDF 文件');
                try {
                    const target = { ...ref, pdfPath };
                    const result = req.method === 'GET' ? await readInk(target) : await writeInk(target, { revision: body.revision, document: body.document });
                    json(res, 200, result);
                } catch (error) {
                    const code = ['invalid', 'conflict', 'io'].includes(error?.code) ? error.code : 'io';
                    const message = code === 'conflict' ? '墨迹已在其他窗口更新，请导出当前草稿后重新打开文献' : code === 'invalid' ? '墨迹数据校验失败，已保留原文件' : '墨迹保存或读取失败，已保留当前数据，请稍后重试';
                    json(res, code === 'conflict' ? 409 : code === 'invalid' ? 400 : 500, { error: message, code });
                }
            };
            if (req.method === 'GET') await runtime.withPaperWrite(ref.paperId, operation);
            else await runtime.withPaperWrite(ref.paperId, current => withInflight(`topic\u0000${current.topic}`, res, () => withInflight(current.paperId, res, () => operation(current))));
            return;
        }
        /* DPR_INK_ROUTE_END */
        if (sub === '/api/annotations' && ['GET', 'POST'].includes(req.method)) {
            const body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req, 2 * 1024 * 1024);
            const variant = body.variant || 'orig';
            if (!['orig', 'zh', 'dual'].includes(variant)) throw new ManageError('variant', 400, 'PDF 版本无效');
            const ref = safeLibraryRef(body);
            if (req.method === 'POST' && zhStatus(ref).busy) throw new ManageError('busy', 409, '文献正在翻译，请完成后保存批注');
            if (req.method === 'POST' && !['upsert', 'delete'].includes(body.action)) throw new ManageError('action', 400, '批注操作无效');
            const result = await runtime.withPaperWrite(ref.paperId, async current => {
                const pdfPath = pdfVariantPath(current, variant === 'orig' ? null : variant);
                if (!existsSync(pdfPath)) throw notFound('当前 PDF 版本不存在');
                assertInside(realDataDir(dataDir), realpathSync(pdfPath));
                if (lstatSync(pdfPath).isSymbolicLink()) throw new ManageError('symlink', 400, '请使用文献库内的实际 PDF 文件');
                return pdfAnnotations({ ...current, pdfPath }, dataDir, req.method === 'GET' ? { action: 'read' } : body);
            });
            json(res, result.error ? result.code === 'conflict' ? 409 : 400 : 200, result); return;
        }
        // 新建专题（目录）。校验与 upload / rename 的 to 侧同一套（validateName：边界 + 命名规范），
        // 保证「能创建的必然能删除/改名」（PR-1 的创建/删除对称原则；创建走 inline 正则时，
        // `.hidden`/超长/含控制字符的名字都能被创建，却是删不掉的孤儿）。
        if (sub === '/api/library/topic' && req.method === 'POST') {
            const body = (await readBody(req));
            try {
                const name = validateName(body.name, 'topic');
                const existing = runtime.catalog.listCollections().find(c => c.parentId === null && foldName(c.name) === foldName(name));
                const entity = existing || (await runtime.service.createCollection({ parentId: null, name, operationId: body.operationId || randomUUID() }, 'manual')).entity;
                json(res, 200, { ok: true, topic: entity.name, collectionId: entity.collectionId });
            }
            catch (err) {
                if (!manageFail(res, err))
                    throw err;
            }
            return;
        }
        // 上传 PDF 到专题（raw body；文件名/专题走 header，避免 multipart 解析。
        // header 值不允许非 Latin-1 字符，中文一律 encodeURIComponent 编码传输，这里解码）
        if (sub === '/api/library/upload' && req.method === 'POST') {
            const topic = decodeHdr(req.headers['x-dpr-topic']), filename = decodeHdr(req.headers['x-dpr-name']);
            const collectionId = decodeHdr(req.headers['x-dpr-collection-id']);
            if (typeof filename !== 'string' || !/\.pdf$/i.test(filename)) throw new ManageError('bad-request', 400, '请提供 PDF 文件名');
            const stem = filename.slice(0, -4); validateSegment(stem);
            const collection = collectionId ? runtime.catalog.resolveCollection({ collectionId }) : runtime.catalog.listCollections().find(c => foldName(c.segments.join('/')) === foldName(String(topic || '')));
            if (!collection) throw new ManageError('not-found', 404, '请先选择或创建文献库');
            const chunks = []; let bytes = 0;
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 512 * 1024 * 1024) throw new ManageError('body-too-large', 413, 'PDF 超过单文件 512 MiB 限制'); chunks.push(chunk); }
            const buffer = Buffer.concat(chunks), temp = join(dataDir, '.dpr-upload-' + randomUUID() + '.pdf');
            let identity;
            try {
                const handle = await open(temp, 'wx', 0o600);
                try { identity = await handle.stat(); await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
                const outcome = await runtime.service.importPdfs({ collectionId: collection.collectionId, sources: [{ path: temp, name: stem }], operationId: randomUUID() }, 'manual');
                const result = outcome.results[0];
                if (!result?.created) throw new ManageError(result?.code || 'pdf-invalid', result?.code === 'target-exists' ? 409 : 400, '该文件未导入，请核对 PDF 与同名文件');
                const ref = runtime.catalog.resolvePaper({ paperId: result.paperId });
                json(res, 200, { ok: true, ...publicEntity(ref), bytes });
            } finally {
                const current = lstatSync(temp, { throwIfNoEntry: false });
                if (identity && current?.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) await unlink(temp);
            }
            return;
        }
        /* ── 路由名兼容层 ─────────────────────────────────────────────────────
           上游 v1.3.0（614b935）为文献库自建了 4 条 CRUD 路由
           `/api/library/{delete,rename}-{topic,paper}` —— **对外规范路径**（上游 UI / 文档 / 上游用例
           都走它们）。我们分支的 `/api/library/{topic,paper}/{delete,rename}` 保留为别名。
           两族共用稳定ID事务 service（回收站可恢复 / 精确清单 / catalog tombstone /
           会话·任务·ReaderGate 409 / 不可变计划）；上游那份带穿越洞的第二实现
           （rmSync(recursive) 且 topic 未校验）已整段删除 —— 任何时刻只有一份实现。
           body 键也做兼容：topic ?? name、newName ?? to。 */
        // Preview DTOs derive only from immutable service plans and stat'd sourceFiles.
        if (['/api/library/paper/delete-plan', '/api/library/topic/delete-plan', '/api/library/topic/clear-plan'].includes(sub) && req.method === 'GET') {
            const mode = sub === '/api/library/paper/delete-plan' ? 'paper' : sub === '/api/library/topic/delete-plan' ? 'empty-collection' : 'clear-collection';
            const input = Object.fromEntries(url.searchParams), target = deleteTarget(input, mode);
            json(res, 200, await deletePreview(target, mode)); return;
        }
        // Legacy named calls retain confirmation rules and reject foreign planId mixtures.
        if (['/api/library/delete-paper', '/api/library/paper/delete', '/api/library/delete-topic', '/api/library/topic/delete', '/api/library/topic/clear'].includes(sub) && req.method === 'POST') {
            if (url.searchParams.has('planId')) throw new ManageError('bad-request', 400, '旧名称入口不接受 planId');
            const body = await readBody(req, 128 * 1024), mode = sub.endsWith('/clear') ? 'clear-collection' : ['/api/library/delete-paper', '/api/library/paper/delete'].includes(sub) ? 'paper' : 'empty-collection';
            json(res, 200, await legacyDelete(body, mode)); return;
        }

        // 重命名文献：全部同名产物一起改名（含译文变体），`.pdf` 最后移。
        // 规范名 = /api/library/rename-paper（上游 UI 与用例），别名 = /api/library/paper/rename。
        if ((sub === '/api/library/rename-paper' || sub === '/api/library/paper/rename') && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024);
            if (rejectWritePath(body, res)) return;
            const ref = safeLibraryRef(body), name = validateNewPaperName(body.newName ?? body.to, ref.name);
            await sessionsReady;
            if (!(await requireSessionClear(ref, res))) return;
            const plan = await runtime.service.planRename({ paperId: ref.paperId, name, expectedLocationRevision: ref.locationRevision });
            const result = await runtime.service.applyRename({ planId: plan.planId, operationId: body.operationId || randomUUID() });
            json(res, 200, { ...result, name: result.entity.name, from: ref.name, to: result.entity.name, detachedSessions: 0 }); return;
        }
        // 重命名专题：目录整体改名（历史会话不删除，但不再出现在该专题下）
        if ((sub === '/api/library/rename-topic' || sub === '/api/library/topic/rename') && req.method === 'POST') {
            const body = await readBody(req, 128 * 1024);
            if (rejectWritePath(body, res)) return;
            await sessionsReady;
            const collection = runtime.catalog.resolveCollection(body.collectionId ? { collectionId: body.collectionId } : { topic: body.topic ?? body.name });
            const name = validateSegment(body.newName ?? body.to);
            const plan = await runtime.service.planRename({ collectionId: collection.collectionId, name, expectedLocationRevision: collection.revision });
            const result = await runtime.service.applyRename({ collectionId: collection.collectionId, planId: plan.planId, operationId: body.operationId || randomUUID() });
            workspaceCache.delete(collection.dirPath);
            json(res, 200, { ...result, topic: result.entity.segments.join('/'), from: collection.segments.join('/'), to: result.entity.segments.join('/'), detachedSessions: 0 }); return;
        }
        // 公式索引：MinerU content_list 的 equation 块（LaTeX + bbox），供阅读器画热区/列表面板
        if (sub === '/api/formulas' && req.method === 'GET') {
            const ref = locate(url); // 只读路径，沿用 path/topic/name 三种定位
            json(res, 200, await readFormulaIndex(ref));
            return;
        }
        /* ── 划词翻译（公式保留，契约 docs/selection-translate-requirements.md §3.9）─────
           客户端只送「按页 + 按 display 归属切好的 chunk」；行内公式的还原（选区文本 ↔ MinerU
           text 块对齐）在服务端做，所以请求体里**没有任何矩形/bbox/pageSize**。
           本接口只读（不写盘）⇒ 定位沿用 /api/formulas 的读路径语义，不做写路径边界。
           API key 只存在于本进程：请求体只有 model（客户端从 /api/zh 拿到的 apiKeyHint 仅用于展示），
           响应体与错误文案一律不带 key。 */
        if (sub === '/api/translate-selection' && req.method === 'POST') {
            const body = (await readBody(req));
            const bad = (msg, code = 'bad-request') => json(res, 400, { error: msg, code });
            if (!Array.isArray(body.chunks))
                return bad('chunks 必须是数组');
            if (body.chunks.length < 1 || body.chunks.length > MAX_CHUNKS) {
                return bad(`chunks 数量必须在 1~${MAX_CHUNKS} 之间（收到 ${body.chunks.length}）`, 'too-large');
            }
            const chunks = [];
            let total = 0;
            for (const raw of body.chunks) {
                if (typeof raw !== 'object' || raw === null)
                    return bad('chunks 的每一项必须是对象');
                const c = raw;
                const page = c.page;
                if (typeof page !== 'number' || !Number.isInteger(page) || page < 1)
                    return bad('chunk.page 必须是 ≥1 的整数');
                const text = typeof c.text === 'string' ? c.text : '';
                const latex = typeof c.latex === 'string' ? c.latex : '';
                if (c.kind === 'formula') {
                    if (!latex)
                        return bad('formula chunk 的 latex 不能为空');
                    if (latex.length > MAX_LATEX_CHARS)
                        return bad(`latex 超过 ${MAX_LATEX_CHARS} 字符`, 'too-large');
                    total += latex.length;
                    chunks.push({ page, kind: 'formula', latex });
                    continue;
                }
                if (c.kind !== 'text')
                    return bad("chunk.kind 必须为 'text' 或 'formula'");
                if (text.length > MAX_TEXT_CHARS)
                    return bad(`text 超过 ${MAX_TEXT_CHARS} 字符`, 'too-large');
                total += text.length;
                chunks.push({ page, kind: 'text', text });
            }
            if (total === 0)
                return bad('选区为空');
            if (total > MAX_TOTAL_CHARS)
                return bad(`选区总长超过 ${MAX_TOTAL_CHARS} 字符`, 'too-large');
            let ref;
            try {
                ref = resolvePaper(dataDir, body);
            }
            catch (error) {
                if (error instanceof CatalogError) throw error;
                throw notFound('文献不存在（划词翻译需要先能定位到该文献）');
            }
            const { endpoint, source } = await resolveTranslateEndpoint(config.translate);
            if (source === 'none') {
                json(res, 503, { error: '未配置翻译端点：在阅读器里点 ⚙ 填写（OpenAI 兼容端点即可）', code: 'no-endpoint' });
                return;
            }
            const index = await readTextBlockIndex(ref);
            const asm = assembleSource(chunks, index);
            try {
                const r = await translateSelection(endpoint, asm.source);
                json(res, 200, {
                    translation: r.translation,
                    model: r.model,
                    cached: r.cached,
                    formulaTotal: r.formulaTotal,
                    formulaKept: r.formulaKept,
                    formulaLost: r.formulaLost,
                    formulaApplied: asm.applied,
                    formulaSkipped: asm.skipped,
                    formulaStatus: formulaStatusOf(asm),
                    hasBlockIndex: asm.hasBlockIndex,
                    ms: r.ms,
                });
            }
            catch (err) {
                if (!(err instanceof SelectionTranslateError))
                    throw err;
                json(res, err.status, {
                    error: err.message,
                    code: err.code,
                    ...(err.upstreamStatus !== null ? { upstreamStatus: err.upstreamStatus } : {}),
                });
            }
            return;
        }
        // 新建伴读会话（会话N+1）。最新可见会话还是空白草稿时直接复用它——
        // 连点「新建」不再堆积空会话（毫无意义的点击什么都不存）。
        // n 用全量扫描分配（含归档/空白），绝不与磁盘上已有目录撞号。
        if (sub === '/api/sessions/new' && req.method === 'POST') {
            const body = (await readBody(req));
            const ref = resolvePaper(dataDir, body);
            const visible = await listPaperSessions(ref);
            const newest = visible[visible.length - 1];
            if (newest && newest.blank && !newest.running) {
                json(res, 200, { ok: true, n: newest.n, sessionId: newest.sessionId, reused: true });
                return;
            }
            const all = await scanPaperSessions(ref);
            const n = all.length ? all[all.length - 1].n + 1 : 1;
            const sessionId = `${sessionPrefixFor(ref)}-${n}`;
            await createPaperSession(sessionId, ref.topic);
            json(res, 200, { ok: true, n, sessionId });
            return;
        }
        // 归档空白草稿（切换会话时客户端后台调用）：只接受该文献的空白会话，内容会话绝不归档
        if (sub === '/api/sessions/archive' && req.method === 'POST') {
            const body = (await readBody(req));
            const sessionId = body.sessionId ?? '';
            const ref = resolvePaper(dataDir, body);
            await sessionsReady;
            if (runtime.catalog.snapshot().sessionBindings[sessionId] !== ref.paperId) {
                json(res, 400, { error: '会话不属于该文献' });
                return;
            }
            if (!workspaceRegistry) {
                json(res, 503, { error: 'workspaceRegistry 服务不可用' });
                return;
            }
            const sessions = await listPaperSessions(ref);
            const target = sessions.find((s) => s.sessionId === sessionId);
            if (!target || !target.blank || target.running) {
                json(res, 409, { error: '只允许归档无内容的空白会话' });
                return;
            }
            await workspaceRegistry.archiveSession(sessionId);
            json(res, 200, { ok: true });
            return;
        }
        if (sub === '/api/paper' && req.method === 'GET') {
            const ref = locate(url);
            const t = await readTranscript(ref);
            const st = await stat(ref.pdfPath);
            json(res, 200, {
                ...publicEntity(ref),
                pdfBytes: st.size,
                hasTranscript: t !== null,
                chars: t?.text.length ?? 0,
                hasPageIndex: (t?.pages?.length ?? 0) > 0,
                pageCount: t?.pages?.length ?? null,
            });
            return;
        }
        if (sub === '/api/pdf' && req.method === 'GET') {
            const ref = locate(url);
            const pdfPath = pdfVariantPath(ref, url.searchParams.get('variant'));
            const st = await stat(pdfPath); // 变体不存在时 404/500 由外层兜底
            // download=1 → 附件下载（导出译文/原文）；文件名即磁盘名 <名>.pdf / -zh.pdf / -dual.pdf
            const headers = {
                'content-type': 'application/pdf',
                'content-length': st.size,
                'cache-control': 'no-cache', // 切换文献/重新生成后必须拿到新的
            };
            if (url.searchParams.get('download') === '1') {
                const name = basename(pdfPath);
                headers['content-disposition'] =
                    `attachment; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;
            }
            res.writeHead(200, headers);
            createReadStream(pdfPath).pipe(res);
            return;
        }
        // 中文版状态：zh=纯中文 dual=中英对照 busy=翻译中。
        // 顺带返回生效端点的脱敏信息，让 UI 能回答「正在用哪个模型/key 翻」——key 只给掩码。
        if (sub === '/api/zh' && req.method === 'GET') {
            const { endpoint, source } = await resolveTranslateEndpoint(config.translate);
            json(res, 200, {
                ...(() => {
                    const ref = locate(url), st = zhStatus(ref);
                    const pending = queue?.snapshot().items.find(i => (i.paperId ? i.paperId === ref.paperId : i.topic === ref.topic && i.name === ref.name) && ['queued','running'].includes(i.status));
                    return pending?.status === 'queued' ? { ...st, busy: true, queued: true, phase: queue.state.paused ? '队列已暂停' : '等待前序文献翻译' } : st;
                })(),
                model: endpoint.model ?? null,
                apiKeyHint: endpoint.apiKey ? maskApiKey(endpoint.apiKey) : null,
                endpointSource: source,
            });
            return;
        }
        // 启动后台翻译（幂等；force=true 为重翻：先删已有译文再启动）。端点：UI 里填的 > profile 的 translate
        if (sub === '/api/zh/generate' && req.method === 'POST') {
            const body = (await readBody(req));
            let ref;
            try {
                // 同样写盘（<文献>-zh.pdf 落在 PDF 旁边）→ 与 transcribe 同一套 path 边界约束
                ref = locateForWrite(body);
            }
            catch (err) {
                if (manageFail(res, err))
                    return;
                throw err;
            }
            const { endpoint } = await resolveTranslateEndpoint(config.translate);
            safeLibraryRef(ref);
            const st = zhStatus(ref);
            if (st.busy || (!body.force && (st.zh || st.dual))) {
                json(res, 409, { started: false, reason: st.busy ? 'busy' : 'already-exists' }); return;
            }
            if (!endpoint.baseUrl || !endpoint.apiKey || !endpoint.model) {
                json(res, 409, { started: false, code: 'no-endpoint', reason: '请先配置翻译端点' }); return;
            }
            const queued = requireQueue().enqueue([{ paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name }], { force: body.force === true });
            json(res, queued.added.length ? 200 : 409, { started: queued.added.length > 0, queued: true, ...(queued.added.length ? {} : { reason: 'busy' }) });
            return;
        }
        // ── 翻译端点配置（阅读器浮层的读写口）─────────────────────────────
        // GET 只回显掩码 key：明文永不离开服务端
        if (sub === '/api/translate/config' && req.method === 'GET') {
            const { endpoint, source } = await resolveTranslateEndpoint(config.translate);
            json(res, 200, {
                baseUrl: endpoint.baseUrl ?? '',
                model: endpoint.model ?? '',
                hasApiKey: Boolean(endpoint.apiKey),
                apiKeyHint: endpoint.apiKey ? maskApiKey(endpoint.apiKey) : '',
                source,
            });
            return;
        }
        // POST：校验 → 预检 → 通了才落盘。key 填错在这里就拦下，
        // 不让它拖到 babeldoc 跑几分钟后才异步失败。
        if (sub === '/api/translate/config' && req.method === 'POST') {
            const body = (await readBody(req));
            const baseUrl = body.baseUrl?.trim() ?? '';
            const model = body.model?.trim() ?? '';
            // key 留空 = 沿用已存的那把（明文不回传，前端无法预填）
            const prev = await readTranslateConfig();
            const apiKey = body.apiKey?.trim() || prev?.apiKey || '';
            if (!/^https?:\/\//i.test(baseUrl)) {
                json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头' });
                return;
            }
            if (!model) {
                json(res, 400, { error: '模型名不能为空（如 deepseek-chat）' });
                return;
            }
            if (!apiKey) {
                json(res, 400, { error: 'API Key 不能为空' });
                return;
            }
            const test = await testTranslateEndpoint({ baseUrl, apiKey, model });
            if (!test.ok) {
                json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` });
                return;
            }
            await writeTranslateConfig({ baseUrl, apiKey, model });
            json(res, 200, { ok: true });
            return;
        }
        // DELETE：清掉文件，回落到 profile 的 translate
        if (sub === '/api/translate/config' && req.method === 'DELETE') {
            await clearTranslateConfig();
            json(res, 200, { ok: true });
            return;
        }
        // ── Jev/TypeSafe 端点配置（设置面板的读写口）─────────────────────────
        // 与翻译配置同一套约定：GET 只回显掩码 key；POST 预检通过才落盘；DELETE 回落
        if (sub === '/api/typesafe/config' && req.method === 'GET') {
            const { cfg, source } = await resolveTypesafeConfig(config.typesafe);
            json(res, 200, {
                baseUrl: cfg.baseUrl ?? '',
                model: cfg.model ?? '',
                hasApiKey: Boolean(cfg.apiKey),
                apiKeyHint: cfg.apiKey ? maskApiKey(cfg.apiKey) : '',
                source,
            });
            return;
        }
        // POST：baseUrl/model 可空（SDK 有默认值）；key 留空 = 沿用已存的那把。
        // 校验 → 预检 → 通了才落盘：重排失败会静默降级，key 填错很难察觉，这里先拦。
        if (sub === '/api/typesafe/config' && req.method === 'POST') {
            const body = (await readBody(req));
            const baseUrl = body.baseUrl?.trim() ?? '';
            const model = body.model?.trim() ?? '';
            const prev = await readTypesafeConfig();
            const apiKey = body.apiKey?.trim() || prev?.apiKey || '';
            if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
                json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头（留空用官方默认）' });
                return;
            }
            if (!apiKey) {
                json(res, 400, { error: 'API Key 不能为空' });
                return;
            }
            const test = await testTypesafeEndpoint({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) });
            if (!test.ok) {
                json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` });
                return;
            }
            await writeTypesafeConfig({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) });
            json(res, 200, { ok: true });
            return;
        }
        // DELETE：清掉文件，回落到 profile 的 typesafe / 环境变量
        if (sub === '/api/typesafe/config' && req.method === 'DELETE') {
            await clearTypesafeConfig();
            json(res, 200, { ok: true });
            return;
        }
        // ── 嵌入模型端点配置（设置面板第三张端点卡片）─────────────────────────
        // 与 translate/typesafe 完全同一套约定：GET 只回掩码 key；POST 预检通过才落盘；DELETE 回落。
        if (sub === '/api/embed/config' && req.method === 'GET') {
            const { cfg, source, enabled } = await resolveEmbedConfig(config.embed);
            json(res, 200, {
                baseUrl: cfg.baseUrl ?? '',
                model: cfg.model ?? '',
                hasApiKey: Boolean(cfg.apiKey),
                apiKeyHint: cfg.apiKey ? maskEmbedApiKey(cfg.apiKey) : '',
                // 未显式配置时回 null（前端显示默认值占位）；生效值可能是 profile 来的，一并回显
                batchSize: cfg.batchSize ?? null,
                enabled,
                source,
            });
            return;
        }
        // POST：baseUrl/model/key 三项齐全是启用条件；key 留空 = 沿用已存的那把；batchSize 可选。
        // 校验 → 预检（按生效批大小真打一发 /embeddings）→ 通了才落盘：嵌入失败是静默降级，填错很难察觉。
        if (sub === '/api/embed/config' && req.method === 'POST') {
            const body = (await readBody(req));
            const baseUrl = body.baseUrl?.trim() ?? '';
            const model = body.model?.trim() ?? '';
            const prev = await readEmbedConfig();
            const apiKey = body.apiKey?.trim() || prev?.apiKey || '';
            if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
                json(res, 400, { error: '端点 URL 需要以 http:// 或 https:// 开头' });
                return;
            }
            if (!model) {
                json(res, 400, { error: '嵌入模型名不能为空' });
                return;
            }
            if (!apiKey) {
                json(res, 400, { error: 'API Key 不能为空' });
                return;
            }
            // 批大小：留空 = 不落这项（回落 profile / 默认 10）；填了必须是 1–2048 的整数
            let batchSize;
            const rawBatch = body.batchSize;
            if (rawBatch !== undefined && rawBatch !== null && String(rawBatch).trim() !== '') {
                const n = Number(rawBatch);
                if (!Number.isInteger(n) || n < 1 || n > 2048) {
                    json(res, 400, { error: '批大小需为 1–2048 的整数（端点限制更小时调低，如百炼部分模型为 10/20）' });
                    return;
                }
                batchSize = n;
            }
            const test = await testEmbedEndpoint({ baseUrl, apiKey, model, ...(batchSize !== undefined ? { batchSize } : {}) });
            if (!test.ok) {
                json(res, 400, { error: `连接测试失败：${test.detail ?? '未知原因'}` });
                return;
            }
            // 面板没纳管的字段（timeoutMs/candidateSize）沿用已落盘的值，不被保存动作意外抹掉
            await writeEmbedConfig({
                baseUrl,
                apiKey,
                model,
                ...(batchSize !== undefined ? { batchSize } : {}),
                ...(prev?.timeoutMs !== undefined ? { timeoutMs: prev.timeoutMs } : {}),
                ...(prev?.candidateSize !== undefined ? { candidateSize: prev.candidateSize } : {}),
            });
            json(res, 200, { ok: true });
            return;
        }
        // DELETE：清掉文件，回落到 profile 的 embed / 环境变量
        if (sub === '/api/embed/config' && req.method === 'DELETE') {
            await clearEmbedConfig();
            json(res, 200, { ok: true });
            return;
        }
        // ── MinerU 解析后端配置（设置面板第三张卡片的读写口）────────────────────
        // 与 translate/typesafe 同一套约定：GET 只回显掩码 key；POST 预检通过才落盘；DELETE 回落。
        const MINERU_SOURCES = new Set(['auto', 'pdfjs', 'mineru-local', 'mineru-cloud']);
        if (sub === '/api/mineru/config' && req.method === 'GET') {
            const { config: cfg, source } = await resolveMineruConfig(config.mineru);
            json(res, 200, {
                mode: cfg.mode,
                source,
                local: {
                    baseUrl: cfg.local.baseUrl,
                    backend: cfg.local.backend,
                    effort: cfg.local.effort,
                    parseMethod: cfg.local.parseMethod,
                    langList: cfg.local.langList,
                    hasApiKey: Boolean(cfg.local.apiKey),
                    apiKeyHint: cfg.local.apiKey ? maskApiKey(cfg.local.apiKey) : '',
                },
                cloud: {
                    baseUrl: cfg.cloud.baseUrl,
                    modelVersion: cfg.cloud.modelVersion,
                    hasApiKey: Boolean(cfg.cloud.apiKey),
                    apiKeyHint: cfg.cloud.apiKey ? maskApiKey(cfg.cloud.apiKey) : '',
                },
            });
            return;
        }
        // POST：校验 → 预检 → 通了才落盘。key 留空沿用已存值（明文不回传，前端无法预填）。
        if (sub === '/api/mineru/config' && req.method === 'POST') {
            const body = (await readBody(req));
            if (body.mode !== undefined && body.mode !== 'off' && body.mode !== 'local' && body.mode !== 'cloud') {
                json(res, 400, { error: 'mode 只能是 off/local/cloud' });
                return;
            }
            const prev = await resolveMineruConfig(config.mineru);
            const next = mergeMineruBody(prev.config, body);
            const test = await precheckMineruConfig(next);
            if (!test.ok) {
                json(res, 400, { error: test.detail ?? '连接测试失败' });
                return;
            }
            await writeMineruConfig(next);
            json(res, 200, { ok: true });
            return;
        }
        // DELETE：清掉文件，回落到 profile 的 mineru / 环境变量
        if (sub === '/api/mineru/config' && req.method === 'DELETE') {
            await clearMineruConfig();
            json(res, 200, { ok: true });
            return;
        }
        // 连通性预检（不落盘）：设置面板「测试连接」按钮用；HTTP 恒 200，便于 UI 展示。
        if (sub === '/api/mineru/test' && req.method === 'POST') {
            const body = (await readBody(req));
            const prev = await resolveMineruConfig(config.mineru);
            const next = mergeMineruBody(prev.config, body);
            const test = await precheckMineruConfig(next);
            if (test.ok)
                json(res, 200, { reachable: true, mode: next.mode });
            else
                json(res, 200, { reachable: false, mode: next.mode, error: test.detail ?? '连接测试失败' });
            return;
        }
        // 健康探针：GET /api/mineru/health（可选 ?mode=local|cloud，默认按生效 mode）
        if (sub === '/api/mineru/health' && req.method === 'GET') {
            const modeParam = url.searchParams.get('mode');
            const mode = modeParam === 'local' || modeParam === 'cloud' ? modeParam : (await resolveMineruConfig(config.mineru)).config.mode;
            if (mode === 'off') {
                json(res, 200, { reachable: false, mode: 'off', error: 'MinerU 未启用（mode=off）' });
                return;
            }
            if (mode === 'local') {
                const { config: cfg } = await resolveMineruConfig(config.mineru);
                const t = await testMineruLocal(cfg.local.baseUrl);
                if (!t.ok) {
                    json(res, 200, { reachable: false, mode: 'local', error: t.detail ?? '不可达' });
                    return;
                }
                const h = t.health ?? {};
                json(res, 200, {
                    reachable: true,
                    mode: 'local',
                    status: h['status'] ?? 'healthy',
                    version: t.version ?? '',
                    protocolVersion: h['protocol_version'] ?? null,
                    queuedTasks: h['queued_tasks'] ?? 0,
                    processingTasks: h['processing_tasks'] ?? 0,
                });
                return;
            }
            const { config: cfg } = await resolveMineruConfig(config.mineru);
            const t = await testMineruCloud(cfg.cloud.baseUrl, cfg.cloud.apiKey);
            if (t.ok)
                json(res, 200, { reachable: true, mode: 'cloud' });
            else
                json(res, 200, { reachable: false, mode: 'cloud', error: t.detail ?? '不可达' });
            return;
        }
        if (sub === '/api/transcribe' && req.method === 'POST') {
            const body = (await readBody(req));
            let ref;
            try {
                // t3-O2：这条路由会**写盘**（<文献>.txt 等落在 PDF 旁边），所以 path 必须受与删除同级的边界约束
                ref = locateForWrite(body);
            }
            catch (err) {
                if (manageFail(res, err))
                    return;
                throw err;
            }
            const mineru = await resolveMineruConfig(config.mineru);
            const source = MINERU_SOURCES.has(body.source ?? 'auto') ? body.source : 'auto';
            const t = await runtime.withPaperTask(ref.paperId, current => transcribePaper(current, { force: body.force === true, source, mineru }));
            json(res, 200, { chars: t.chars, pageCount: t.pageCount, hasPageIndex: t.pages.length > 0, source: t.source, producer: t.producer, backend: t.backend });
            return;
        }
        // 文献的伴读会话列表（多会话：会话1/会话2/…）
        if (sub === '/api/sessions' && req.method === 'GET') {
            const ref = locate(url);
            const sessions = await listPaperSessions(ref);
            json(res, 200, { sessions, latest: sessions.length ? sessions[sessions.length - 1].n : 1 });
            return;
        }
        // 实时会话流（SSE）：桥接官方 sessionController.follow —— 阅读器右侧就是真正的 dsh 会话
        if (sub === '/api/session/follow' && req.method === 'GET') {
            const ref = locate(url);
            const sessions = await listPaperSessions(ref);
            const nParam = +(url.searchParams.get('n') ?? 0) || 0;
            // 未指定时进最新会话；全新文献进会话1
            const n = nParam > 0 ? nParam : sessions.length ? sessions[sessions.length - 1].n : 1;
            const sessionId = await sessionIdFor(ref, n, url.searchParams.get('sessionId') ?? undefined);
            try {
                await createPaperSession(sessionId, ref.topic);
            }
            catch { /* 已存在则复用；失败由 follow 报错 */ }
            res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            res.write(': connected\n\n');
            res.write(`event: meta\ndata: ${JSON.stringify({ n, sessionId })}\n\n`);
            const ac = new AbortController();
            req.on('close', () => ac.abort());
            try {
                const frames = sessionController.follow({ address: { kind: 'session', sessionId }, maxMessages: 200, assistantStream: true }, ac.signal);
                for await (const frame of frames) {
                    if (ac.signal.aborted)
                        break;
                    res.write(`data: ${JSON.stringify(frame)}\n\n`);
                }
            }
            catch (err) {
                if (!ac.signal.aborted) {
                    res.write(`event: error\ndata: ${JSON.stringify({ error: String(err instanceof Error ? err.message : err) })}\n\n`);
                }
            }
            if (!res.writableEnded)
                res.end();
            return;
        }
        if (sub === '/api/ask' && req.method === 'POST') {
            const body = (await readBody(req));
            if (!body.question?.trim()) {
                json(res, 400, { error: 'question 不能为空' });
                return;
            }
            const sc = sessionController;
            if (!sc) {
                json(res, 503, { error: '当前 profile 没有 sessionController 服务，无法注入会话（headless?）' });
                return;
            }
            const ref = resolvePaper(dataDir, body);
            let sessionId, n;
            const workspace = Object.hasOwn(body, 'workspaceSessionId');
            if (workspace) {
                if (!hasUiCapability(req) || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
                    throw new ManageError('authorization-required', 403, '页面授权已失效，请重新打开右栏阅读页');
                if (typeof body.workspaceSessionId !== 'string' || !body.workspaceSessionId || body.workspaceSessionId.length > 256
                    || ['fresh', 'n', 'sessionId'].some(key => Object.hasOwn(body, key)))
                    throw new ManageError('workspace-target', 400, '请选择当前工作区的聊天会话');
                const all = await sc.list({}, AbortSignal.timeout(15000));
                const target = all.items.find(row => row.sessionId === body.workspaceSessionId);
                if (!target || target.archived || workspaceRegistry?.archivedSessionIds?.includes(body.workspaceSessionId))
                    throw new ManageError('workspace-target', 404, '目标聊天会话已不可用，请重新打开阅读页');
                if (body.workspaceSessionId.startsWith('dpr-') || runtime.catalog.snapshot().sessionBindings[body.workspaceSessionId])
                    throw new ManageError('workspace-target', 409, '请从普通工作区聊天打开右栏伴读');
                sessionId = body.workspaceSessionId;
            } else {
                const existing = await listPaperSessions(ref);
                if (body.fresh) {
                    const all = await scanPaperSessions(ref);
                    n = all.length ? all[all.length - 1].n + 1 : 1;
                } else if (body.n && body.n > 0) n = body.n;
                else n = existing.length ? existing[existing.length - 1].n : 1;
                sessionId = await sessionIdFor(ref, n, body.sessionId);
                try { await createPaperSession(sessionId, ref.topic); }
                catch { /* Existing companion sessions are reused. */ }
            }
            const hasQuote = typeof body.selectedText === 'string' && body.selectedText.trim() !== '';
            // 公式引用（kind='equation'）：引用内容来自 MinerU 的 LaTeX，不是文本层乱码（契约 §1.3）；
            // 非公式路径的文案必须与改造前逐字一致（回归项 A11）。
            const isEquation = body.kind === 'equation';
            const where = hasQuote && body.page ? `（选中于第 ${body.page} 页）` : '';
            const lines = [
                workspace ? `[论文伴读] 文献：${ref.topic}/${ref.name}（使用下方 paperId 调用 search_paper 检索，回答注明页码）`
                    : `[论文伴读] 文献：${ref.topic}/${ref.name}（同目录下，search_paper 可直接检索；回答注明页码）`,
            ];
            if (workspace) lines.push(`文献稳定标识 paperId：${ref.paperId}；检索这篇文献时显式使用该标识。`);
            if (hasQuote) {
                lines.push(isEquation
                    ? `用户在阅读器里引用了${body.page ? `第 ${body.page} 页的` : ''}一个公式（LaTeX 源，来自 MinerU 版面解析）：`
                    : `用户在阅读器里选中了一段文字${where}：`, `"""${body.selectedText.trim()}"""`);
            }
            lines.push(`用户的问题：${body.question}`);
            const prompt = lines.join('\n');
            await sc.prompt({
                sessionId,
                content: [{ type: 'text', text: prompt }],
                requestId: randomUUID(),
            }, AbortSignal.timeout(30_000));
            json(res, 200, workspace ? { ok: true, sessionId, target: 'workspace' } : { ok: true, sessionId, n });
            return;
        }
        json(res, 404, { error: 'not found: ' + url.pathname });
    };
    ctx.effect(() => {
        const dispose = ws.register({
            kind: 'prefix',
            path: '/paper-reader',
            handler: (req, res) => {
                // 认证+Host 围栏（与宿主 /api 通道同一套校验）：插件路由不在宿主 index
                // 鉴权路径上，必须自己校验。本路由暴露 PDF 读取和会话注入，不能裸奔。
                const rejection = connection.requestRejection(req);
                if (rejection !== undefined) {
                    json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' });
                    return;
                }
                // 借浏览器请求的 Host 头记录服务 origin（工具结果里的 readerUrl 链接基址靠它拼）
                noteOrigin(req.headers.host);
                const url = new URL(req.url ?? '/', 'http://x');
                dispatch(req, res, url).catch((err) => {
                    if (res.headersSent) {
                        res.end();
                        return;
                    }
                    // ① 域内可识别错误（ManageError）：用它的状态码/机器码/结构化字段
                    if (isManageError(err) || Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599 && typeof err.code === 'string' && ['CatalogError', 'LibraryError', 'ReaderGateError', 'MetadataError', 'EnrichmentQueueError'].includes(err.name)) {
                        json(res, err.status, { error: err.message, code: err.code, ...(isManageError(err) ? err.extra : {}) });
                        return;
                    }
                    if ((err instanceof ShortTextError || err instanceof ScannedPdfError) && (url.pathname.startsWith('/paper-reader/api/enrichment/') || url.pathname === '/paper-reader/api/library/manage')) {
                        json(res, 422, { error: '本地文本不足，未调用 API；请检查 PDF 文本或先完成转录', code: 'text-unavailable' });
                        return;
                    }
                    // ② MinerU / 转录的**领域错误**：保留可读文案（既有测试明确断言这些文案含 `MinerU` 等关键词，
                    //    不许为了让文案变得「绝对安全」而把它们一起打哑），但先剥掉任何绝对路径。
                    // ③ 其余未知内部错误：不回显 err.message（原生 fs 错误常带绝对路径），只给通用文案。
                    //    两种情况都带 machine-readable code:'internal'。
                    const known = err instanceof MineruError || err instanceof ShortTextError || err instanceof ScannedPdfError;
                    const raw = err instanceof Error ? err.message : String(err);
                    // R7-F2：兜底文案承诺「详见服务端日志」，这里必须真的落一条日志。双重脱敏：
                    // stripAbsPaths 剥绝对路径、sanitizeDetail 剥凭据（Bearer / sk-* / ?token=），绝不把路径或密钥写进日志。
                    console.error('[dsh-paper-reader] route error:', sanitizeDetail(stripAbsPaths(raw)));
                    json(res, 500, { error: known ? stripAbsPaths(raw) : '内部错误（详见服务端日志）', code: 'internal' });
                });
            },
        });
        // Give an abruptly stopped previous owner's watchdog time to release the old child.
        const recoveryTimer = setTimeout(() => {
            void runtime.ready.then(() => queueStatus()).catch(() => {}).finally(() => { if (!disposed) queue?.kick(); });
        }, 1500);
        void Promise.all([automationReady, runtime.ready]).then(() => { if (!disposed && !automationError) automation.start(); }).catch(() => {});
        recoveryTimer.unref?.();
        console.log('[dsh-paper-reader] routes registered under /paper-reader');
        return async () => {
            disposed = true; uiCsrf = null;
            clearTimeout(recoveryTimer);
            dispose();
            // Revoke both producers and paid execution before waiting on a slow local scan.
            const queueStop = queue?.stop();
            const automationStop = automation.stop();
            await Promise.all([queueStop, automationStop, automationReady, runtime.stop()]);
        };
    });
}
