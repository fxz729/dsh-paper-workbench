// Identity/index core only. File creation, copying and lifecycle transactions belong to LibraryService.
import { constants, lstatSync, readdirSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogError, canonicalRoot, claimKey, validateClaimKey, collectionClaimKey, validateCollectionClaimKey, foldName, validateSegment, validateLegacySegment, validateLegacySegments, resolveCollectionPath, resolvePdfPath } from './collection-paths.js';
export { CatalogError, claimKey, collectionClaimKey } from './collection-paths.js';

export const CATALOG_FILENAME = '.dpr-paper-catalog.json';
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
export const MAX_SESSION_ID_CHARS = 8192;
const instances = new Map();
const uuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const nonnegative = (v) => Number.isSafeInteger(v) && v >= 0;
const fail = () => { throw new CatalogError('invalid'); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const collectionActive = (collection) => (collection.status ?? 'active') === 'active';
function fields(v, names) { if (!plain(v) || Object.keys(v).some((k) => !names.includes(k))) fail(); }
function jsonSafe(value) {
    let nodes = 0, bytes = 0;
    const seen = new Set();
    function visit(v, depth, sessionKeys = false) {
        if (++nodes > 300000 || depth > 40) fail();
        if (v === null || typeof v === 'boolean') return;
        if (typeof v === 'string') { bytes += Buffer.byteLength(v); if (v.length > 262144 || bytes > MAX_CATALOG_BYTES) fail(); return; }
        if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER) fail(); return; }
        if ((!Array.isArray(v) && !plain(v)) || seen.has(v) || Object.getOwnPropertySymbols(v).length) fail();
        seen.add(v);
        const descriptors = Object.getOwnPropertyDescriptors(v), keys = Object.keys(descriptors);
        if (keys.length > 100000) fail();
        if (Array.isArray(v)) {
            if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 100000 || keys.length !== v.length + 1) fail();
            for (let i = 0; i < v.length; i++) { const d = descriptors[i]; if (!d || !('value' in d) || !d.enumerable) fail(); visit(d.value, depth + 1); }
        } else for (const key of keys) {
            const d = descriptors[key]; bytes += Buffer.byteLength(key);
            if (key.length > (sessionKeys ? MAX_SESSION_ID_CHARS : 4096) || bytes > MAX_CATALOG_BYTES || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in d) || !d.enumerable) fail();
            // Only exact root session-binding keys inherit the legacy session-id budget.
            visit(d.value, depth + 1, depth === 0 && key === 'sessionBindings');
        }
        seen.delete(v);
    }
    visit(value, 0);
}
function validateState(state) {
    jsonSafe(state);
    fields(state, ['format', 'version', 'revision', 'ingestSeq', 'collections', 'papers', 'claims', 'collectionClaims', 'sessionBindings', 'operations']);
    if (state.format !== 'dpr-paper-catalog' || state.version !== 1 || !positive(state.revision) || !nonnegative(state.ingestSeq)) fail();
    for (const field of ['collections', 'papers', 'claims', 'sessionBindings', 'operations']) if (!plain(state[field])) fail();
    const paths = new Set();
    for (const [id, c] of Object.entries(state.collections)) {
        fields(c, ['collectionId', 'parentId', 'name', 'segments', 'revision', 'note', 'status']);
        if (!uuid(id) || c.collectionId !== id || (c.parentId !== null && !uuid(c.parentId)) || !positive(c.revision) || typeof c.note !== 'string' || c.note.length > 65536 || (c.status !== undefined && !['active', 'trashed'].includes(c.status))) fail();
        validateLegacySegment(c.name); validateLegacySegments(c.segments);
        const key = collectionClaimKey(c.segments);
        if (collectionActive(c)) { if (paths.has(key)) fail(); paths.add(key); }
        const visited = new Set([id]); let current = c;
        while (current.parentId !== null) {
            if (visited.has(current.parentId) || !state.collections[current.parentId]) fail();
            visited.add(current.parentId); current = state.collections[current.parentId];
            if (collectionActive(c) && !collectionActive(current)) fail();
            if (visited.size > 32) fail();
        }
        const parent = c.parentId === null ? [] : state.collections[c.parentId].segments;
        if (collectionActive(c) && (!Array.isArray(parent) || !same(c.segments, [...parent, c.name]))) fail();
    }
    // v1 compatibility derives only the locations explicitly retained in existing rows.
    // Raw disk bytes still supply the CAS token; this view is persisted on the next commit.
    if (!Object.hasOwn(state, 'collectionClaims')) addCollectionClaims(state);
    if (!plain(state.collectionClaims)) fail();
    for (const c of Object.values(state.collections)) {
        const owners = state.collectionClaims[collectionClaimKey(c.segments)];
        if (!Array.isArray(owners) || !owners.includes(c.collectionId)) fail();
    }
    for (const [key, owners] of Object.entries(state.collectionClaims)) {
        validateCollectionClaimKey(key);
        if (!Array.isArray(owners) || !owners.length || new Set(owners).size !== owners.length || owners.some(id => !uuid(id) || !state.collections[id])) fail();
    }
    const occupied = new Set();
    for (const [id, p] of Object.entries(state.papers)) {
        fields(p, ['paperId', 'collectionId', 'name', 'segments', 'locationRevision', 'status', 'origin', 'ingestSeq']);
        if (!uuid(id) || p.paperId !== id || !uuid(p.collectionId) || !state.collections[p.collectionId] || !positive(p.locationRevision)
            || !['active', 'missing', 'trashed'].includes(p.status) || !['baseline', 'import'].includes(p.origin) || !nonnegative(p.ingestSeq)
            || p.ingestSeq > state.ingestSeq || (p.origin === 'baseline' ? p.ingestSeq !== 0 : p.ingestSeq === 0)) fail();
        validateLegacySegment(p.name); validateLegacySegment(p.name + '.pdf'); validateLegacySegments(p.segments);
        if (/-(?:en|zh|dual)$/i.test(p.name)) fail();
        if (p.status === 'active' && (!collectionActive(state.collections[p.collectionId]) || !same(p.segments, state.collections[p.collectionId].segments))) fail();
        const key = claimKey(p.segments, p.name);
        if (p.status === 'active') { if (occupied.has(key)) fail(); occupied.add(key); }
        if (!Array.isArray(state.claims[key]) || !state.claims[key].includes(id)) fail();
    }
    for (const [key, owners] of Object.entries(state.claims)) {
        validateClaimKey(key);
        if (!Array.isArray(owners) || !owners.length || new Set(owners).size !== owners.length
            || owners.some((id) => !uuid(id) || !state.papers[id])) fail();
    }
    for (const [sid, id] of Object.entries(state.sessionBindings)) {
        if (!sid || sid.length > MAX_SESSION_ID_CHARS || /[\x00-\x1f\x7f]/.test(sid) || !uuid(id) || !state.papers[id]) fail();
    }
    if (Object.keys(state.operations).some((id) => !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id))) fail();
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_CATALOG_BYTES) fail();
    return state;
}
function addCollectionClaims(state) {
    state.collectionClaims ??= {};
    for (const c of Object.values(state.collections)) {
        const key = collectionClaimKey(c.segments);
        if (!state.collectionClaims[key]) state.collectionClaims[key] = [];
        if (!Array.isArray(state.collectionClaims[key])) fail();
        if (!state.collectionClaims[key].includes(c.collectionId)) state.collectionClaims[key].push(c.collectionId);
    }
}
function addClaims(state) {
    addCollectionClaims(state);
    for (const p of Object.values(state.papers)) {
        const key = claimKey(p.segments, p.name);
        if (!state.claims[key]) state.claims[key] = [];
        if (!Array.isArray(state.claims[key])) fail();
        if (!state.claims[key].includes(p.paperId)) state.claims[key].push(p.paperId);
    }
}
function validateTransition(before, draft) {
    if (draft.revision !== before.revision || draft.ingestSeq < before.ingestSeq || !plain(draft.collectionClaims)) fail();
    // Loading preserves legacy basenames, but creating/importing or changing an entity's
    // own destination still applies today's strict target policy. An ancestor rename may
    // change descendant segments without renaming those existing legacy basenames.
    for (const [id, next] of Object.entries(draft.collections)) {
        const old = before.collections[id];
        if (!old && !collectionActive(next)) fail();
        if (!old || next.name !== old.name || next.parentId !== old.parentId) validateSegment(next.name);
    }
    for (const [id, next] of Object.entries(draft.papers)) {
        const old = before.papers[id];
        if (!old && next.status !== 'active') fail();
        if (!old || next.name !== old.name || next.collectionId !== old.collectionId) validateSegment(next.name);
    }
    for (const [id, old] of Object.entries(before.papers)) {
        const next = draft.papers[id];
        if (!next || next.paperId !== old.paperId || next.origin !== old.origin || next.ingestSeq !== old.ingestSeq) fail();
        if (old.status === 'trashed' && next.status !== 'trashed') fail();
        // An inactive destination has no new physical occupation to justify another claim.
        if (next.status !== 'active' && ['collectionId', 'segments', 'name'].some(key => !same(old[key], next[key]))) fail();
        const changed = ['collectionId', 'segments', 'name', 'status'].some((key) => !same(old[key], next[key]));
        next.locationRevision = old.locationRevision + (changed ? 1 : 0);
    }
    for (const [id, old] of Object.entries(before.collections)) {
        const next = draft.collections[id];
        if (!next || next.collectionId !== old.collectionId) fail();
        if (!collectionActive(old) && collectionActive(next)) fail();
        if (!collectionActive(next) && ['parentId', 'name', 'segments'].some(key => !same(old[key], next[key]))) fail();
        if (collectionActive(old) && !collectionActive(next) && old.note !== next.note) fail();
        next.revision = old.revision + (collectionActive(old) !== collectionActive(next) || ['parentId', 'name', 'segments', 'note'].some((key) => !same(old[key], next[key])) ? 1 : 0);
    }
    for (const [key, owners] of Object.entries(before.claims)) if (!Array.isArray(draft.claims[key]) || owners.some((id) => !draft.claims[key].includes(id))) fail();
    for (const [key, owners] of Object.entries(draft.claims)) {
        if (!Array.isArray(owners)) fail();
        for (const id of owners) {
            if (before.claims[key]?.includes(id)) continue;
            const paper = draft.papers[id];
            if (!paper || claimKey(paper.segments, paper.name) !== key) fail();
        }
    }
    for (const [key, owners] of Object.entries(before.collectionClaims)) {
        if (!Array.isArray(draft.collectionClaims[key]) || owners.some((id, index) => draft.collectionClaims[key][index] !== id)) fail();
    }
    for (const [key, owners] of Object.entries(draft.collectionClaims)) {
        if (!Array.isArray(owners)) fail();
        for (const id of owners) {
            if (before.collectionClaims[key]?.includes(id)) continue;
            const collection = draft.collections[id];
            if (!collection || collectionClaimKey(collection.segments) !== key) fail();
        }
    }
    for (const [sid, id] of Object.entries(before.sessionBindings)) if (draft.sessionBindings[sid] !== id) fail();
    addClaims(draft);
    draft.revision = before.revision + 1;
    validateState(draft);
}
function initialState(root) {
    const state = { format: 'dpr-paper-catalog', version: 1, revision: 1, ingestSeq: 0, collections: {}, papers: {}, claims: {}, sessionBindings: {}, operations: {} };
    let seen = 0;
    function walk(segments, parentId) {
        const dir = segments.length ? resolveCollectionPath(root, segments) : root;
        const entries = readdirSync(dir, { withFileTypes: true })
            .filter((e) => !e.name.startsWith('.') || (e.isFile() && /\.pdf$/i.test(e.name)))
            .sort((a, b) => a.name.localeCompare(b.name));
        const names = new Set();
        for (const entry of entries) {
            if (++seen > 100000) fail();
            const key = foldName(entry.name);
            if (names.has(key)) throw new CatalogError('path-collision'); names.add(key);
            const st = lstatSync(join(dir, entry.name));
            if (st.isSymbolicLink()) continue;
            if (st.isDirectory()) {
                const nested = [...segments, entry.name]; validateLegacySegments(nested);
                resolveCollectionPath(root, nested);
                const id = randomUUID();
                state.collections[id] = { collectionId: id, parentId, name: entry.name, segments: nested, revision: 1, note: '' };
                walk(nested, id);
            } else if (segments.length && st.isFile() && st.nlink === 1 && /\.pdf$/i.test(entry.name)) {
                const name = entry.name.slice(0, -4);
                if (/-(?:en|zh|dual)$/i.test(name)) continue;
                validateLegacySegment(name); resolvePdfPath(root, segments, name);
                const id = randomUUID();
                state.papers[id] = { paperId: id, collectionId: parentId, name, segments: [...segments], locationRevision: 1, status: 'active', origin: 'baseline', ingestSeq: 0 };
            }
        }
    }
    walk([], null); addClaims(state); return validateState(state);
}
function readIndex(file, optional = false) {
    let fd;
    try {
        const before = lstatSync(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_CATALOG_BYTES) throw new CatalogError('catalog-invalid');
        fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size > MAX_CATALOG_BYTES) throw new CatalogError('catalog-invalid');
        if (!identity(st, before)) throw new CatalogError('conflict');
        const bytes = Buffer.alloc(st.size + 1); let count = 0;
        while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, count); if (!n) break; count += n; }
        const after = fstatSync(fd);
        if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new CatalogError('conflict');
        const raw = bytes.subarray(0, count);
        let state;
        try { state = validateState(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
        catch { throw new CatalogError('catalog-invalid'); }
        return { state, token: hash(raw) };
    } catch (e) {
        if (optional && e.code === 'ENOENT') return null;
        if (e instanceof CatalogError) throw e;
        throw new CatalogError(e.code === 'ELOOP' ? 'catalog-invalid' : 'io');
    } finally { if (fd !== undefined) closeSync(fd); }
}
function wire(record) { return { ...structuredClone(record.state), revision: record.token, generation: record.state.revision }; }
async function regularLock(path, optional = false) {
    try { const st = await lstat(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail(); return st; }
    catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
}
async function withLock(file, fn) {
    let lock, id;
    try {
        try { lock = await open(file + '.lock', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
        catch (e) { if (e.code === 'EEXIST') { await regularLock(file + '.lock', true); throw new CatalogError('conflict'); } throw e; }
        id = await lock.stat();
        return await fn();
    } catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError('io'); }
    finally {
        if (lock) {
            try { await lock.close(); } catch { /* Preserve primary outcome. */ }
            if (id) { try { const st = await lstat(file + '.lock'); if (!st.isSymbolicLink() && identity(st, id)) await unlink(file + '.lock'); } catch { /* Retain uncertain ownership. */ } }
        }
    }
}
async function publish(root, file, state, expectedToken, checkRoot) {
    validateState(state); checkRoot();
    // Full active filesystem consistency is checked after LibraryService's file transaction.
    for (const c of Object.values(state.collections)) if (collectionActive(c)) resolveCollectionPath(root, c.segments);
    for (const p of Object.values(state.papers)) if (p.status === 'active') resolvePdfPath(root, p.segments, p.name);
    const text = JSON.stringify(state) + '\n', temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    if (Buffer.byteLength(text) > MAX_CATALOG_BYTES) fail();
    let id, created = false;
    try {
        const handle = await open(temporary, 'wx', 0o600); created = true;
        try { id = await handle.stat(); await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        for (let attempt = 0; ; attempt++) {
            checkRoot();
            if ((readIndex(file, true)?.token ?? null) !== expectedToken) throw new CatalogError('conflict');
            const temp = await regularLock(temporary);
            if (!identity(temp, id)) fail();
            try { await rename(temporary, file); created = false; break; }
            catch (e) {
                // Windows readers/AV can briefly deny replacement. Keep our lock and
                // repeat the full CAS/path checks; persistent permission failures stay IO.
                if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || attempt >= 5) throw e;
                await delay(5 * 2 ** attempt);
            }
        }
        return { state: structuredClone(state), token: hash(text) };
    } finally {
        if (created && id) { try { const st = await lstat(temporary); if (!st.isSymbolicLink() && identity(st, id)) await unlink(temporary); } catch { /* Keep recovery evidence. */ } }
    }
}
export function createCatalog(dataDir) {
    const root = canonicalRoot(dataDir);
    let physical;
    try { physical = lstatSync(root, { bigint: true }); } catch { throw new CatalogError('io'); }
    // Matching aliases may NFC-fold names; root isolation must use real filesystem identity.
    const key = `${physical.dev}:${physical.ino}:${process.platform === 'win32' ? root.toLowerCase() : root}`;
    if (instances.has(key)) return instances.get(key);
    const file = join(root, CATALOG_FILENAME);
    let initialized = false, initializing;
    function checkRoot() {
        canonicalRoot(root);
        let now;
        try { now = lstatSync(root, { bigint: true }); } catch { throw new CatalogError('io'); }
        if (!identity(now, physical)) fail();
    }
    function current() { if (!initialized) throw new CatalogError('not-ready'); checkRoot(); return readIndex(file); }
    const service = {
        async initializeBaseline() {
            if (initialized) return service.snapshot();
            if (initializing) return initializing;
            initializing = (async () => {
                checkRoot();
                let record = readIndex(file, true);
                if (!record) record = await withLock(file, async () => readIndex(file, true) ?? await publish(root, file, initialState(root), null, checkRoot));
                initialized = true; return wire(record);
            })();
            try { return await initializing; } finally { initializing = undefined; }
        },
        snapshot() { return wire(current()); },
        listCollections() { return Object.values(wire(current()).collections).filter(collectionActive); },
        listPapers({ collectionId, recursive = false } = {}) {
            const state = current().state;
            if (collectionId !== undefined && !uuid(collectionId)) fail();
            if (collectionId !== undefined && !state.collections[collectionId]) throw new CatalogError('not-found');
            if (collectionId !== undefined && !collectionActive(state.collections[collectionId])) throw new CatalogError('gone');
            const collection = collectionId ? state.collections[collectionId] : null;
            return structuredClone(Object.values(state.papers).filter((p) => p.status === 'active' && (!collection || p.collectionId === collectionId || (recursive && collection.segments.every((s, i) => s === p.segments[i])))));
        },
        resolveCollection(locator = {}) {
            if (!plain(locator)) fail();
            const state = current().state; let id;
            if (locator.collectionId !== undefined) { if (!uuid(locator.collectionId)) fail(); id = locator.collectionId; }
            else {
                if (typeof locator.topic !== 'string') throw new CatalogError('not-found');
                const owners = state.collectionClaims[collectionClaimKey(locator.topic.split('/'))] || [];
                if (owners.length > 1) throw new CatalogError('collection-ref-ambiguous');
                id = owners[0];
            }
            const collection = state.collections[id];
            if (!collection) throw new CatalogError('not-found');
            if (!collectionActive(collection)) throw new CatalogError('gone');
            return { ...structuredClone(collection), dirPath: resolveCollectionPath(root, collection.segments) };
        },
        resolvePaper(locator = {}) {
            if (!plain(locator)) fail();
            const state = current().state;
            let id;
            if (locator.paperId !== undefined) { if (!uuid(locator.paperId)) fail(); id = locator.paperId; }
            else if (locator.sessionId !== undefined) {
                if (typeof locator.sessionId !== 'string' || !Object.hasOwn(state.sessionBindings, locator.sessionId)) throw new CatalogError('not-found');
                id = state.sessionBindings[locator.sessionId];
            }
            else {
                if (typeof locator.topic !== 'string' || typeof locator.name !== 'string') throw new CatalogError('not-found');
                const segments = locator.topic.split('/');
                const owners = state.claims[claimKey(segments, locator.name)] || [];
                if (owners.length > 1) throw new CatalogError('paper-ref-ambiguous');
                id = owners[0];
            }
            const paper = state.papers[id];
            if (!paper || paper.status === 'missing') throw new CatalogError('not-found');
            if (paper.status === 'trashed') throw new CatalogError('gone');
            const pdfPath = resolvePdfPath(root, paper.segments, paper.name), base = pdfPath.slice(0, -4);
            return { ...structuredClone(paper), topic: paper.segments.join('/'), pdfPath, txtPath: base + '.txt', pagesPath: base + '.pages.json', transcriptPath: base + '.transcript.json', mineruMdPath: base + '.mineru.md', mineruJsonPath: base + '.mineru.json' };
        },
        async transact(expectedRevision, mutate) {
            current();
            if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision) || typeof mutate !== 'function') fail();
            // mutate may be async for local work only; do not call models/network or wait for UI under this lock.
            return withLock(file, async () => {
                const before = current();
                if (before.token !== expectedRevision) throw new CatalogError('conflict');
                const draft = structuredClone(before.state);
                try { await mutate(draft); validateTransition(before.state, draft); }
                catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError('invalid'); }
                const committed = structuredClone(draft);
                return wire(await publish(root, file, committed, before.token, checkRoot));
            });
        },
    };
    instances.set(key, service); return service;
}
