// Shared ID-based local library operations. Adapters own reader/session/task admission and network IO.
// Trust boundary: the configured root and ancestor directories stay trusted during IO.
// Node path-based syscalls reject observed links, but do not pin parents against hostile swaps.
import { constants, lstatSync } from 'node:fs';
import { lstat, readdir, mkdir, rmdir, open, link, unlink, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createCatalog } from './paper-catalog.js';
import { canonicalRoot, foldName, validateSegment, resolveCollectionPath, resolvePdfPath, claimKey, collectionClaimKey } from './collection-paths.js';
import { listArtifacts } from './library-manage.js';
import * as defaultMetadata from './paper-metadata.js';
import { createJournal, LibraryError, safeError, sameIdentity, digest, deadPid } from './library-journal.js';
export { LibraryError } from './library-journal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fail = (code = 'invalid') => { throw new LibraryError(code); };
const clone = v => JSON.parse(JSON.stringify(v));
function captureArgs(value) {
    if (!plain(value)) fail();
    const seen = new Set(); let nodes = 0;
    function check(v, depth) {
        if (++nodes > 100000 || depth > 32) fail();
        if (v === null || ['string', 'boolean'].includes(typeof v)) return;
        if (typeof v === 'number') { if (!Number.isFinite(v)) fail(); return; }
        if ((!plain(v) && !Array.isArray(v)) || seen.has(v) || Object.getOwnPropertySymbols(v).length) fail();
        seen.add(v);
        const descriptors = Object.getOwnPropertyDescriptors(v), keys = Object.keys(descriptors);
        if (Array.isArray(v)) {
            if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 10000 || keys.length !== v.length + 1) fail();
            for (let i = 0; i < v.length; i++) { const d = descriptors[i]; if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail(); check(d.value, depth + 1); }
        } else {
            if (keys.length > 10000) fail();
            for (const key of keys) {
                const d = descriptors[key]; if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(d, 'value') || !d.enumerable) fail();
                check(d.value, depth + 1);
            }
        }
        seen.delete(v);
    }
    check(value, 0);
    try { return structuredClone(value); } catch { fail(); }
}
const stable = v => Array.isArray(v) ? v.map(stable) : plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const requestHash = v => digest(JSON.stringify(stable(v)));
function observedStat(st) { return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), type: st.isDirectory() ? 'directory' : 'file' }; }
function capturePolicy(value) {
    const p = captureArgs(value);
    if (Object.keys(p).some(k => !['observedPolicyEpoch', 'observedTranslation'].includes(k)) || !(p.observedPolicyEpoch === null || Number.isSafeInteger(p.observedPolicyEpoch) && p.observedPolicyEpoch > 0)) fail('needs-review');
    const translation = p.observedTranslation ?? null;
    if (translation !== null && (!plain(translation) || Object.keys(translation).some(k => !['collectionId', 'epoch'].includes(k)) || !UUID.test(translation.collectionId) || !Number.isSafeInteger(translation.epoch) || translation.epoch < 1)) fail('needs-review');
    return { observedPolicyEpoch: p.observedPolicyEpoch, observedTranslation: translation };
}
function registrationArgs(args) {
    if (Object.keys(args).some(k => !['observationId', 'segments', 'name', 'expectedStat', 'sourceSignature'].includes(k)) || !UUID.test(args.observationId) || !Array.isArray(args.segments) || !args.segments.length || args.segments.length > 32) fail();
    const paper = Object.hasOwn(args, 'name'), st = args.expectedStat;
    if (!plain(st) || Object.keys(st).sort().join(',') !== 'ctimeNs,dev,ino,mtimeNs,size,type' || st.type !== (paper ? 'file' : 'directory') || !Number.isSafeInteger(st.size) || st.size < 0) fail();
    for (const key of ['dev', 'ino', 'mtimeNs', 'ctimeNs']) if (typeof st[key] !== 'string' || st[key].length > 32 || !(key === 'dev' || key === 'ino' ? /^(0|[1-9]\d*)$/ : /^-?(0|[1-9]\d*)$/).test(st[key])) fail();
    collectionClaimKey(args.segments);
    if (paper ? typeof args.name !== 'string' || !/^[a-f0-9]{64}$/.test(args.sourceSignature) : Object.hasOwn(args, 'sourceSignature')) fail();
    if (args.segments[0] === '.trash' || args.segments[0].startsWith('.dpr-')) fail('needs-review');
    return paper;
}
function activeSubtree(snapshot, collectionId) {
    const ids = new Set(); if (snapshot.collections[collectionId]?.status === 'trashed') return ids;
    ids.add(collectionId); let changed = true;
    while (changed) { changed = false; for (const c of Object.values(snapshot.collections)) if (c.status !== 'trashed' && ids.has(c.parentId) && !ids.has(c.collectionId)) { ids.add(c.collectionId); changed = true; } }
    return ids;
}
const deleteKind = mode => ({ paper: 'delete-paper', 'empty-collection': 'delete-collection', 'clear-collection': 'clear-collection' }[mode]);
function operationId(v) { if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v) || ['constructor', '__proto__', 'prototype'].includes(v)) fail(); return v; }
function entityId(v) { if (typeof v !== 'string' || !UUID.test(v)) fail(); return v; }
function sourceKind(source) { if (!['manual', 'model'].includes(source)) fail(); return source; }
function metadataPatch(args) { const p = { revision: Object.hasOwn(args, 'revision') ? args.revision : args.expectedRevision }; for (const key of ['note', 'summaryText', 'bibliography']) if (Object.hasOwn(args, key)) p[key] = args[key]; return p; }
const infoOf = st => ({ dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), mode: Number(st.mode) & 0o777 });
async function statMaybe(path) { try { return await lstat(path, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function fingerprint(path) {
    const before = await lstat(path, { bigint: true });
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory()) || (before.isFile() && before.nlink !== 1n)) fail('needs-review');
    const value = { ...infoOf(before), type: before.isDirectory() ? 'directory' : 'file' };
    if (before.isFile()) {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            if (!sameIdentity(await handle.stat({ bigint: true }), before)) fail('source-changed');
            const hash = createHash('sha256'), buffer = Buffer.alloc(128 * 1024); let position = 0;
            for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; hash.update(buffer.subarray(0, bytesRead)); }
            if (JSON.stringify(infoOf(await handle.stat({ bigint: true }))) !== JSON.stringify(infoOf(before))) fail('source-changed');
            value.sha256 = hash.digest('hex');
        } finally { await handle.close(); }
    }
    return value;
}
async function noClobberMove(from, to) { await link(from, to); await unlink(from); }

