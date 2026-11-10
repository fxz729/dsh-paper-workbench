// UUID metadata only: no PDF writes, HTML interpretation, endpoint configuration or network IO.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_METADATA_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export class MetadataError extends Error {
    constructor(code) {
        super({ invalid: '元数据或存储路径无效，原文件已保留', conflict: '元数据版本已变化或正在保存，请重新读取', io: '元数据读写失败，请检查存储状态' }[code]);
        this.name = 'MetadataError';
        this.code = code;
        this.status = { invalid: 400, conflict: 409, io: 500 }[code];
    }
}
const fail = (code = 'invalid') => { throw new MetadataError(code); };
const safeError = e => e instanceof MetadataError ? e : new MetadataError(e?.code === 'ELOOP' ? 'invalid' : 'io');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (v, k) => Object.hasOwn(v, k);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v));

// Clone via data descriptors before the first await. Reject accessors, lossy JSON and cycles.
function snapshot(value, seen = new Set(), depth = 0, budget = { nodes: 0, bytes: 0 }) {
    if (depth > 8 || ++budget.nodes > 4096) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        text(value, 65536); budget.bytes += Buffer.byteLength(value);
        if (budget.bytes > MAX_METADATA_BYTES) fail();
        return value;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
    if (!plain(value) || seen.has(value) || Object.getOwnPropertySymbols(value).length) fail();
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (names.length > 1024) fail();
    const result = Object.create(null);
    for (const key of names) {
        const d = descriptors[key];
        if (['__proto__', 'prototype', 'constructor'].includes(key) || !d.enumerable || !own(d, 'value')) fail();
        budget.bytes += Buffer.byteLength(key);
        if (key.length > 256 || budget.bytes > MAX_METADATA_BYTES) fail();
        result[key] = snapshot(d.value, seen, depth + 1, budget);
    }
    seen.delete(value);
    return result;
}
function keys(v, allowed, required = []) {
    if (!plain(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !own(v, k))) fail();
}
function text(value, max, nonempty = false) {
    if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail();
    // Reject lone UTF-16 surrogates rather than silently replacing raw user input on encoding.
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
        } else if (c >= 0xdc00 && c <= 0xdfff) fail();
    }
}
function revision(v) { if (v !== null && (typeof v !== 'string' || !HASH.test(v))) fail(); }
function timestamp(v, nullable = false) {
    if (nullable && v === null) return;
    if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
        || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail();
}
function bibliography(v) {
    keys(v, ['firstAuthor', 'hasMoreAuthors', 'year', 'originalTitle']);
    if (own(v, 'firstAuthor')) text(v.firstAuthor, 1024);
    if (own(v, 'originalTitle')) text(v.originalTitle, 4096);
    if (own(v, 'hasMoreAuthors') && typeof v.hasMoreAuthors !== 'boolean') fail();
    if (own(v, 'year') && (typeof v.year !== 'string' || !/^[0-9]{4}$/.test(v.year))) fail();
}
function candidateFields(v, stored = false) {
    const fields = ['expectedRevision', 'summaryText', 'bibliography', 'sourceSignature', 'model', 'operationId'];
    keys(v, stored ? [...fields, 'updatedAt', 'baseRevision'] : fields,
        ['expectedRevision', 'sourceSignature', 'model', 'operationId', ...(stored ? ['updatedAt', 'baseRevision'] : [])]);
    revision(v.expectedRevision);
    if (stored) revision(v.baseRevision);
    if (!own(v, 'summaryText') && !own(v, 'bibliography')) fail();
    if (own(v, 'summaryText')) text(v.summaryText, 65536);
    if (own(v, 'bibliography')) bibliography(v.bibliography);
    text(v.sourceSignature, 1024, true); text(v.model, 256, true); text(v.operationId, 256, true);
    if (stored) timestamp(v.updatedAt);
}
function defaults(kind) {
    return kind === 'collection' ? { note: '', updatedAt: null }
        : { summary: { text: '', source: 'empty', updatedAt: null }, bibliography: {}, candidate: null };
}
function validateData(kind, data) {
    if (kind === 'collection') {
        keys(data, ['note', 'updatedAt'], ['note', 'updatedAt']);
        text(data.note, 16384); timestamp(data.updatedAt, true);
        return;
    }
    keys(data, ['summary', 'bibliography', 'candidate', 'operations'], ['summary', 'bibliography', 'candidate']);
    keys(data.summary, ['text', 'source', 'updatedAt', 'sourceSignature'], ['text', 'source', 'updatedAt']);
    const s = data.summary;
    text(s.text, 65536);
    if (!['empty', 'manual', 'model', 'api'].includes(s.source)) fail();
    timestamp(s.updatedAt, s.source === 'empty');
    if (s.source === 'empty' && (s.text !== '' || s.updatedAt !== null || own(s, 'sourceSignature'))) fail();
    if (own(s, 'sourceSignature')) { if (s.source !== 'api') fail(); text(s.sourceSignature, 1024, true); }
    bibliography(data.bibliography);
    if (data.candidate !== null) candidateFields(data.candidate, true);
    if (own(data, 'operations')) {
        if (!plain(data.operations) || Object.keys(data.operations).length > 1024) fail();
        for (const [key, value] of Object.entries(data.operations))
            if (!HASH.test(key) || typeof value !== 'string' || !HASH.test(value)) fail();
    }
}
function identity(root, id) {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || typeof id !== 'string' || !UUID.test(id)) fail();
    return { root: resolve(root), id: id.toLowerCase() };
}
async function directory(path, create) {
    let st;
    try { st = await lstat(path); }
    catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!create) return false;
        try { await mkdir(path); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        st = await lstat(path);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) fail();
    return true;
}
async function paths(ref, kind, create) {
    // Configured DataDir is the trusted boundary, including its configured ancestors.
    const root = await realpath(ref.root);
    const base = join(root, '.dpr-paper-meta'), dir = join(base, kind);
    if (!await directory(base, create) || !await directory(dir, create)) return null;
    return { path: join(dir, `${ref.id}.json`), root };
}
async function regular(path, optional = false) {
    try {
        const st = await lstat(path);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) fail();
        return st;
    } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function load(path, kind, id) {
    const before = await regular(path, true);
    if (!before) return { revision: null, data: defaults(kind) };
    if (before.size > MAX_METADATA_BYTES) fail();
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    try {
        const st = await handle.stat();
        if (!same(before, st) || !st.isFile() || st.nlink !== 1 || st.size > MAX_METADATA_BYTES) fail();
        const bytes = Buffer.alloc(st.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const r = await handle.read(bytes, count, bytes.length - count, count);
            if (!r.bytesRead) break;
            count += r.bytesRead;
        }
        const after = await handle.stat();
        if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) fail('conflict');
        const raw = bytes.subarray(0, count);
        let envelope;
        try { envelope = snapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
        catch { fail(); }
        keys(envelope, ['format', 'version', 'kind', 'id', 'generation', 'data'], ['format', 'version', 'kind', 'id', 'generation', 'data']);
        if (envelope.format !== 'dpr-paper-metadata' || envelope.version !== 1 || envelope.kind !== kind || envelope.id !== id
            || typeof envelope.generation !== 'string' || !UUID.test(envelope.generation)) fail();
        validateData(kind, envelope.data);
        return { revision: hash(raw), data: envelope.data };
    } finally { await handle.close(); }
}
function publicResult(state) {
    const { operations, ...data } = state.data;
    return JSON.parse(JSON.stringify({ revision: state.revision, ...data }));
}
async function read(root, id, kind) {
    try {
        const ref = identity(root, id), p = await paths(ref, kind, false);
        return publicResult(p ? await load(p.path, kind, ref.id) : { revision: null, data: defaults(kind) });
    } catch (e) { throw safeError(e); }
}
async function removeOwned(path, st) {
    if (!path || !st) return;
    try { const current = await lstat(path); if (!current.isSymbolicLink() && same(current, st)) await unlink(path); }
    catch { /* Preserve recovery evidence if cleanup fails. Never steal another owner's file. */ }
}
async function transaction(ref, kind, mutate) {
    let lock, lockSt, lockPath, temporary, tempSt;
    try {
        const p = await paths(ref, kind, true), path = p.path;
        lockPath = `${path}.lock`;
        try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600); }
        catch (e) {
            if (e.code === 'EEXIST') { await regular(lockPath, true); fail('conflict'); }
            throw e;
        }
        lockSt = await lock.stat();
        const current = await load(path, kind, ref.id);
        const next = mutate(current);
        if (next === current) return publicResult(current);
        validateData(kind, next.data);
        // A new commit identity prevents ABA even if all user data and timestamps repeat.
        // Idempotent replays returned above retain the original bytes and revision.
        const content = JSON.stringify({ format: 'dpr-paper-metadata', version: 1, kind, id: ref.id, generation: randomUUID(), data: next.data });
        if (Buffer.byteLength(content, 'utf8') > MAX_METADATA_BYTES) fail();
        temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        try { tempSt = await handle.stat(); await handle.writeFile(content, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
        // Repeat all descendant and target checks before publishing. Node path IO cannot pin
        // parents against an actively hostile local process replacing them between syscalls.
        const checked = await paths(ref, kind, false);
        if (!checked || checked.path !== path) fail('conflict');
        const latest = await load(path, kind, ref.id);
        if (latest.revision !== current.revision) fail('conflict');
        if (!same(await regular(temporary), tempSt) || !same(await regular(lockPath), lockSt)) fail('conflict');
        await rename(temporary, path);
        temporary = undefined;
        return publicResult({ revision: hash(content), data: next.data });
    } catch (e) { throw safeError(e); }
    finally {
        await removeOwned(temporary, tempSt);
        if (lock) { try { await lock.close(); } catch { /* Keep primary error/result. */ } }
        await removeOwned(lockPath, lockSt);
    }
}
function trustedSource(source) { if (!['manual', 'model'].includes(source)) fail(); }
function checkedPatch(patch, allowed) {
    const p = snapshot(patch); keys(p, allowed, ['revision']); revision(p.revision); return p;
}

