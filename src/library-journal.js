// Durable local operation journal + cross-process mutex. Never stores credentials or invokes APIs.
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalRoot, validateSegment } from './collection-paths.js';
import { matchArtifactName } from './library-manage.js';

export const JOURNAL_FILENAME = '.dpr-library-journal.json';
export class LibraryError extends Error {
    constructor(code = 'io') {
        const messages = { invalid: '文献库操作参数无效', conflict: '操作编号或文献版本已变化，请重新读取', 'not-ready': '文献库服务尚未就绪', 'not-found': '文献或子库不存在', 'reader-busy': '阅读器或其他任务尚未安全释放，请关闭编辑后重试', 'needs-review': '文献操作需要核对恢复，已保留相关文件', 'stale-plan': '改名预览已过期或源文件已变化，请重新预览', 'target-exists': '目标已存在，双方文件均已保留', 'source-changed': '导入源文件正在变化，已取消该文件复制', 'pdf-invalid': '导入文件缺少有效 PDF 文件头', 'too-large': '导入 PDF 超过大小限制', 'journal-invalid': '操作日志异常，原文件已保留，请人工核对', io: '文献库操作失败，已保留可恢复数据' };
        super(messages[code] || messages.io); this.name = 'LibraryError'; this.code = code;
        this.status = ({ invalid: 400, 'not-ready': 503, 'not-found': 404, 'pdf-invalid': 400, 'too-large': 413, 'journal-invalid': 503, io: 500 }[code] || 409);
    }
}
export const digest = v => createHash('sha256').update(v).digest('hex');
export const sameIdentity = (a, b) => a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
export const safeError = e => e?.code && e?.status ? e : new LibraryError(e?.code === 'EEXIST' ? 'target-exists' : 'io');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
function validate(state, rootIdentity) {
    let nodes = 0; const seen = new Set();
    function walk(v, depth = 0) {
        if (++nodes > 300000 || depth > 40) throw new LibraryError('journal-invalid');
        if (v === null || ['string', 'boolean'].includes(typeof v)) return;
        if (typeof v === 'number' && Number.isFinite(v)) return;
        if ((!plain(v) && !Array.isArray(v)) || seen.has(v)) throw new LibraryError('journal-invalid');
        seen.add(v);
        for (const [key, value] of Object.entries(v)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new LibraryError('journal-invalid');
            walk(value, depth + 1);
        }
        seen.delete(v);
    }
    walk(state);
    if (state.format !== 'dpr-library-journal' || state.version !== 1 || state.rootIdentity !== rootIdentity || !plain(state.plans) || !plain(state.operations)) throw new LibraryError('journal-invalid');
    const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
    const bad = () => { throw new LibraryError('journal-invalid'); };
    const ordered = v => Array.isArray(v) ? v.map(ordered) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v;
    const parent = path => path.split('/').slice(0, -1).join('/');
    const leaf = path => path.split('/').at(-1);
    for (const [id, op] of Object.entries(state.operations)) {
        if (op.operationId !== id || !uuid(op.generation) || !/^[a-f0-9]{64}$/.test(op.requestHash) || !['createCollection', 'rename', 'import', 'delete-paper', 'delete-collection', 'clear-collection', 'register-existing'].includes(op.kind)
            || !['prepared', 'moving', 'recovering', 'needs-review', 'rolled-back', 'committed'].includes(op.status) || !plain(op.intent) || !Array.isArray(op.steps)
            || !Array.isArray(op.paperIds) || !op.paperIds.every(uuid) || !Array.isArray(op.collectionIds) || !op.collectionIds.every(uuid) || !Number.isSafeInteger(op.ownerPid) || op.ownerPid < 1) bad();
        if (op.kind === 'register-existing') {
            const args = op.intent.args, q = op.intent.qualification;
            if (!plain(args) || !uuid(args.observationId) || op.operationId !== 'discover-' + digest(args.observationId) || !Array.isArray(args.segments) || !args.segments.length
                || !plain(args.expectedStat) || !['file', 'directory'].includes(args.expectedStat.type) || !plain(q) || !['baseline', 'live'].includes(q.classification)
                || op.steps.length || op.paperIds.length || op.collectionIds.length) bad();
        }
        const plan = op.intent.plan, staged = new Map(), created = new Map(), deleting = ['delete-paper', 'delete-collection', 'clear-collection'].includes(op.kind);
        if (deleting) {
            if (!plain(plan) || plan.kind !== 'delete' || plan.entityId !== op.entityId || !uuid(plan.planId) || plan.trashRel !== '.trash/' + plan.planId
                || ({ paper: 'delete-paper', 'empty-collection': 'delete-collection', 'clear-collection': 'clear-collection' }[plan.mode]) !== op.kind
                || !Array.isArray(plan.files) || !Array.isArray(plan.dirs) || !Array.isArray(plan.oldSegments) || !plan.oldSegments.length
                || plan.oldSegments[0] === '.trash' || plan.oldSegments[0].startsWith('.dpr-')
                || digest(JSON.stringify(ordered({ files: plan.files, dirs: plan.dirs }))) !== plan.sourceRevision) bad();
            const source = plan.oldSegments.join('/'), container = plan.trashRel + '/' + plan.entityId;
            if (plan.mode === 'paper') {
                if (plan.entityKind !== 'paper') bad();
                for (const file of plan.files) {
                    const health = file.kind === 'health', normal = parent(file.from) === source && (matchArtifactName(plan.oldName, leaf(file.from)) || leaf(file.from).slice(0, -4) === plan.oldName && leaf(file.from).slice(-4).toLowerCase() === '.pdf');
                    if (health ? file.from !== `${source}/.dpr-health/${digest(plan.oldName)}.json` : !normal) bad();
                    if (file.to !== container + (health ? '/.dpr-health/' : '/') + leaf(file.from)) bad();
                }
            } else {
                if (plan.entityKind !== 'collection' || plan.fromDir !== source || plan.toDir !== container || !plan.dirs.length || plan.dirs[0].from !== source) bad();
                for (const row of [...plan.files, ...plan.dirs]) if (!(row.from === source || row.from.startsWith(source + '/')) || row.to !== container + row.from.slice(source.length)) bad();
            }
        }
        if (op.kind === 'rename' && (!plain(plan) || plan.entityId !== op.entityId || !['paper', 'collection'].includes(plan.kind)
            || !Array.isArray(plan.files) || !Array.isArray(plan.dirs) || digest(JSON.stringify(ordered({ files: plan.files, dirs: plan.dirs }))) !== plan.sourceRevision)) bad();
        if (op.kind === 'rename') {
            try { validateSegment(plan.newName); } catch { bad(); }
            if (!Array.isArray(plan.oldSegments) || typeof plan.oldName !== 'string') bad();
            const directory = plan.oldSegments.join('/');
            if (plan.kind === 'paper') for (const file of plan.files) {
                const health = `${directory}/.dpr-health/${digest(plan.oldName)}.json`;
                const normal = parent(file.from) === directory && (matchArtifactName(plan.oldName, leaf(file.from)) || leaf(file.from).slice(0, -4) === plan.oldName && leaf(file.from).slice(-4).toLowerCase() === '.pdf');
                const expected = normal ? `${directory}/${plan.newName}${leaf(file.from).slice(plan.oldName.length)}` : `${directory}/.dpr-health/${digest(plan.newName)}.json`;
                if ((!normal && file.from !== health) || file.to !== expected) bad();
            }
            if (plan.kind === 'collection') {
                const target = [...plan.oldSegments.slice(0, -1), plan.newName].join('/');
                if (plan.fromDir !== directory || plan.toDir !== target || !plan.dirs.length || plan.dirs[0].from !== directory) bad();
                for (const row of [...plan.files, ...plan.dirs]) if (!(row.from === directory || row.from.startsWith(directory + '/')) || row.to !== target + row.from.slice(directory.length)) bad();
            }
        }
        for (const step of op.steps) {
            if (!plain(step) || !['intent', 'done', 'undone'].includes(step.phase)) bad();
            if (step.type === 'created-file') {
                if (op.kind !== 'import' || typeof step.path !== 'string' || !/^\.dpr-import-[a-f0-9-]{36}$/.test(leaf(step.path)) || parent(step.path) !== op.intent.segments?.join('/')) bad();
                created.set(step.path, step);
            } else if (step.type === 'mkdir') {
                const allowed = deleting ? ['.trash', plan.trashRel, ...(plan.mode === 'paper' ? [plan.trashRel + '/' + plan.entityId, ...(plan.files.some(f => f.kind === 'health') ? [plan.trashRel + '/' + plan.entityId + '/.dpr-health'] : [])] : [])] : op.kind === 'createCollection' ? [op.intent.segments?.join('/')] : op.kind === 'rename' && plan.kind === 'collection' ? plan.dirs.map(d => d.to) : [];
                if (!allowed.includes(step.path)) bad();
            } else if (step.type === 'trash-directory') {
                if (!deleting || plan.mode === 'paper' || step.from !== plan.fromDir || step.to !== plan.toDir || !sameIdentity(step.identity, plan.dirs[0].identity)) bad();
            } else if (step.type === 'stage-directory') {
                if (op.kind !== 'rename' || plan.kind !== 'collection' || step.from !== plan.fromDir || parent(step.to) !== parent(step.from) || !/^\.dpr-dir-[a-f0-9-]{36}$/.test(leaf(step.to)) || !sameIdentity(step.identity, plan.dirs[0].identity)) bad();
                staged.set('directory', step.to);
            } else if (step.type === 'move') {
                if (deleting) {
                    const file = plan.files.find(f => f.from === step.from && f.to === step.to);
                    if (plan.mode !== 'paper' || !file || !sameIdentity(file.identity, step.identity)) bad();
                } else if (op.kind === 'import') {
                    if (!created.has(step.from) || parent(step.to) !== op.intent.segments?.join('/') || !op.intent.names.includes(leaf(step.to).slice(0, -4)) || !step.to.endsWith('.pdf') || !sameIdentity(step.identity, created.get(step.from).identity)) bad();
                } else if (op.kind === 'rename' && plan.kind === 'paper') {
                    const file = plan.files.find(f => f.from === step.from);
                    if (file) {
                        if (parent(step.to) !== parent(step.from) || !/^\.dpr-move-[a-f0-9-]{36}-\d+$/.test(leaf(step.to)) || !sameIdentity(file.identity, step.identity)) bad();
                        staged.set(step.to, file);
                    } else { const prior = staged.get(step.from); if (!prior || step.to !== prior.to || !sameIdentity(prior.identity, step.identity)) bad(); }
                } else if (op.kind === 'rename' && plan.kind === 'collection') {
                    const stage = staged.get('directory'), file = plan.files.find(f => f.to === step.to);
                    if (!stage || !file || step.from !== stage + file.from.slice(plan.fromDir.length) || !sameIdentity(file.identity, step.identity)) bad();
                } else bad();
            } else bad();
        }
    }
    if (Buffer.byteLength(JSON.stringify(state)) > 16 * 1024 * 1024) throw new LibraryError('journal-invalid');
}
export function deadPid(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}
async function regular(path, optional = false) {
    try { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new LibraryError('journal-invalid'); return st; }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
export function createJournal(dataDir) {
    const root = canonicalRoot(dataDir), file = join(root, JOURNAL_FILENAME), lockPath = file + '.lock';
    let rootIdentity;
    async function checkRoot() {
        canonicalRoot(root);
        const st = await lstat(root, { bigint: true }), current = `${st.dev}:${st.ino}`;
        if (rootIdentity !== undefined && rootIdentity !== current) throw new LibraryError('invalid');
        rootIdentity = current;
    }
    async function read() {
        await checkRoot(); const before = await regular(file, true);
        if (!before) return { token: null, state: { format: 'dpr-library-journal', version: 1, rootIdentity, plans: {}, operations: {} } };
        if (before.size > 16 * 1024 * 1024) throw new LibraryError('journal-invalid');
        const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const st = await handle.stat(); if (!sameIdentity(st, before) || st.size !== before.size) throw new LibraryError('conflict');
            const buffer = Buffer.alloc(st.size + 1); let count = 0;
            while (count < buffer.length) { const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count); if (!bytesRead) break; count += bytesRead; }
            const after = await handle.stat();
            if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new LibraryError('conflict');
            const raw = buffer.subarray(0, count);
            let state; try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { throw new LibraryError('journal-invalid'); }
            try { validate(state, rootIdentity); } catch { throw new LibraryError('journal-invalid'); }
            return { state, token: digest(raw) };
        } finally { await handle.close(); }
    }
    async function publish(state, token) {
        await checkRoot(); validate(state, rootIdentity);
        const text = JSON.stringify(state), temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
        let handle, st;
        try {
            handle = await open(temp, 'wx', 0o600); st = await handle.stat(); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
            for (let attempt = 0; ; attempt++) {
                await checkRoot(); if ((await read()).token !== token) throw new LibraryError('conflict');
                if (!sameIdentity(await regular(temp), st)) throw new LibraryError('needs-review');
                try { await rename(temp, file); return digest(text); }
                catch (e) { if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 5) throw e; await delay(5 * 2 ** attempt); }
            }
        } finally {
            await handle?.close().catch(() => {});
            if (st) { try { const now = await lstat(temp); if (!now.isSymbolicLink() && sameIdentity(now, st)) await unlink(temp); } catch { /* Preserve unknown files. */ } }
        }
    }
    async function acquire() {
        await checkRoot();
        const owner = { pid: process.pid, token: randomUUID() }, ownerPath = `${lockPath}.owner-${process.pid}-${owner.token}`, reaperPath = lockPath + '.reaper';
        let st, handle, published = false, ownsReaper = false;
        async function ownerAt(path) {
            let info;
            try { info = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
            if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new LibraryError('needs-review');
            let value; try { value = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw new LibraryError('needs-review'); }
            if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string') throw new LibraryError('needs-review');
            return { st: info, owner: value };
        }
        try {
            // Publish complete owner bytes by exclusive hardlink, never an empty owner file.
            handle = await open(ownerPath, 'wx', 0o600); st = await handle.stat();
            await handle.writeFile(JSON.stringify(owner)); await handle.sync(); await handle.close(); handle = null;
            const guard = await ownerAt(reaperPath);
            if (guard) throw new LibraryError(deadPid(guard.owner.pid) ? 'needs-review' : 'conflict');
            try { await link(ownerPath, lockPath); published = true; }
            catch (e) {
                if (e.code !== 'EEXIST') throw e;
                const old = await ownerAt(lockPath);
                if (old && !deadPid(old.owner.pid)) throw new LibraryError('conflict');
                // Reclaimers serialize independently; a stale reaper is explicit manual review,
                // rather than recursively stealing a guard and reopening the ABA race.
                try { await link(ownerPath, reaperPath); ownsReaper = true; }
                catch (e) { if (e.code === 'EEXIST') throw new LibraryError('conflict'); throw e; }
                const current = await ownerAt(lockPath);
                if (current) {
                    if (!old || !sameIdentity(current.st, old.st) || current.owner.token !== old.owner.token || !deadPid(current.owner.pid)) throw new LibraryError('conflict');
                    await unlink(lockPath);
                }
                try { await link(ownerPath, lockPath); published = true; }
                catch (e) { if (e.code === 'EEXIST') throw new LibraryError('conflict'); throw e; }
            }
            return { handle: null, st, owner };
        } finally {
            await handle?.close().catch(() => {});
            if (ownsReaper) { try { const now = await lstat(reaperPath); if (!now.isSymbolicLink() && sameIdentity(now, st)) await unlink(reaperPath); } catch { /* Never steal a different guard. */ } }
            if (st) { try { const now = await lstat(ownerPath); if (!now.isSymbolicLink() && sameIdentity(now, st)) await unlink(ownerPath); } catch { /* Unpublished evidence is harmless and never blocks the mutex. */ } }
            if (!published) { /* Only a successfully published owner is returned to the caller. */ }
        }
    }
    return {
        async snapshot() { try { return structuredClone((await read()).state); } catch (e) { throw safeError(e); } },
        async exclusive(fn) {
            let lease;
            try {
                lease = await acquire(); const initial = await read(); let token = initial.token;
                const state = initial.state;
                const save = async () => { token = await publish(structuredClone(state), token); };
                return await fn(state, save);
            } catch (e) { throw safeError(e); }
            finally {
                if (lease) {
                    await lease.handle?.close().catch(() => {});
                    try { const st = await lstat(lockPath); if (st.isFile() && !st.isSymbolicLink() && sameIdentity(st, lease.st) && JSON.parse(await readFile(lockPath, 'utf8')).token === lease.owner.token) await unlink(lockPath); } catch { /* Keep uncertain owner evidence. */ }
                }
            }
        },
    };
}