export function createLibraryService(dataDir, options = {}) {
    const root = canonicalRoot(dataDir), physical = infoOf(lstatSync(root, { bigint: true }));
    const catalog = options.catalog || createCatalog(root), metadata = options.metadata || defaultMetadata;
    const journal = createJournal(root), now = options.now || Date.now;
    let initialized = false;
    function checkRoot() { canonicalRoot(root); if (!sameIdentity(infoOf(lstatSync(root, { bigint: true })), physical)) fail('needs-review'); }
    function rel(path) { const value = relative(root, path).split(sep).join('/'); safePath(value); return value; }
    function safePath(value) {
        if (typeof value !== 'string' || isAbsolute(value) || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) fail('needs-review');
        return join(root, ...value.split('/'));
    }
    async function checked(value, allowMissing = false) {
        checkRoot(); const parts = value.split('/'); const absolute = safePath(value); let current = root;
        for (let i = 0; i < parts.length; i++) {
            current = join(current, parts[i]); const st = await statMaybe(current);
            if (!st) { if (allowMissing && i === parts.length - 1) return absolute; fail('not-found'); }
            if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) fail('needs-review');
        }
        return absolute;
    }
    function requireReady() { if (!initialized) fail('not-ready'); checkRoot(); }
    async function available(paperIds = [], collectionIds = []) {
        const state = await journal.snapshot();
        for (const op of Object.values(state.operations)) if (['prepared', 'moving', 'recovering', 'needs-review'].includes(op.status)
            && ((op.paperIds || []).some(id => paperIds.includes(id)) || (op.collectionIds || []).some(id => collectionIds.includes(id)))) fail('needs-review');
    }
    async function leaseFor(paperIds, operation, recovering = false) {
        if (!paperIds.length) return async () => {};
        if (typeof options.prepareReaders !== 'function') fail('reader-busy');
        let lease;
        try { lease = await options.prepareReaders({ paperIds: [...paperIds], operation, ...(recovering ? { recovering: true } : {}) }); } catch { fail('reader-busy'); }
        if (typeof lease === 'function') return lease;
        if (typeof lease?.release === 'function') return result => lease.release(result);
        if (typeof lease?.dispose === 'function') return result => lease.dispose(result);
        fail('reader-busy');
    }
    function replay(snapshot, id, fingerprint) {
        const existing = snapshot.operations[id];
        if (!existing) return null;
        if (existing.requestHash !== fingerprint) fail('conflict');
        return clone(existing.result);
    }
    async function recordCatalogLock(op, save) {
        const lock = await lstat(join(root, '.dpr-paper-catalog.json.lock'), { bigint: true });
        op.catalogLock = infoOf(lock); op.ownerPid = process.pid; await save();
    }
    async function step(op, state, save, action) {
        op.status = 'moving'; op.steps.push({ ...action, phase: 'intent' }); const row = op.steps.at(-1); await save();
        if (row.type === 'mkdir') {
            const path = await checked(row.path, true); await mkdir(path, { mode: row.mode ?? 0o700 }); row.identity = infoOf(await lstat(path, { bigint: true }));
        } else if (row.type === 'move') {
            const from = await checked(row.from), to = await checked(row.to, true);
            if (await statMaybe(to)) fail('target-exists');
            if (!sameIdentity(await lstat(from, { bigint: true }), row.identity)) fail('stale-plan');
            await (options.moveFile || noClobberMove)(from, to);
            if (await statMaybe(from) || !sameIdentity(await lstat(to, { bigint: true }), row.identity)) fail('needs-review');
        } else if (row.type === 'stage-directory' || row.type === 'trash-directory') {
            const from = await checked(row.from), to = await checked(row.to, true);
            if (await statMaybe(to)) fail('target-exists');
            if (!sameIdentity(await lstat(from, { bigint: true }), row.identity)) fail('stale-plan');
            await rename(from, to);
        } else fail('invalid');
        row.phase = 'done'; await save();
        if (options.afterStep) await options.afterStep(clone(row));
    }
    async function undo(op, save, finalize = true) {
        let uncertain = false;
        for (const row of [...op.steps].reverse()) {
            if (row.phase === 'undone') continue;
            try {
                if (row.type === 'move' || row.type === 'stage-directory' || row.type === 'trash-directory') {
                    const from = await checked(row.from, true), to = await checked(row.to, true), a = await statMaybe(from), b = await statMaybe(to);
                    if (a && sameIdentity(a, row.identity)) {
                        if (b && sameIdentity(b, row.identity) && row.type === 'move') await unlink(to);
                        else if (b && row.phase === 'done') fail('needs-review');
                    } else if (!a && b && sameIdentity(b, row.identity)) {
                        if (row.type === 'move') await noClobberMove(to, from); else await rename(to, from);
                    } else fail('needs-review');
                } else if (row.type === 'mkdir') {
                    const path = await checked(row.path, true), st = await statMaybe(path);
                    if (st) { if (!row.identity || !sameIdentity(st, row.identity)) fail('needs-review'); await rmdir(path); }
                } else if (row.type === 'created-file') {
                    const path = await checked(row.path, true), st = await statMaybe(path);
                    if (st) { if (!row.identity || !sameIdentity(st, row.identity)) fail('needs-review'); await unlink(path); }
                }
                row.phase = 'undone'; await save();
            } catch { uncertain = true; }
        }
        op.status = uncertain ? 'needs-review' : finalize ? 'rolled-back' : 'recovering'; await save();
        return !uncertain;
    }
    async function execute(state, save, { id, fingerprint, kind, intent, entityId: targetEntityId = null, paperIds = [], collectionIds = [], mutate }) {
        const before = catalog.snapshot(), prior = replay(before, id, fingerprint); if (prior) return { result: prior, fresh: false };
        if (state.operations[id]) fail(state.operations[id].requestHash === fingerprint ? 'needs-review' : 'conflict');
        const op = { operationId: id, generation: randomUUID(), intent: clone(intent), requestHash: fingerprint, kind, entityId: targetEntityId, paperIds, collectionIds, status: 'prepared', ownerPid: process.pid, steps: [], createdAt: now() };
        state.operations[id] = op; await save(); let result, authorizationFailure;
        function checkMutationAuthority() {
            if (options.authorizeMutation === undefined) return;
            let approved = false;
            try { approved = typeof options.authorizeMutation === 'function' && options.authorizeMutation({ operationId: id, kind, paperIds: [...paperIds], collectionIds: [...collectionIds] }) === true; } catch { /* Fail closed with a sanitized domain error. */ }
            if (!approved) { authorizationFailure = new LibraryError('reader-busy'); throw authorizationFailure; }
        }
        try {
            await catalog.transact(before.revision, async draft => {
                await recordCatalogLock(op, save);
                checkMutationAuthority();
                result = await mutate(draft, op);
                op.post = { state: 'pending', ownerPid: process.pid, metadata: (result._metadataTasks || []).map(task => ({ ...task, state: 'pending' })), events: (result.events || []).map(event => ({ event, state: 'pending' })) };
                delete result._metadataTasks;
                result.receipt.postCommit = { metadata: op.post.metadata.length ? 'pending' : 'done', events: op.post.events.length ? 'pending' : 'done' };
                op.result = clone(result); await save();
                checkMutationAuthority();
                draft.operations[id] = { requestHash: fingerprint, result: clone(result) };
            });
            op.status = 'committed'; op.result = clone(result); await save();
            return { result, fresh: true };
        } catch (error) {
            let current;
            try { current = catalog.snapshot(); } catch { op.status = 'needs-review'; await save(); fail('needs-review'); }
            const committed = replay(current, id, fingerprint);
            if (committed) { op.status = 'committed'; op.result = committed; await save(); return { result: committed, fresh: true }; }
            if (!await undo(op, save)) fail('needs-review');
            throw safeError(authorizationFailure || error);
        }
    }
    async function recordResult(id, fingerprint, result) {
        await journal.exclusive(async (state, save) => {
            const snapshot = catalog.snapshot();
            await catalog.transact(snapshot.revision, async draft => {
                if (draft.operations[id]?.requestHash !== fingerprint) fail('conflict');
                if (state.operations[id]) await recordCatalogLock(state.operations[id], save);
                draft.operations[id].result = clone(result);
            });
            if (state.operations[id]) state.operations[id].result = clone(result);
            await save();
        });
    }
    async function postCommit(outcome, id, fingerprint, recovering = false) {
        if (!outcome.fresh) { const result = clone(outcome.result); delete result.cleanup; return result; }
        const result = clone(outcome.result); result.receipt.warnings ||= [];
        const update = async fn => journal.exclusive(async (state, save) => {
            const op = state.operations[id]; if (!op || op.requestHash !== fingerprint || op.status !== 'committed' || !op.post) fail('needs-review');
            const value = await fn(op); await save(); return value;
        });
        let post = await update(op => {
            if (recovering && !deadPid(op.post.ownerPid)) return null;
            if (recovering) for (const item of op.post.events) if (item.state === 'dispatching') item.state = 'unknown';
            op.post.ownerPid = process.pid; op.post.state = 'running'; return clone(op.post);
        });
        if (!post) { delete result.cleanup; return result; }
        const allowed = new Set([result.entity?.paperId, result.entity?.collectionId, ...(result.results || []).filter(r => r.created).map(r => r.paperId)]);
        for (let i = 0; i < post.metadata.length; i++) {
            const task = post.metadata[i]; if (task.state === 'done' || task.state === 'failed') continue;
            if (!allowed.has(task.id) || !['paper', 'collection'].includes(task.kind) || !['manual', 'model'].includes(task.source)) fail('journal-invalid');
            await update(op => { op.post.metadata[i].state = 'dispatching'; });
            let success = false;
            try {
                const current = task.kind === 'paper' ? await metadata.readPaperMetadata(root, task.id) : await metadata.readCollectionMetadata(root, task.id);
                const matches = task.kind === 'collection' ? current.note === task.patch.note && current.revision !== null
                    : (!Object.hasOwn(task.patch, 'summaryText') || current.summary.text === task.patch.summaryText && current.summary.source === task.source)
                      && (!Object.hasOwn(task.patch, 'bibliography') || requestHash(current.bibliography) === requestHash(task.patch.bibliography)) && current.revision !== null;
                if (!matches) {
                    if (task.kind === 'paper') await metadata.writePaperMetadata(root, task.id, task.patch, task.source);
                    else await metadata.writeCollectionMetadata(root, task.id, task.patch, task.source);
                }
                success = true;
            } catch { result.receipt.warnings.push('metadata-needs-review'); }
            await update(op => { op.post.metadata[i].state = success ? 'done' : 'failed'; });
        }
        post = await update(op => clone(op.post));
        const metadataOk = post.metadata.every(task => task.state === 'done');
        for (let i = 0; i < post.events.length; i++) {
            const item = post.events[i];
            if (item.state === 'unknown' || item.state === 'failed') { result.receipt.warnings.push('event-delivery-unknown'); continue; }
            if (item.state === 'done') continue;
            if (!metadataOk) { result.receipt.warnings.push('ingest-held-for-metadata'); continue; }
            const expected = (result.events || []).find(e => e.eventId === item.event.eventId);
            if (!expected || requestHash(expected) !== requestHash(item.event)) fail('journal-invalid');
            await update(op => { op.post.events[i].state = 'dispatching'; });
            let success = false;
            try {
                if (item.event.type === 'ingest' && options.onIngest) await options.onIngest(clone(item.event));
                else if (item.event.type !== 'ingest' && options.onCommitted) await options.onCommitted(clone(item.event));
                success = true;
            } catch { result.receipt.warnings.push('event-delivery-unknown'); }
            await update(op => { op.post.events[i].state = success ? 'done' : 'unknown'; });
        }
        if (result.cleanup) {
            for (const path of [...result.cleanup].sort((a, b) => b.length - a.length)) {
                try { await rmdir(await checked(path)); } catch (e) { if (e.code !== 'not-found') result.receipt.warnings.push('cleanup-needs-review'); }
            }
            delete result.cleanup;
        }
        post = await update(op => {
            op.post.state = op.post.metadata.every(t => t.state === 'done') && op.post.events.every(e => e.state === 'done') ? 'done' : 'needs-review';
            return clone(op.post);
        });
        result.receipt.postCommit = { metadata: post.metadata.every(t => t.state === 'done') ? 'done' : 'failed', events: post.events.every(e => e.state === 'done') ? 'done' : 'needs-review' };
        result.receipt.warnings = [...new Set(result.receipt.warnings)];
        try { await recordResult(id, fingerprint, result); } catch { result.receipt.warnings.push('post-commit-unconfirmed'); }
        return result;
    }
    async function walkDirectory(dir, targetDir) {
        const files = [], dirs = [];
        async function visit(path, target) {
            const identity = await fingerprint(path); dirs.push({ from: rel(path), to: rel(target), identity });
            for (const name of (await readdir(path)).sort()) {
                const from = join(path, name), to = join(target, name), st = await lstat(from);
                if (st.isSymbolicLink()) fail('needs-review');
                if (st.isDirectory()) await visit(from, to);
                else if (st.isFile()) files.push({ from: rel(from), to: rel(to), identity: await fingerprint(from), kind: 'file' });
                else fail('needs-review');
            }
        }
        await visit(dir, targetDir); return { files, dirs };
    }
    function registrationTarget(state, args, create = false) {
        let parent = null;
        for (let i = 1; i <= args.segments.length; i++) {
            const prefix = args.segments.slice(0, i), key = collectionClaimKey(prefix), owners = state.collectionClaims?.[key] || [];
            const current = Object.values(state.collections).filter(c => c.status !== 'trashed' && collectionClaimKey(c.segments) === key);
            if (owners.length > 1 || current.length > 1 || owners.length && (!current.length || owners[0] !== current[0].collectionId)) fail('needs-review');
            if (current.length) parent = current[0];
            else {
                try { validateSegment(prefix.at(-1)); } catch { fail('needs-review'); }
                if (create) {
                    const collectionId = randomUUID(), segments = [...(parent?.segments || []), prefix.at(-1)];
                    parent = { collectionId, parentId: parent?.collectionId || null, name: prefix.at(-1), segments, revision: 1, note: '' }; state.collections[collectionId] = parent;
                } else parent = { collectionId: null, segments: prefix };
            }
        }
        if (!Object.hasOwn(args, 'name')) return { parent, entity: parent.collectionId ? parent : null };
        const key = claimKey(args.segments, args.name), owners = state.claims[key] || [];
        const current = Object.values(state.papers).filter(p => p.status === 'active' && claimKey(p.segments, p.name) === key);
        if (owners.length > 1 || current.length > 1 || owners.length && (!current.length || owners[0] !== current[0].paperId)) fail('needs-review');
        if (!current.length) { try { validateSegment(args.name); if (/-(?:en|zh|dual)$/i.test(args.name)) fail(); } catch { fail('needs-review'); } }
        return { parent, entity: current[0] || null };
    }
    async function verifyObservation(args) {
        const paper = Object.hasOwn(args, 'name'), path = paper ? resolvePdfPath(root, args.segments, args.name) : resolveCollectionPath(root, args.segments);
        const before = await lstat(path, { bigint: true });
        if (before.isSymbolicLink() || (paper ? !before.isFile() || before.nlink !== 1n : !before.isDirectory())) fail('needs-review');
        if (paper && Number(before.size) > (options.maxPdfBytes || 512 * 1024 * 1024)) fail('too-large');
        if (paper && before.size < 100n) fail('pdf-invalid');
        if (requestHash(observedStat(before)) !== requestHash(args.expectedStat)) fail('source-changed');
        if (paper) {
            const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try { const head = Buffer.alloc(8), { bytesRead } = await handle.read(head, 0, 8, 0); if (bytesRead < 8 || !/^%PDF-\d\.\d/.test(head.toString('ascii'))) fail('pdf-invalid'); }
            finally { await handle.close(); }
            if ((await fingerprint(path)).sha256 !== args.sourceSignature) fail('source-changed');
        }
        if (requestHash(observedStat(await lstat(path, { bigint: true }))) !== requestHash(args.expectedStat)) fail('source-changed');
        return path;
    }
    function existingEligibility(state, paperId, sourceSignature) {
        for (const op of Object.values(state.operations)) for (const event of op.result?.events || []) {
            if (event.type !== 'ingest' || event.paperId !== paperId || event.sourceSignature !== sourceSignature || !Object.hasOwn(event, 'observedPolicyEpoch')) continue;
            try { return capturePolicy({ observedPolicyEpoch: event.observedPolicyEpoch, observedTranslation: event.observedTranslation ?? null }); } catch { return null; }
        }
        return null;
    }
    async function paperInventory(entity) {
        const dir = dirname(entity.pdfPath), base = basename(entity.pdfPath).slice(0, -4), files = [];
        for (const row of listArtifacts(dir, base)) {
            if (row.symlink) fail('needs-review');
            const from = join(dir, row.name); files.push({ from: rel(from), identity: await fingerprint(from), kind: row.kind });
        }
        if (!files.some(file => file.from === rel(entity.pdfPath))) files.push({ from: rel(entity.pdfPath), identity: await fingerprint(entity.pdfPath), kind: 'pdf' });
        const health = join(dir, '.dpr-health', digest(base) + '.json');
        if (await statMaybe(health)) files.push({ from: rel(health), identity: await fingerprint(await checked(rel(health))), kind: 'health' });
        return { base, files };
    }
    async function makePlan(args, persist = true) {
        const snapshot = catalog.snapshot();
        const kind = args.paperId ? 'paper' : 'collection', id = entityId(args.paperId || args.collectionId);
        const entity = kind === 'paper' ? catalog.resolvePaper({ paperId: id }) : catalog.resolveCollection({ collectionId: id });
        validateSegment(args.name); if (kind === 'paper' && /-(?:en|zh|dual)$/i.test(args.name)) fail();
        const expected = args.expectedLocationRevision ?? args.expectedRevision;
        if (expected !== undefined && expected !== (kind === 'paper' ? entity.locationRevision : entity.revision)) fail('conflict');
        if (entity.name === args.name) fail();
        const subtree = kind === 'collection' ? activeSubtree(snapshot, id) : new Set();
        const paperIds = kind === 'paper' ? [id] : Object.values(snapshot.papers).filter(p => p.status === 'active' && subtree.has(p.collectionId)).map(p => p.paperId);
        const collectionIds = [...subtree];
        await available(paperIds, collectionIds);
        let files, dirs = [], unknownFiles = [], fromDir, toDir;
        if (kind === 'paper') {
            const { base, files: inventory } = await paperInventory(entity);
            files = inventory.map(file => ({ ...file, to: rel(join(dirname(safePath(file.from)), file.kind === 'health' ? digest(args.name) + '.json' : args.name + basename(file.from).slice(base.length))) }));
        } else {
            fromDir = rel(entity.dirPath); toDir = rel(join(dirname(entity.dirPath), args.name));
            ({ files, dirs } = await walkDirectory(entity.dirPath, safePath(toDir)));
            const known = new Set();
            for (const p of Object.values(snapshot.papers).filter(p => p.status === 'active' && subtree.has(p.collectionId))) {
                const dir = resolveCollectionPath(root, p.segments); for (const artifact of listArtifacts(dir, p.name)) known.add(rel(join(dir, artifact.name)));
            }
            unknownFiles = files.filter(f => !known.has(f.from)).map(f => f.from);
        }
        const conflicts = [];
        const targets = kind === 'paper' ? files : [{ from: fromDir, to: toDir, identity: dirs[0].identity }];
        for (const row of targets) {
            const to = safePath(row.to), names = await readdir(dirname(to));
            const matches = names.filter(n => foldName(n) === foldName(basename(to)));
            for (const name of matches) {
                const candidate = await lstat(join(dirname(to), name), { bigint: true });
                if (!sameIdentity(candidate, row.identity)) conflicts.push(row.to);
            }
        }
        const sourceRevision = requestHash({ files, dirs });
        const plan = { planId: randomUUID(), kind, entityId: id, newName: args.name, oldName: entity.name, oldSegments: entity.segments, expectedLocationRevision: kind === 'paper' ? entity.locationRevision : entity.revision,
            catalogRevision: snapshot.revision, sourceRevision, paperIds, collectionIds, files, dirs, fromDir: fromDir || null, toDir: toDir || null, unknownFiles,
            affectedFiles: files.map(f => `${f.from} → ${f.to}`), conflicts, sessionEffects: paperIds.map(p => `文献 ${p}：需阅读器、会话及翻译任务安全释放`), expiresAt: now() + 5 * 60 * 1000 };
        if (persist) await journal.exclusive(async (state, save) => { state.plans[plan.planId] = plan; await save(); });
        return plan;
    }
    async function makeDeletePlan(args, persist = true, planId = randomUUID()) {
        const mode = args.mode, operation = deleteKind(mode); if (!operation) fail();
        const snapshot = catalog.snapshot(), isPaper = mode === 'paper';
        if (isPaper ? args.collectionId !== undefined : args.paperId !== undefined) fail();
        const id = entityId(isPaper ? args.paperId : args.collectionId);
        const entity = isPaper ? catalog.resolvePaper({ paperId: id }) : catalog.resolveCollection({ collectionId: id });
        if (Object.hasOwn(args, 'expectedLocationRevision') && (!Number.isSafeInteger(args.expectedLocationRevision) || args.expectedLocationRevision < 1)) fail();
        const version = isPaper ? entity.locationRevision : entity.revision;
        if (args.expectedLocationRevision !== undefined && args.expectedLocationRevision !== version) fail('conflict');
        const paperIds = isPaper ? [id] : Object.values(snapshot.papers).filter(p => p.status === 'active' && p.collectionId === id).map(p => p.paperId), collectionIds = isPaper ? [] : [id];
        await available(paperIds, collectionIds);
        const trashRel = '.trash/' + planId, container = trashRel + '/' + id, conflicts = [], movedHidden = [];
        let files = [], dirs = [], fromDir = null, toDir = null;
        if (isPaper) {
            const inventory = await paperInventory(entity);
            files = inventory.files.map(file => ({ ...file, to: container + (file.kind === 'health' ? '/.dpr-health/' : '/') + basename(file.from) }));
        } else {
            fromDir = rel(entity.dirPath); toDir = container;
            if (Object.values(snapshot.collections).some(c => c.status !== 'trashed' && c.parentId === id)) conflicts.push('库内仍有子库，删除与清空均不递归');
            if (mode === 'empty-collection' && Object.values(snapshot.papers).some(p => p.status === 'active' && p.collectionId === id)) conflicts.push('库内仍有活跃文献，空库删除已拒绝');
            const known = new Set();
            for (const p of Object.values(snapshot.papers).filter(p => p.status === 'active' && p.collectionId === id)) {
                try { for (const file of (await paperInventory(catalog.resolvePaper({ paperId: p.paperId }))).files) known.add(file.from); }
                catch { conflicts.push(`文献 ${p.name} 的源文件需要核对`); }
            }
            for (const name of (await readdir(entity.dirPath)).sort()) {
                const path = join(entity.dirPath, name), st = await lstat(path);
                if (st.isSymbolicLink()) { conflicts.push(`链接条目需人工处理：${name}`); continue; }
                if (name.startsWith('.')) { movedHidden.push(name); continue; }
                if (mode === 'empty-collection' || st.isDirectory() || !known.has(rel(path))) conflicts.push(`保留可见条目：${name}`);
            }
            if (!conflicts.length) {
                try { ({ files, dirs } = await walkDirectory(entity.dirPath, safePath(toDir))); }
                catch (e) { if (e?.code === 'needs-review') conflicts.push('库内含链接或无法确认归属的条目'); else throw e; }
            }
        }
        const publicEntity = { ...clone(entity) }; for (const key of ['pdfPath', 'txtPath', 'pagesPath', 'transcriptPath', 'mineruMdPath', 'mineruJsonPath', 'dirPath']) delete publicEntity[key];
        const plan = { kind: 'delete', mode, planId, entityKind: isPaper ? 'paper' : 'collection', entityId: id, entity: publicEntity, oldName: entity.name, oldSegments: entity.segments,
            paperIds, collectionIds, files, dirs, fromDir, toDir, trashRoot: '.trash', trashRel, expectedLocationRevision: version, catalogRevision: snapshot.revision,
            sourceRevision: requestHash({ files, dirs }), affectedFiles: files.map(f => `${f.from} → ${f.to}`), conflicts: [...new Set(conflicts)],
            sessionEffects: paperIds.map(pid => `文献 ${pid}：需阅读器、会话及任务安全释放，完成后只读回收状态`), totalBytes: files.reduce((n, f) => n + f.identity.size, 0),
            paperCount: isPaper ? 1 : Object.values(snapshot.papers).filter(p => p.status === 'active' && p.collectionId === id).length, movedHidden, expiresAt: now() + 5 * 60 * 1000 };
        if (persist) await journal.exclusive(async (state, save) => { state.plans[planId] = plan; await save(); });
        return plan;
    }
    function publicDeletePlan(plan) { const { files, dirs, fromDir, toDir, ...value } = plan; return clone({ ...value, sourceFiles: files.map(file => file.from), hidden: [...plan.movedHidden] }); }
    function publicPlan(plan) {
        const { files, dirs, fromDir, toDir, paperIds, collectionIds, ...value } = plan;
        return clone(value);
    }
    function checkRecoveryIdentity(op, snapshot) {
        if (snapshot.operations[op.operationId]?.requestHash === op.requestHash) return;
        const equalIds = (a, b) => requestHash([...a].sort()) === requestHash([...b].sort());
        if (op.kind === 'rename') {
            const plan = op.intent.plan, entity = (plan.kind === 'paper' ? snapshot.papers : snapshot.collections)[plan.entityId];
            if (!entity || entity.name !== plan.oldName || requestHash(entity.segments) !== requestHash(plan.oldSegments)) fail('journal-invalid');
            const subtree = plan.kind === 'paper' ? new Set() : activeSubtree(snapshot, entity.collectionId);
            const papers = plan.kind === 'paper' ? [entity.paperId] : Object.values(snapshot.papers).filter(p => p.status === 'active' && subtree.has(p.collectionId)).map(p => p.paperId);
            const collections = [...subtree];
            if (!equalIds(papers, op.paperIds) || !equalIds(collections, op.collectionIds)) fail('journal-invalid');
        } else if (['delete-paper', 'delete-collection', 'clear-collection'].includes(op.kind)) {
            const plan = op.intent.plan, entity = (plan.entityKind === 'paper' ? snapshot.papers : snapshot.collections)[plan.entityId];
            if (!entity || entity.status === 'trashed' || entity.name !== plan.oldName || requestHash(entity.segments) !== requestHash(plan.oldSegments)) fail('journal-invalid');
            const paperIds = plan.mode === 'paper' ? [entity.paperId] : Object.values(snapshot.papers).filter(p => p.status === 'active' && p.collectionId === entity.collectionId).map(p => p.paperId);
            const collectionIds = plan.mode === 'paper' ? [] : [entity.collectionId];
            if (!equalIds(paperIds, op.paperIds) || !equalIds(collectionIds, op.collectionIds)) fail('journal-invalid');
        } else if (op.kind === 'import') {
            const collection = snapshot.collections[op.intent.collectionId];
            if (!collection || requestHash(collection.segments) !== requestHash(op.intent.segments) || op.paperIds.length || !equalIds([collection.collectionId], op.collectionIds)) fail('journal-invalid');
            const occupied = new Set(Object.values(snapshot.papers).filter(p => p.status === 'active').map(p => [...p.segments, p.name + '.pdf'].join('/').toLowerCase()));
            if (op.steps.some(step => step.type === 'move' && occupied.has(step.to.toLowerCase()))) fail('journal-invalid');
        } else if (op.kind === 'createCollection') {
            if (Object.values(snapshot.collections).some(c => c.status !== 'trashed' && requestHash(c.segments) === requestHash(op.intent.segments))) fail('journal-invalid');
        }
    }
    const service = {
        async initialize() {
            const state = await journal.snapshot();
            if (Object.keys(state.operations).length && !await statMaybe(join(root, '.dpr-paper-catalog.json'))) fail('needs-review');
            await catalog.initializeBaseline(); initialized = true;
            await service.recover();
            return { ready: true, needsReview: Object.values((await journal.snapshot()).operations).filter(op => ['prepared', 'moving', 'recovering', 'needs-review'].includes(op.status) || op.post?.state === 'needs-review').map(op => op.operationId) };
        },
        async recover() {
            const initial = await journal.snapshot();
            for (const candidate of Object.values(initial.operations)) {
                const active = ['prepared', 'moving', 'recovering', 'needs-review'].includes(candidate.status);
                const lock = await statMaybe(join(root, '.dpr-paper-catalog.json.lock'));
                const staleOwnLock = lock && candidate.catalogLock && sameIdentity(lock, candidate.catalogLock) && deadPid(candidate.ownerPid);
                const pendingPost = candidate.status === 'committed' && candidate.post && candidate.post.state !== 'done' && deadPid(candidate.post.ownerPid);
                if (!active && !staleOwnLock && !pendingPost) continue;
                const recoverySnapshot = catalog.snapshot(), committed = recoverySnapshot.operations[candidate.operationId]?.requestHash === candidate.requestHash;
                checkRecoveryIdentity(candidate, recoverySnapshot);
                let release;
                // A proven commit has no filesystem undo left; its retired IDs may already be 410.
                try { release = active && !committed ? await leaseFor(candidate.paperIds || [], { type: ['delete-paper', 'delete-collection', 'clear-collection'].includes(candidate.kind) ? candidate.kind : candidate.intent?.plan?.kind === 'collection' ? 'rename-collection' : 'rename-paper', operationId: candidate.operationId }, true) : async () => {}; }
                catch { continue; }
                try {
                    await journal.exclusive(async (state, save) => {
                        const op = state.operations[candidate.operationId]; if (!op) return;
                        if (op.generation !== candidate.generation || op.requestHash !== candidate.requestHash || requestHash(op.paperIds) !== requestHash(candidate.paperIds) || requestHash(op.collectionIds) !== requestHash(candidate.collectionIds)) fail('conflict');
                        const lockPath = join(root, '.dpr-paper-catalog.json.lock'), held = await statMaybe(lockPath);
                        if (held) {
                            if (!deadPid(op.ownerPid) || !op.catalogLock || !sameIdentity(held, op.catalogLock)) { if (active) { op.status = 'needs-review'; await save(); } return; }
                            await unlink(lockPath);
                        }
                        const snapshot = catalog.snapshot();
                        checkRecoveryIdentity(op, snapshot);
                        if (snapshot.operations[op.operationId]?.requestHash === op.requestHash) { op.status = 'committed'; op.result = snapshot.operations[op.operationId].result; await save(); return; }
                        if (!active) return;
                        let restored = false;
                        await catalog.transact(snapshot.revision, async () => { await recordCatalogLock(op, save); restored = await undo(op, save, false); });
                        op.status = restored ? 'rolled-back' : 'needs-review'; await save();
                    });
                } finally { try { await release?.({ entityId: candidate.entityId || candidate.paperIds?.[0] || candidate.collectionIds?.[0], operationId: candidate.operationId }); } catch { /* Host can retry its compact resume ACK. */ } }
                const latest = (await journal.snapshot()).operations[candidate.operationId];
                if (latest?.status === 'committed' && latest.post?.state !== 'done' && deadPid(latest.post?.ownerPid)) {
                    await postCommit({ fresh: true, result: catalog.snapshot().operations[candidate.operationId].result }, candidate.operationId, candidate.requestHash, true);
                }
            }
        },
        async registerExisting(args, opaqueProof) {
            args = captureArgs(args); requireReady(); const paper = registrationArgs(args), id = 'discover-' + digest(args.observationId), fingerprint = requestHash({ kind: 'register-existing', ...args });
            const prior = replay(catalog.snapshot(), id, fingerprint); if (prior) return prior;
            let qualification;
            try {
                if (typeof options.authorizeDiscovery !== 'function') fail('needs-review');
                const authorized = options.authorizeDiscovery(opaqueProof, clone(args));
                if (authorized && typeof authorized.then === 'function') { Promise.resolve(authorized).catch(() => {}); fail('needs-review'); }
                const value = captureArgs(authorized);
                if (!['baseline', 'live'].includes(value.classification) || Object.keys(value).some(k => !['classification', 'observedPolicyEpoch', 'observedTranslation'].includes(k))) fail('needs-review');
                const policy = capturePolicy({ observedPolicyEpoch: value.observedPolicyEpoch, observedTranslation: value.observedTranslation ?? null });
                qualification = { classification: value.classification, ...(value.classification === 'baseline' ? { observedPolicyEpoch: null, observedTranslation: null } : policy) };
            } catch { fail('needs-review'); }
            registrationTarget(catalog.snapshot(), args); await verifyObservation(args);
            const outcome = await journal.exclusive(async (state, save) => {
                const latest = catalog.snapshot(), repeated = replay(latest, id, fingerprint); if (repeated) return { result: repeated, fresh: false };
                registrationTarget(latest, args);
                return execute(state, save, { id, fingerprint, kind: 'register-existing', intent: { args, qualification }, mutate: async draft => {
                    await verifyObservation(args);
                    const target = registrationTarget(draft, args, true); let entity = target.entity, created = !entity;
                    if (paper && created) {
                        const paperId = randomUUID(), ingestSeq = qualification.classification === 'live' ? ++draft.ingestSeq : 0;
                        entity = { paperId, collectionId: target.parent.collectionId, name: args.name, segments: [...target.parent.segments], locationRevision: 1, status: 'active', origin: ingestSeq ? 'import' : 'baseline', ingestSeq };
                        draft.papers[paperId] = entity;
                    }
                    if (!paper) { entity = target.parent; created = !Object.values(latest.collections).some(c => c.collectionId === entity.collectionId); }
                    const eligibility = !paper ? null : created ? qualification.classification === 'live' ? { observedPolicyEpoch: qualification.observedPolicyEpoch, observedTranslation: qualification.observedTranslation?.collectionId === entity.collectionId ? qualification.observedTranslation : null } : null : existingEligibility(draft, entity.paperId, args.sourceSignature);
                    const events = paper && created && entity.origin === 'import' ? [{ type: 'ingest', eventId: digest(id + ':0'), paperId: entity.paperId, collectionId: entity.collectionId, ingestSeq: entity.ingestSeq, origin: 'import', sourceSignature: args.sourceSignature, observationId: args.observationId, ...eligibility }] : [];
                    return { created, entity: clone(entity), sourceSignature: paper ? args.sourceSignature : null, eligibility, events,
                        receipt: { operationId: id, kind: 'register-existing', observationId: args.observationId, status: 'committed', entityId: entity.paperId || entity.collectionId, created, classification: created || !paper ? qualification.classification : entity.origin === 'baseline' ? 'baseline' : 'live', eligibility, warnings: [] } };
                } });
            });
            return postCommit(outcome, id, fingerprint);
        },
        async listTree() {
            requireReady(); const snapshot = catalog.snapshot(), papers = Object.values(snapshot.papers).filter(p => p.status === 'active'), collections = [];
            for (const c of Object.values(snapshot.collections).filter(c => c.status !== 'trashed')) {
                const m = await metadata.readCollectionMetadata(root, c.collectionId);
                collections.push({ ...c, note: m.revision === null ? c.note : m.note, papers: papers.filter(p => p.collectionId === c.collectionId), children: Object.values(snapshot.collections).filter(child => child.status !== 'trashed' && child.parentId === c.collectionId).map(child => child.collectionId) });
            }
            return { revision: snapshot.revision, collections, papers };
        },
        async withPaperWrite(args = {}, fn) {
            const { paperId } = captureArgs(args);
            requireReady(); entityId(paperId); if (typeof fn !== 'function') fail();
            // Short local IO only. Runtime rechecks Gate at fn's first line; no UI/network
            // or nested service mutation while this shared rename/root mutex is held.
            return journal.exclusive(async () => {
                await available([paperId]);
                const ref = catalog.resolvePaper({ paperId });
                return await fn(ref);
            });
        },
        async getDetails(args) {
            args = captureArgs(args);
            requireReady();
            if (args.paperId) { entityId(args.paperId); await available([args.paperId]); return { kind: 'paper', entity: catalog.resolvePaper({ paperId: args.paperId }), metadata: await metadata.readPaperMetadata(root, args.paperId) }; }
            entityId(args.collectionId); await available([], [args.collectionId]);
            const entity = catalog.resolveCollection({ collectionId: args.collectionId }), m = await metadata.readCollectionMetadata(root, args.collectionId);
            return { kind: 'collection', entity, metadata: m.revision === null && entity.note ? { ...m, note: entity.note } : m };
        },
        async updateDetails(args, trustedSource = 'manual') {
            args = captureArgs(args);
            requireReady(); sourceKind(trustedSource); const details = await service.getDetails(args), patch = metadataPatch(args);
            const result = details.kind === 'paper' ? await metadata.writePaperMetadata(root, details.entity.paperId, patch, trustedSource) : await metadata.writeCollectionMetadata(root, details.entity.collectionId, patch, trustedSource);
            return { metadata: result };
        },
        async createCollection(args, trustedSource = 'manual') {
            args = captureArgs(args);
            requireReady(); sourceKind(trustedSource); validateSegment(args.name); const id = operationId(args.operationId), fingerprint = requestHash({ kind: 'createCollection', ...args, trustedSource });
            const outcome = await journal.exclusive(async (state, save) => {
                const prior = replay(catalog.snapshot(), id, fingerprint); if (prior) return { result: prior, fresh: false };
                const parent = args.parentId ? catalog.resolveCollection({ collectionId: entityId(args.parentId) }) : null;
                const segments = [...(parent?.segments || []), args.name], target = join(root, ...segments);
                const parentPath = parent ? parent.dirPath : root;
                if ((await readdir(parentPath)).some(n => foldName(n) === foldName(args.name))) fail('target-exists');
                return execute(state, save, { id, fingerprint, kind: 'createCollection', intent: { segments }, collectionIds: parent ? [parent.collectionId] : [], mutate: async (draft, op) => {
                    await step(op, state, save, { type: 'mkdir', path: rel(target) }); const collectionId = randomUUID();
                    draft.collections[collectionId] = { collectionId, parentId: args.parentId || null, name: args.name, segments, revision: 1, note: args.note || '' };
                    return { entity: clone(draft.collections[collectionId]), events: [], _metadataTasks: args.note === undefined ? [] : [{ kind: 'collection', id: collectionId, patch: { revision: null, note: args.note }, source: trustedSource }], receipt: { operationId: id, kind: 'createCollection', status: 'committed', entityId: collectionId, warnings: [] } };
                } });
            });
            return postCommit(outcome, id, fingerprint);
        },
        async updateCollection(args, trustedSource = 'manual') {
            args = captureArgs(args);
            requireReady(); entityId(args.collectionId);
            if (args.name !== undefined) { if (args.note !== undefined) fail(); return { plan: await service.planRename(args), requiresConfirmation: true }; }
            return service.updateDetails(args, trustedSource);
        },
        async planDelete(args) { args = captureArgs(args); requireReady(); return publicDeletePlan(await makeDeletePlan(args)); },
        async applyDelete(args) {
            args = captureArgs(args); requireReady(); const id = operationId(args.operationId), fingerprint = requestHash({ kind: 'delete', planId: args.planId });
            const prior = replay(catalog.snapshot(), id, fingerprint); if (prior) return prior;
            const stored = (await journal.snapshot()).plans[args.planId]; if (!stored || stored.kind !== 'delete') fail('stale-plan');
            if (stored.conflicts.length) fail('conflict');
            if (requestHash({ files: stored.files, dirs: stored.dirs }) !== stored.sourceRevision) fail('needs-review');
            if (!Number.isSafeInteger(stored.expiresAt) || now() > stored.expiresAt) fail('stale-plan');
            const locator = { [stored.mode === 'paper' ? 'paperId' : 'collectionId']: stored.entityId, mode: stored.mode, expectedLocationRevision: stored.expectedLocationRevision };
            const canonical = await makeDeletePlan(locator, false, stored.planId);
            if (canonical.conflicts.length) fail('conflict');
            if (canonical.sourceRevision !== stored.sourceRevision) fail('stale-plan');
            const plan = { ...canonical, catalogRevision: stored.catalogRevision, expiresAt: stored.expiresAt };
            await checked(plan.trashRel, true).catch(e => { if (e.code !== 'not-found') throw e; });
            if (await statMaybe(safePath(plan.trashRel))) fail('target-exists');
            const release = await leaseFor(plan.paperIds, { operationId: id, type: deleteKind(plan.mode) }); let outcome;
            try {
                outcome = await journal.exclusive(async (state, save) => {
                    const latest = catalog.snapshot(), repeated = replay(latest, id, fingerprint); if (repeated) return { result: repeated, fresh: false };
                    if (latest.revision !== plan.catalogRevision) fail('stale-plan');
                    const fresh = await makeDeletePlan(locator, false, plan.planId);
                    if (fresh.conflicts.length || fresh.sourceRevision !== plan.sourceRevision) fail('stale-plan');
                    if (await statMaybe(safePath(plan.trashRel))) fail('target-exists');
                    return execute(state, save, { id, fingerprint, kind: deleteKind(plan.mode), entityId: plan.entityId, intent: { plan }, paperIds: plan.paperIds, collectionIds: plan.collectionIds, mutate: async (draft, op) => {
                        const trash = await statMaybe(safePath('.trash'));
                        if (trash) { if (!trash.isDirectory() || trash.isSymbolicLink()) fail('needs-review'); }
                        else await step(op, state, save, { type: 'mkdir', path: '.trash' });
                        await step(op, state, save, { type: 'mkdir', path: plan.trashRel });
                        if (plan.mode === 'paper') {
                            const container = plan.trashRel + '/' + plan.entityId;
                            await step(op, state, save, { type: 'mkdir', path: container });
                            if (plan.files.some(f => f.kind === 'health')) await step(op, state, save, { type: 'mkdir', path: container + '/.dpr-health' });
                            for (const file of plan.files) await step(op, state, save, { type: 'move', from: file.from, to: file.to, identity: file.identity });
                            draft.papers[plan.entityId].status = 'trashed';
                        } else {
                            await step(op, state, save, { type: 'trash-directory', from: plan.fromDir, to: plan.toDir, identity: plan.dirs[0].identity });
                            for (const p of Object.values(draft.papers)) if (p.collectionId === plan.entityId && p.status !== 'trashed') p.status = 'trashed';
                            draft.collections[plan.entityId].status = 'trashed';
                        }
                        const entity = clone((plan.mode === 'paper' ? draft.papers : draft.collections)[plan.entityId]); entity[plan.mode === 'paper' ? 'locationRevision' : 'revision']++;
                        return { entity, trashRel: plan.trashRel, files: plan.files.map(file => file.from), events: [{ type: 'trashed', eventId: digest(id + ':delete'), entityId: plan.entityId, paperIds: plan.paperIds, collectionIds: plan.collectionIds, mode: plan.mode }],
                            receipt: { operationId: id, kind: 'delete', mode: plan.mode, status: 'committed', entityId: plan.entityId, paperIds: plan.paperIds, collectionIds: plan.collectionIds, trashRel: plan.trashRel,
                                movedFiles: plan.files.length, movedHidden: plan.movedHidden, cleared: plan.mode === 'clear-collection' ? plan.paperCount : 0, warnings: [] } };
                    } });
                });
            } finally {
                try { await release({ entityId: plan.entityId, operationId: id }); }
                catch { if (outcome) outcome.result.receipt.warnings.push('reader-release-needs-review'); }
            }
            return postCommit(outcome, id, fingerprint);
        },
        async planRename(args) { args = captureArgs(args); requireReady(); return publicPlan(await makePlan(args)); },
        async applyRename(args) {
            args = captureArgs(args);
            requireReady(); const id = operationId(args.operationId);
            const expectedCollectionId = args.collectionId === undefined ? undefined : entityId(args.collectionId);
            const fingerprint = requestHash({ kind: 'rename', planId: args.planId, ...(expectedCollectionId === undefined ? {} : { collectionId: expectedCollectionId }) });
            const prior = replay(catalog.snapshot(), id, fingerprint); if (prior) return prior;
            const stored = (await journal.snapshot()).plans[args.planId]; if (!stored) fail('stale-plan');
            if (!['paper', 'collection'].includes(stored.kind)) fail('conflict');
            if (expectedCollectionId !== undefined && (stored.kind !== 'collection' || stored.entityId !== expectedCollectionId)) fail('conflict');
            if (requestHash({ files: stored.files, dirs: stored.dirs }) !== stored.sourceRevision) fail('needs-review');
            if (!Number.isSafeInteger(stored.expiresAt) || now() > stored.expiresAt) fail('stale-plan');
            const canonical = await makePlan({ [stored.kind === 'paper' ? 'paperId' : 'collectionId']: stored.entityId, name: stored.newName, expectedLocationRevision: stored.expectedLocationRevision }, false);
            if (canonical.conflicts.length) fail('target-exists');
            if (canonical.sourceRevision !== stored.sourceRevision) fail('stale-plan');
            // Gate IDs and executable paths always come from fresh catalog/filesystem discovery.
            const plan = { ...canonical, planId: stored.planId, catalogRevision: stored.catalogRevision, expiresAt: stored.expiresAt };
            const release = await leaseFor(plan.paperIds, { operationId: id, type: plan.kind === 'paper' ? 'rename-paper' : 'rename-collection' });
            let outcome;
            try {
                outcome = await journal.exclusive(async (state, save) => {
                    const latest = catalog.snapshot(), repeated = replay(latest, id, fingerprint); if (repeated) return { result: repeated, fresh: false };
                    if (latest.revision !== plan.catalogRevision) fail('stale-plan');
                    const fresh = await makePlan({ [plan.kind === 'paper' ? 'paperId' : 'collectionId']: plan.entityId, name: plan.newName, expectedLocationRevision: plan.expectedLocationRevision }, false);
                    if (fresh.sourceRevision !== plan.sourceRevision || fresh.conflicts.length) fail('stale-plan');
                    return execute(state, save, { id, fingerprint, kind: 'rename', intent: { plan }, entityId: plan.entityId, paperIds: plan.paperIds, collectionIds: plan.collectionIds, mutate: async (draft, op) => {
                        let cleanup = [];
                        if (plan.kind === 'paper') {
                            const staged = [];
                            for (let i = 0; i < plan.files.length; i++) {
                                const file = plan.files[i], stagePath = rel(join(dirname(safePath(file.from)), `.dpr-move-${randomUUID()}-${i}`));
                                await step(op, state, save, { type: 'move', from: file.from, to: stagePath, identity: file.identity }); staged.push({ file, stagePath });
                            }
                            for (const { file, stagePath } of staged) await step(op, state, save, { type: 'move', from: stagePath, to: file.to, identity: file.identity });
                            draft.papers[plan.entityId].name = plan.newName;
                        } else {
                            const stageRoot = rel(join(dirname(safePath(plan.fromDir)), `.dpr-dir-${randomUUID()}`));
                            await step(op, state, save, { type: 'stage-directory', from: plan.fromDir, to: stageRoot, identity: plan.dirs[0].identity });
                            const replacePrefix = (path, prefix) => prefix + path.slice(plan.fromDir.length);
                            for (const dir of plan.dirs) await step(op, state, save, { type: 'mkdir', path: dir.to, mode: dir.identity.mode });
                            for (const file of plan.files) await step(op, state, save, { type: 'move', from: replacePrefix(file.from, stageRoot), to: file.to, identity: file.identity });
                            cleanup = plan.dirs.map(dir => replacePrefix(dir.from, stageRoot));
                            const segments = [...plan.oldSegments.slice(0, -1), plan.newName];
                            for (const c of Object.values(draft.collections)) if (c.status !== 'trashed' && plan.collectionIds.includes(c.collectionId)) { c.segments = [...segments, ...c.segments.slice(plan.oldSegments.length)]; if (c.collectionId === plan.entityId) c.name = plan.newName; }
                            for (const p of Object.values(draft.papers)) if (p.status === 'active' && plan.collectionIds.includes(p.collectionId)) p.segments = [...segments, ...p.segments.slice(plan.oldSegments.length)];
                        }
                        const entity = clone((plan.kind === 'paper' ? draft.papers : draft.collections)[plan.entityId]);
                        entity[plan.kind === 'paper' ? 'locationRevision' : 'revision']++;
                        return { entity, cleanup, events: [{ type: 'renamed', eventId: digest(id + ':rename'), entityId: plan.entityId, paperIds: plan.paperIds }], receipt: { operationId: id, kind: 'rename', status: 'committed', entityId: plan.entityId, warnings: [] } };
                    } });
                });
            } finally {
                try { await release({ entityId: plan.entityId, operationId: id }); }
                catch { if (outcome) { outcome.result.receipt.warnings ||= []; outcome.result.receipt.warnings.push('reader-release-needs-review'); } }
            }
            return postCommit(outcome, id, fingerprint);
        },
        async importPdfs(args, trustedSource = 'manual') {
            args = captureArgs(args);
            requireReady(); sourceKind(trustedSource); entityId(args.collectionId); const id = operationId(args.operationId);
            if (!Array.isArray(args.sources) || !args.sources.length || args.sources.length > 100) fail();
            const fingerprintValue = requestHash({ kind: 'import', ...args, trustedSource });
            const committed = replay(catalog.snapshot(), id, fingerprintValue); if (committed) return committed;
            let policy = { observedPolicyEpoch: null, observedTranslation: null };
            if (typeof options.captureIngestPolicy === 'function') {
                try { policy = capturePolicy(await options.captureIngestPolicy({ operationId: id, requestHash: fingerprintValue, collectionId: args.collectionId })); } catch { /* Local copy remains available; automatic eligibility stays closed. */ }
            }
            if (policy.observedTranslation?.collectionId !== args.collectionId) policy.observedTranslation = null;
            const outcome = await journal.exclusive(async (state, save) => {
                const prior = replay(catalog.snapshot(), id, fingerprintValue); if (prior) return { result: prior, fresh: false };
                const collection = catalog.resolveCollection({ collectionId: args.collectionId }); await available([], [collection.collectionId]);
                return execute(state, save, { id, fingerprint: fingerprintValue, kind: 'import', intent: { collectionId: collection.collectionId, segments: collection.segments, names: args.sources.map(s => s.name || basename(s.path || '').replace(/\.pdf$/i, '')), policy }, collectionIds: [collection.collectionId], mutate: async (draft, op) => {
                    const results = [], events = [];
                    for (let index = 0; index < args.sources.length; index++) {
                        const source = args.sources[index], start = op.steps.length; let handle;
                        try {
                            if (!plain(source) || typeof source.path !== 'string' || !isAbsolute(source.path)) fail();
                            const name = source.name || basename(source.path).replace(/\.pdf$/i, ''); validateSegment(name); if (/-(?:en|zh|dual)$/i.test(name)) fail();
                            const dir = collection.dirPath, target = join(dir, name + '.pdf');
                            if ((await readdir(dir)).some(n => foldName(n) === foldName(name + '.pdf'))) fail('target-exists');
                            const initial = await lstat(source.path, { bigint: true });
                            if (initial.isSymbolicLink() || !initial.isFile() || initial.nlink !== 1n) fail('pdf-invalid');
                            if (initial.size > BigInt(options.maxPdfBytes || 512 * 1024 * 1024)) fail('too-large');
                            const before = await fingerprint(source.path); if (before.type !== 'file') fail('pdf-invalid'); if (before.size > (options.maxPdfBytes || 512 * 1024 * 1024)) fail('too-large');
                            const input = await open(source.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                            const temp = join(dir, `.dpr-import-${randomUUID()}`); const row = { type: 'created-file', path: rel(temp), phase: 'intent' }; op.steps.push(row); await save();
                            try {
                                await checked(row.path, true);
                                handle = await open(temp, 'wx', 0o600); row.identity = infoOf(await handle.stat({ bigint: true })); await save();
                                const buffer = Buffer.alloc(128 * 1024), hash = createHash('sha256'); let position = 0;
                                for (;;) {
                                    const { bytesRead } = await input.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
                                    if (position === 0 && !/^%PDF-\d\.\d/.test(buffer.subarray(0, Math.min(bytesRead, 16)).toString('ascii'))) fail('pdf-invalid');
                                    position += bytesRead; if (position > (options.maxPdfBytes || 512 * 1024 * 1024)) fail('too-large');
                                    hash.update(buffer.subarray(0, bytesRead)); await handle.writeFile(buffer.subarray(0, bytesRead));
                                }
                                if (position < 100) fail('pdf-invalid'); await handle.sync(); await handle.close(); handle = null;
                                const after = await fingerprint(source.path), sourceSignature = hash.digest('hex');
                                if (requestHash(before) !== requestHash(after) || sourceSignature !== before.sha256) fail('source-changed');
                                row.phase = 'done'; await save();
                                await step(op, state, save, { type: 'move', from: row.path, to: rel(target), identity: row.identity });
                                const paperId = randomUUID(); draft.ingestSeq++;
                                draft.papers[paperId] = { paperId, collectionId: collection.collectionId, name, segments: collection.segments, locationRevision: 1, status: 'active', origin: 'import', ingestSeq: draft.ingestSeq };
                                results.push({ sourceIndex: index, name, paperId, created: true, status: 'created' });
                                events.push({ type: 'ingest', eventId: digest(id + ':' + paperId), paperId, ingestSeq: draft.ingestSeq, origin: 'import', sourceSignature, ...policy });
                            } finally { await input.close(); await handle?.close().catch(() => {}); handle = null; }
                        } catch (e) {
                            const partial = { ...op, steps: op.steps.slice(start) };
                            if (!await undo(partial, async () => save())) { op.status = 'needs-review'; await save(); fail('needs-review'); }
                            for (const row of op.steps.slice(start)) row.phase = 'undone';
                            results.push({ sourceIndex: index, created: false, status: 'failed', code: safeError(e).code });
                        }
                    }
                    const tasks = results.filter(r => r.created).flatMap(r => {
                        const source = args.sources[r.sourceIndex], patch = { revision: null };
                        for (const key of ['summaryText', 'bibliography']) if (Object.hasOwn(source, key)) patch[key] = source[key];
                        return Object.keys(patch).length > 1 ? [{ kind: 'paper', id: r.paperId, patch, source: trustedSource }] : [];
                    });
                    return { results, events, _metadataTasks: tasks, receipt: { operationId: id, kind: 'import', status: results.every(r => r.created) ? 'committed' : 'partial', warnings: [] } };
                } });
            });
            return postCommit(outcome, id, fingerprintValue);
        },
    };
    return service;
}