export async function readCollectionMetadata(root, id) { return read(root, id, 'collection'); }
export async function writeCollectionMetadata(root, id, patch, source = 'manual') {
    try {
        const ref = identity(root, id), p = checkedPatch(patch, ['revision', 'note']);
        trustedSource(source); if (!own(p, 'note')) fail(); text(p.note, 16384);
        return await transaction(ref, 'collection', current => {
            if (current.revision !== p.revision) fail('conflict');
            return { data: { note: p.note, updatedAt: new Date().toISOString() } };
        });
    } catch (e) { throw safeError(e); }
}
export async function readPaperMetadata(root, id) { return read(root, id, 'paper'); }
export async function writePaperMetadata(root, id, patch, source = 'manual') {
    try {
        const ref = identity(root, id), p = checkedPatch(patch, ['revision', 'summaryText', 'bibliography']);
        trustedSource(source);
        if (!own(p, 'summaryText') && !own(p, 'bibliography')) fail();
        if (own(p, 'summaryText')) text(p.summaryText, 65536);
        if (own(p, 'bibliography')) bibliography(p.bibliography);
        return await transaction(ref, 'paper', current => {
            if (current.revision !== p.revision) fail('conflict');
            const data = current.data;
            if (own(p, 'summaryText')) data.summary = { text: p.summaryText, source, updatedAt: new Date().toISOString() };
            if (own(p, 'bibliography')) data.bibliography = p.bibliography;
            return { data };
        });
    } catch (e) { throw safeError(e); }
}
const payloadHash = c => {
    const result = {};
    for (const key of ['expectedRevision', 'summaryText', 'bibliography', 'sourceSignature', 'model', 'operationId']) {
        if (!own(c, key)) continue;
        result[key] = key === 'bibliography'
            ? Object.fromEntries(Object.keys(c[key]).sort().map(k => [k, c[key][k]])) : c[key];
    }
    return hash(JSON.stringify(result));
};
function useCandidate(data, c) {
    if (own(c, 'summaryText')) data.summary = { text: c.summaryText, source: 'api', updatedAt: c.updatedAt, sourceSignature: c.sourceSignature };
    if (own(c, 'bibliography')) data.bibliography = c.bibliography;
}
export async function writePaperCandidate(root, id, patch) {
    try {
        const ref = identity(root, id), p = snapshot(patch); candidateFields(p);
        return await transaction(ref, 'paper', current => {
            const data = current.data;
            const operationKey = hash(p.operationId), fingerprint = payloadHash(p);
            if (data.operations && own(data.operations, operationKey)) {
                if (data.operations[operationKey] !== fingerprint) fail('conflict');
                return current;
            }
            // Bounded durable fingerprints retain replay protection after candidate replacement
            // or adoption. Never evict old operations and silently permit an old result again.
            data.operations ??= Object.create(null);
            if (Object.keys(data.operations).length >= 1024) fail();
            data.operations[operationKey] = fingerprint;
            const c = { ...p, baseRevision: current.revision, updatedAt: new Date().toISOString() };
            // API completion only stages a candidate; adoption is always an explicit CAS.
            data.candidate = c;
            return { data };
        });
    } catch (e) { throw safeError(e); }
}
export async function applyPaperCandidate(root, id, patch) {
    try {
        const ref = identity(root, id), p = checkedPatch(patch, ['revision', 'operationId']); text(p.operationId, 256, true);
        return await transaction(ref, 'paper', current => {
            const data = current.data, c = data.candidate;
            if (current.revision !== p.revision || !c || c.operationId !== p.operationId) fail('conflict');
            useCandidate(data, c);
            data.candidate = null;
            return { data };
        });
    } catch (e) { throw safeError(e); }
}
