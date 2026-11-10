import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, lstat } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const catalogUrl = new URL('../dist/paper-catalog.js', import.meta.url).href;
const pathsUrl = new URL('../dist/collection-paths.js', import.meta.url).href;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function api() {
    const mod = await import(catalogUrl).catch((e) => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e));
    assert.equal(typeof mod.createCatalog, 'function', 'createCatalog export exists');
    return mod;
}
async function pathsApi() {
    const mod = await import(pathsUrl).catch((e) => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e));
    for (const key of ['validateSegment', 'validateSegments', 'claimKey', 'resolveCollectionPath', 'resolvePdfPath']) assert.equal(typeof mod[key], 'function', `${key} export exists`);
    return mod;
}
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'dpr-catalog-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'Topic', 'Nested'), { recursive: true });
    await mkdir(join(root, 'Other'));
    await mkdir(join(root, '.trash', 'Old'), { recursive: true });
    await mkdir(join(root, '.hidden'));
    for (const path of ['Topic/Paper.pdf', 'Topic/Nested/Second.pdf', 'Other/Third.PDF', 'Topic/Paper-zh.pdf', 'Topic/Paper-en.pdf', 'Topic/Paper-dual.pdf', '.trash/Old/Deleted.pdf', '.hidden/Secret.pdf', 'Topic/.hidden.pdf']) await writeFile(join(root, path), `%PDF-1.7\n${path}\n%%EOF`);
    return { root, file: join(root, '.dpr-paper-catalog.json'), pdf: join(root, 'Topic', 'Paper.pdf') };
}
const errorCode = (code, root) => (e) => {
    assert.equal(e.code, code);
    assert.equal(e.message.includes(root), false, 'error is path-scrubbed');
    assert.equal(e.cause, undefined);
    return true;
};
function paperNamed(snapshot, name) { return Object.values(snapshot.papers).find((p) => p.name === name); }
function collectionNamed(snapshot, name) { return Object.values(snapshot.collections).find((c) => c.name === name); }

test('baseline assigns UUID identity recursively without touching PDF bytes or variants', async (t) => {
    const { createCatalog } = await api();
    const { root, file, pdf } = await fixture(t);
    const before = hash(await readFile(pdf));
    const catalog = createCatalog(root);
    assert.equal(createCatalog(root), catalog, 'one shared instance per real root');
    assert.throws(() => catalog.snapshot(), errorCode('not-ready', root));
    const snapshot = await catalog.initializeBaseline();
    assert.equal(snapshot.format, 'dpr-paper-catalog');
    assert.equal(snapshot.version, 1);
    assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.revision, hash(await readFile(file)));
    assert.equal(snapshot.generation, 1);
    assert.equal(snapshot.ingestSeq, 0);
    assert.equal(Object.keys(snapshot.collections).length, 3);
    assert.equal(Object.keys(snapshot.papers).length, 4, 'legacy leading-dot PDF inside an ordinary collection remains visible');
    const nested = collectionNamed(snapshot, 'Nested');
    assert.deepEqual(nested.segments, ['Topic', 'Nested']);
    assert.equal(nested.parentId, collectionNamed(snapshot, 'Topic').collectionId);
    for (const paper of Object.values(snapshot.papers)) {
        assert.match(paper.paperId, /^[a-f0-9-]{36}$/);
        assert.equal(paper.origin, 'baseline'); assert.equal(paper.ingestSeq, 0);
        assert.equal(paper.locationRevision, 1); assert.equal(paper.status, 'active');
    }
    assert.equal(hash(await readFile(pdf)), before);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1, 'disk counter is separate from raw SHA CAS token');
    assert.deepEqual(await catalog.initializeBaseline(), snapshot, 'idempotent initialization');
});

test('sync list and canonical resolvers include IDs and legacy sidecar paths', async (t) => {
    const { createCatalog } = await api();
    const { root } = await fixture(t);
    const catalog = createCatalog(root), snap = await catalog.initializeBaseline();
    const topic = collectionNamed(snap, 'Topic'), nested = collectionNamed(snap, 'Nested');
    assert.equal(catalog.listCollections().length, 3);
    assert.equal(catalog.listPapers({ collectionId: topic.collectionId }).length, 2);
    assert.equal(catalog.listPapers({ collectionId: topic.collectionId, recursive: true }).length, 3);
    const ref = catalog.resolvePaper({ topic: 'Topic/Nested', name: 'Second' });
    assert.equal(ref.collectionId, nested.collectionId); assert.equal(ref.topic, 'Topic/Nested');
    assert.deepEqual(ref.segments, ['Topic', 'Nested']);
    assert.equal(ref.pdfPath, join(root, 'Topic', 'Nested', 'Second.pdf'));
    assert.equal(ref.txtPath, join(root, 'Topic', 'Nested', 'Second.txt'));
    assert.deepEqual(catalog.resolvePaper({ paperId: ref.paperId }), ref);
    assert.equal(catalog.resolveCollection({ collectionId: nested.collectionId }).dirPath, join(root, 'Topic', 'Nested'));
    assert.equal(catalog.resolvePaper({ topic: 'topic/nested', name: 'SECOND' }).paperId, ref.paperId);
    assert.ok(catalog.resolvePaper({ topic: 'Other', name: 'Third' }).pdfPath.endsWith('Third.PDF'));
});

test('snapshots and listed entries are detached; failed mutations never change catalog', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const snapshot = c.snapshot(); snapshot.ingestSeq = 999; Object.values(snapshot.collections)[0].name = 'changed';
    c.listCollections()[0].segments.push('changed'); c.listPapers()[0].name = 'changed';
    assert.deepEqual(c.snapshot(), before);
    await assert.rejects(c.transact(before.revision, (draft) => { draft.ingestSeq = 10; throw new Error('private path ' + root); }), errorCode('invalid', root));
    assert.equal(hash(await readFile(file)), before.revision);
    for (const mutate of [
        (d) => { d.collections[Object.keys(d.collections)[0]].segments = ['..']; },
        (d) => { d.sessionBindings.s = randomUUID(); },
        (d) => { d.operations.bad = { value: NaN }; },
        (d) => { d.operations.bad = JSON.parse('{"__proto__":{"polluted":1}}'); },
        (d) => { d.ingestSeq = -1; },
    ]) await assert.rejects(c.transact(before.revision, mutate), errorCode('invalid', root));
    assert.deepEqual(c.snapshot(), before);
});

test('transact re-reads disk, CAS rejects stale tokens and locks never leak', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const changed = await c.transact(before.revision, (draft) => { collectionNamed(draft, 'Topic').note = 'A note https://example.org'; });
    assert.equal(changed.generation, 2); assert.notEqual(changed.revision, before.revision);
    assert.equal(collectionNamed(changed, 'Topic').revision, 2);
    await assert.rejects(c.transact(before.revision, () => {}), errorCode('conflict', root));
    await assert.rejects(c.transact(null, () => {}), errorCode('invalid', root));
    assert.deepEqual((await readdir(root)).filter((n) => n.includes('.dpr-paper-catalog')), ['.dpr-paper-catalog.json']);
    assert.equal(changed.revision, hash(await readFile(file)));
});

test('claims retain all owners across rename and path reuse; bound sessions stay on original paper', async (t) => {
    const { createCatalog } = await api(); const { claimKey } = await pathsApi();
    const { root, pdf } = await fixture(t);
    const c = createCatalog(root), initial = await c.initializeBaseline();
    const original = paperNamed(initial, 'Paper');
    let state = await c.transact(initial.revision, (d) => { d.sessionBindings['dpr-old-1'] = original.paperId; });
    await rename(pdf, join(root, 'Topic', 'Renamed.pdf'));
    state = await c.transact(state.revision, (d) => { d.papers[original.paperId].name = 'Renamed'; });
    assert.equal(c.resolvePaper({ topic: 'Topic', name: 'Paper' }).paperId, original.paperId, 'unique old claim follows the same ID');
    assert.equal(c.resolvePaper({ sessionId: 'dpr-old-1' }).name, 'Renamed');
    await writeFile(pdf, '%PDF-1.7\nnew paper at reused path');
    const replacementId = randomUUID();
    state = await c.transact(state.revision, (d) => {
        d.ingestSeq++;
        d.papers[replacementId] = { ...original, paperId: replacementId, origin: 'import', ingestSeq: d.ingestSeq };
    });
    assert.deepEqual(new Set(state.claims[claimKey(['TOPIC'], 'PAPER')]), new Set([original.paperId, replacementId]));
    assert.throws(() => c.resolvePaper({ topic: 'Topic', name: 'Paper' }), errorCode('paper-ref-ambiguous', root));
    assert.equal(c.resolvePaper({ sessionId: 'dpr-old-1', topic: 'Topic', name: 'Paper' }).paperId, original.paperId);
    assert.equal(c.resolvePaper({ paperId: replacementId }).pdfPath, pdf);
    assert.equal(c.resolvePaper({ paperId: original.paperId }).locationRevision, 2);
    await assert.rejects(c.transact(state.revision, (d) => { d.sessionBindings['dpr-old-1'] = replacementId; }), errorCode('invalid', root));
    await assert.rejects(c.transact(state.revision, (d) => { d.claims[claimKey(['Topic'], 'Paper')] = [replacementId]; }), errorCode('invalid', root));
});

test('bound missing/trashed targets and unknown IDs never fall back to another named paper', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const c = createCatalog(root), first = await c.initializeBaseline();
    const p = paperNamed(first, 'Paper');
    const second = await c.transact(first.revision, (d) => { d.sessionBindings.exact = p.paperId; d.papers[p.paperId].status = 'missing'; });
    assert.throws(() => c.resolvePaper({ sessionId: 'exact', topic: 'Other', name: 'Third' }), errorCode('not-found', root));
    assert.throws(() => c.resolvePaper({ paperId: randomUUID(), topic: 'Other', name: 'Third' }), errorCode('not-found', root));
    await c.transact(second.revision, (d) => { d.papers[p.paperId].status = 'trashed'; });
    assert.throws(() => c.resolvePaper({ sessionId: 'exact' }), errorCode('gone', root));
});

test('unknown session binding fails closed even if a valid legacy name is also supplied', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const c = createCatalog(root); await c.initializeBaseline();
    assert.throws(() => c.resolvePaper({ sessionId: 'unbound-old-session', topic: 'Other', name: 'Third' }), errorCode('not-found', root));
});

test('transact admits only genuine old/current path claims, never arbitrary owner injection', async (t) => {
    const { createCatalog } = await api(); const { claimKey } = await pathsApi(); const { root } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const original = paperNamed(before, 'Paper'), third = paperNamed(before, 'Third');
    await assert.rejects(c.transact(before.revision, (d) => { d.claims[claimKey(['Other'], 'Third')].push(original.paperId); }), errorCode('invalid', root));
    await assert.rejects(c.transact(before.revision, (d) => { d.claims[claimKey(['Topic'], 'NeverOccupied')] = [third.paperId]; }), errorCode('invalid', root));
    assert.deepEqual(c.snapshot(), before);
});

test('transact refuses active entries without real source files and preserves original index', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    await assert.rejects(c.transact(before.revision, (d) => {
        const old = paperNamed(d, 'Paper'), id = randomUUID(); d.ingestSeq++;
        d.papers[id] = { ...old, paperId: id, name: 'Absent', origin: 'import', ingestSeq: d.ingestSeq };
    }), errorCode('not-found', root));
    assert.equal(hash(await readFile(file)), before.revision);
    assert.deepEqual((await readdir(root)).filter((n) => n.includes('.dpr-paper-catalog')), ['.dpr-paper-catalog.json']);
});

test('distinct physical Unicode-normalized roots never share catalog identity', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const a = join(root, 'caf\u00e9'), b = join(root, 'cafe\u0301');
    await mkdir(join(a, 'Topic'), { recursive: true }); await mkdir(join(b, 'Topic'), { recursive: true });
    const aStat = await lstat(a), bStat = await lstat(b);
    if (aStat.dev === bStat.dev && aStat.ino === bStat.ino) { t.skip('filesystem aliases Unicode normalization forms'); return; }
    await writeFile(join(a, 'Topic', 'Paper.pdf'), '%PDF-1.7\nroot A');
    await writeFile(join(b, 'Topic', 'Paper.pdf'), '%PDF-1.7\nroot B');
    const first = createCatalog(a), second = createCatalog(b);
    assert.notEqual(first, second);
    await first.initializeBaseline(); await second.initializeBaseline();
    assert.equal(first.resolvePaper({ topic: 'Topic', name: 'Paper' }).pdfPath, join(a, 'Topic', 'Paper.pdf'));
    assert.equal(second.resolvePaper({ topic: 'Topic', name: 'Paper' }).pdfPath, join(b, 'Topic', 'Paper.pdf'));
});

test('an existing catalog instance rejects physical root replacement at the same pathname', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const dir = join(root, 'BoundRoot'); await mkdir(join(dir, 'Topic'), { recursive: true });
    await writeFile(join(dir, 'Topic', 'Paper.pdf'), '%PDF-1.7\noriginal bound root');
    const old = createCatalog(dir); await old.initializeBaseline();
    await rename(dir, join(root, 'HeldRoot')); await mkdir(join(dir, 'Topic'), { recursive: true });
    await writeFile(join(dir, 'Topic', 'Paper.pdf'), '%PDF-1.7\nreplacement root');
    const replacement = createCatalog(dir); await replacement.initializeBaseline();
    assert.notEqual(replacement, old);
    assert.throws(() => old.resolvePaper({ topic: 'Topic', name: 'Paper' }), errorCode('invalid', root));
});

test('mutator changing its retained draft during publication cannot alter the acknowledged snapshot', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const returned = await c.transact(before.revision, (draft) => {
        collectionNamed(draft, 'Topic').note = 'intended';
        setImmediate(() => { collectionNamed(draft, 'Topic').note = 'late-mutation'; });
    });
    assert.deepEqual(returned, c.snapshot());
    assert.equal(collectionNamed(returned, 'Topic').note, 'intended');
});

test('late mutator references and asynchronous local work stay detached from committed state', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline(); let retained;
    const changed = await c.transact(before.revision, async (draft) => {
        retained = draft; await Promise.resolve(); draft.operations['local-op'] = { ok: true };
    });
    retained.operations['local-op'].ok = false;
    assert.deepEqual(c.snapshot(), changed);
});

test('baseline reopens stable identities in another Node process without rescanning new PDFs', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const first = await createCatalog(root).initializeBaseline();
    await writeFile(join(root, 'Topic', 'New.pdf'), '%PDF-1.7\nnot enrolled by baseline reload');
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();console.log(JSON.stringify(c.snapshot()));`;
    const child = await runNode(script);
    assert.equal(child.code, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), first);
});

test('invalid catalog JSON/schema is kept verbatim instead of rebuilt from PDFs', async (t) => {
    const { createCatalog } = await api();
    for (const text of ['{broken', '{"format":"wrong"}', JSON.stringify({ format: 'dpr-paper-catalog', version: 99 })]) {
        const { root, file } = await fixture(t); await writeFile(file, text);
        const c = createCatalog(root);
        await assert.rejects(c.initializeBaseline(), errorCode('catalog-invalid', root));
        assert.equal(await readFile(file, 'utf8'), text);
        assert.throws(() => c.snapshot(), errorCode('not-ready', root));
    }
});

test('hierarchy validation rejects cycles, duplicate casefold paths and paper location mismatch', async (t) => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const c = createCatalog(root), first = await c.initializeBaseline();
    const topic = collectionNamed(first, 'Topic'), nested = collectionNamed(first, 'Nested');
    for (const mutate of [
        (d) => { d.collections[topic.collectionId].parentId = nested.collectionId; },
        (d) => { const id = randomUUID(); d.collections[id] = { ...topic, collectionId: id, name: 'TOPIC', segments: ['TOPIC'] }; },
        (d) => { paperNamed(d, 'Paper').segments = ['Other']; },
        (d) => { delete d.papers[paperNamed(d, 'Paper').paperId]; },
        (d) => { paperNamed(d, 'Paper').origin = 'import'; },
    ]) await assert.rejects(c.transact(first.revision, mutate), errorCode('invalid', root));
});

test('collection-path helpers reject traversal, ADS, device names, trailing aliases and excessive paths', async (t) => {
    const { validateSegment, validateSegments, claimKey, resolveCollectionPath } = await pathsApi();
    const { root } = await fixture(t);
    for (const value of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'C:', 'doc:stream', 'CON', 'nul.pdf', 'LPT1', 'aux.txt', 'a.', 'a ', '.trash', '.hidden', 'a\u0000b']) assert.throws(() => validateSegment(value), `${value}`);
    assert.throws(() => validateSegments(Array(33).fill('x')));
    assert.throws(() => validateSegments(Array(15).fill('x'.repeat(120))));
    assert.throws(() => resolveCollectionPath(root, ['..']));
    assert.equal(claimKey(['TOPIC', 'NESTED'], 'Paper'), JSON.stringify([['topic', 'nested'], 'paper']));
    assert.equal(resolveCollectionPath(root, ['Topic', 'Nested']), join(root, 'Topic', 'Nested'));
    assert.equal(resolveCollectionPath(root, ['Topic', 'New'], { allowMissingLeaf: true }), join(root, 'Topic', 'New'));
});

test('junctions and file symlinks never enter baseline and resolvers reject linked components', async (t) => {
    const { createCatalog } = await api(); const { resolveCollectionPath } = await pathsApi();
    const { root } = await fixture(t);
    const outside = await mkdtemp(join(tmpdir(), 'dpr-catalog-outside-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, 'Outside.pdf'), '%PDF-1.7\nexternal');
    await symlink(outside, join(root, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => resolveCollectionPath(root, ['Linked']), errorCode('invalid', root));
    const c = createCatalog(root), snapshot = await c.initializeBaseline();
    assert.equal(Object.values(snapshot.papers).some((p) => p.name === 'Outside'), false);
    const real = join(root, 'Topic'), held = join(root, 'Topic-held');
    await rename(real, held);
    await symlink(outside, real, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => c.resolvePaper({ paperId: paperNamed(snapshot, 'Paper').paperId }), errorCode('invalid', root));
});

test('invalid collection IDs and Windows console device names are rejected consistently', async (t) => {
    const { createCatalog } = await api(); const { validateSegment } = await pathsApi(); const { root } = await fixture(t);
    const c = createCatalog(root); await c.initializeBaseline();
    for (const id of ['constructor', '__proto__', '', 42]) {
        assert.throws(() => c.resolveCollection({ collectionId: id }), errorCode('invalid', root));
        assert.throws(() => c.listPapers({ collectionId: id }), errorCode('invalid', root));
    }
    for (const name of ['CONIN$', 'CONOUT$', 'conin$.txt']) assert.throws(() => validateSegment(name), errorCode('invalid', root));
});

test('serialized byte ceiling includes final newline and failed oversize publish preserves old file', async (t) => {
    const { createCatalog, MAX_CATALOG_BYTES } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    await assert.rejects(c.transact(before.revision, (d) => {
        d.operations.limit = Array(32).fill('');
        let needed = MAX_CATALOG_BYTES - Buffer.byteLength(JSON.stringify(d));
        for (let i = 0; i < 32; i++) { const count = Math.min(262144, needed); d.operations.limit[i] = 'x'.repeat(count); needed -= count; }
        assert.equal(needed, 0);
        assert.equal(Buffer.byteLength(JSON.stringify(d)), MAX_CATALOG_BYTES);
    }), errorCode('invalid', root));
    assert.equal(hash(await readFile(file)), before.revision);
});

test('Windows transient atomic rename contention retries under the same catalog lock', async (t) => {
    if (process.platform !== 'win32') { t.skip('Windows sharing violation retry'); return; }
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const originalRename = fsPromises.rename; let attempts = 0;
    const hook = t.mock.method(fsPromises, 'rename', async (from, to) => {
        if (to === file && attempts++ === 0) { const e = new Error('temporary sharing violation'); e.code = 'EPERM'; throw e; }
        return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try {
        const after = await c.transact(before.revision, (d) => { d.operations.retry = { ok: true }; });
        assert.equal(attempts, process.platform === 'win32' ? 2 : 1);
        assert.equal(after.generation, 2);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('rename retries retain CAS protection and persistent permission errors preserve old data', async (t) => {
    if (process.platform !== 'win32') { t.skip('Windows sharing violation retry'); return; }
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const originalRename = fsPromises.rename; let attempts = 0;
    let hook = t.mock.method(fsPromises, 'rename', async (from, to) => {
        if (to === file) { attempts++; const e = new Error('persistent permission'); e.code = 'EPERM'; throw e; }
        return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(c.transact(before.revision, (d) => { d.operations.denied = true; }), errorCode('io', root)); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(attempts, 6); assert.equal(hash(await readFile(file)), before.revision);
    let changedRaw;
    hook = t.mock.method(fsPromises, 'rename', async (from, to) => {
        if (to === file) {
            const changed = JSON.parse(await readFile(file, 'utf8')); changed.operations.external = true;
            changedRaw = JSON.stringify(changed); await writeFile(file, changedRaw);
            const e = new Error('temporary sharing violation'); e.code = 'EPERM'; throw e;
        }
        return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(c.transact(before.revision, (d) => { d.operations.stale = true; }), errorCode('conflict', root)); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(await readFile(file, 'utf8'), changedRaw);
    assert.deepEqual((await readdir(root)).filter((n) => n.includes('.dpr-paper-catalog')), ['.dpr-paper-catalog.json']);
});

test('atomic index replacement between lstat and open is contention, not index corruption', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), before = await c.initializeBaseline();
    const replacement = file + '.test-replacement';
    await writeFile(replacement, await readFile(file));
    const originalOpen = fsSync.openSync; let swapped = false;
    const hook = t.mock.method(fsSync, 'openSync', (path, ...args) => {
        if (path === file && !swapped) { swapped = true; fsSync.renameSync(replacement, file); }
        return originalOpen(path, ...args);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => c.snapshot(), errorCode('conflict', root)); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(swapped, true); assert.deepEqual(c.snapshot(), before);
});

test('catalog lock contention is conflict and unsafe/non-file index or lock is rejected', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), state = await c.initializeBaseline();
    await writeFile(file + '.lock', 'owned elsewhere');
    await assert.rejects(c.transact(state.revision, () => {}), errorCode('conflict', root));
    assert.equal(await readFile(file + '.lock', 'utf8'), 'owned elsewhere');
    await rm(file + '.lock'); await mkdir(file + '.lock');
    await assert.rejects(c.transact(state.revision, () => {}), errorCode('invalid', root));
});

test('strict new target rejects lone surrogates without rejecting paired emoji', async () => {
    const { validateSegment } = await pathsApi();
    assert.throws(() => validateSegment('\ud800'), { code: 'invalid' });
    assert.throws(() => validateSegment('\udc00'), { code: 'invalid' });
    assert.equal(validateSegment('Paper😀'), 'Paper😀');
});

test('legacy boundary validators retain filesystem-length names while strict targets reject malformed Unicode', async () => {
    const { validateSegment, validateSegments, validateLegacySegment, validateLegacySegments } = await pathsApi();
    assert.equal(typeof validateLegacySegment, 'function'); assert.equal(typeof validateLegacySegments, 'function');
    for (const name of ['x'.repeat(140), 'x'.repeat(255), 'foo..bar', '.hidden', '😀'.repeat(127) + 'x'])
        assert.equal(validateLegacySegment(name), name);
    assert.deepEqual(validateLegacySegments(['x'.repeat(140), 'foo..bar']), ['x'.repeat(140), 'foo..bar']);
    for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'doc:stream', 'nul.pdf', 'CONIN$', 'LPT¹', 'a.', 'a ', 'a\u0000b', '\ud800', '\udc00', 'x'.repeat(256)])
        assert.throws(() => validateLegacySegment(name), { code: 'invalid' });
    for (const name of ['x'.repeat(121), 'foo..bar', '.hidden', '\ud800', '\udc00'])
        assert.throws(() => validateSegment(name), { code: 'invalid' });
    assert.equal(validateSegment('😀'.repeat(60)), '😀'.repeat(60));
    assert.throws(() => validateSegment('😀'.repeat(61)), { code: 'invalid' });
    assert.throws(() => validateSegments(['ok', '\ud800']), { code: 'invalid' });
    assert.throws(() => validateLegacySegments(['ok', '\ud800']), { code: 'invalid' });
    assert.throws(() => validateLegacySegments(Array(33).fill('ok')), { code: 'invalid' });
    assert.throws(() => validateLegacySegments(Array(5).fill('x'.repeat(255))), { code: 'invalid' });
});

test('legacy long/internal-dot/leading-dot PDFs baseline and restart preserve ID, session and exact source bytes', async t => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const longParent = 'Parent' + 'x'.repeat(135), longName = 'x'.repeat(140);
    await mkdir(join(root, longParent));
    await mkdir(join(root, '.dpr-paper-meta', 'paper'), { recursive: true });
    await writeFile(join(root, '.dpr-paper-meta', 'paper', 'Private.pdf'), '%PDF metadata is not a library');
    const refs = [
        { segments: ['Topic'], name: longName }, { segments: ['Topic'], name: 'foo..bar' },
        { segments: ['Topic'], name: '.hidden' }, { segments: [longParent], name: 'Old' },
        { segments: ['Topic'], name: 'emoji😀' }, { segments: ['Topic'], name: 'z'.repeat(251) },
    ];
    const original = [];
    for (const ref of refs) {
        const path = join(root, ...ref.segments, ref.name + '.pdf');
        await writeFile(path, `%PDF-1.7\nlegacy ${ref.name}`); original.push(hash(await readFile(path)));
    }
    const catalog = createCatalog(root); let state = await catalog.initializeBaseline();
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i], resolved = catalog.resolvePaper({ topic: ref.segments.join('/'), name: ref.name });
        assert.equal(resolved.name, ref.name); assert.equal(hash(await readFile(resolved.pdfPath)), original[i]);
        ref.paperId = resolved.paperId; ref.sessionId = `legacy-session-${i}`;
    }
    state = await catalog.transact(state.revision, d => {
        for (const ref of refs) d.sessionBindings[ref.sessionId] = ref.paperId;
        collectionNamed(d, longParent).note = 'kept while validating legacy names';
    });
    for (const ref of refs) assert.equal(catalog.resolvePaper({ sessionId: ref.sessionId }).paperId, ref.paperId);
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();const refs=${JSON.stringify(refs)};console.log(JSON.stringify({state:c.snapshot(),refs:refs.map(r=>[c.resolvePaper({paperId:r.paperId}),c.resolvePaper({topic:r.segments.join('/'),name:r.name}),c.resolvePaper({sessionId:r.sessionId})])}));`;
    const child = await runNode(script); assert.equal(child.code, 0, child.stderr);
    const reopened = JSON.parse(child.stdout); assert.deepEqual(reopened.state, state);
    for (let i = 0; i < refs.length; i++) for (const resolved of reopened.refs[i]) {
        assert.equal(resolved.paperId, refs[i].paperId); assert.equal(resolved.name, refs[i].name);
        assert.equal(hash(await readFile(resolved.pdfPath)), original[i]);
    }
    assert.equal(Object.values(state.collections).some(c => c.segments.some(s => s.startsWith('.'))), false);
    assert.equal(Object.values(state.papers).some(p => ['Secret', 'Deleted', 'Private'].includes(p.name)), false);
});

test('already persisted legacy state and historical claims stay readable through ID, name and session', async t => {
    const { createCatalog } = await api(); const { root, file, pdf } = await fixture(t);
    const catalog = createCatalog(root); const initial = await catalog.initializeBaseline();
    const paper = paperNamed(initial, 'Paper'), longName = 'Old' + 'x'.repeat(137);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    await rename(pdf, join(root, 'Topic', longName + '.pdf'));
    raw.papers[paper.paperId].name = longName;
    raw.claims[JSON.stringify([['topic'], longName.toLowerCase()])] = [paper.paperId];
    raw.sessionBindings['old-exact-session'] = paper.paperId;
    await writeFile(file, JSON.stringify(raw));
    const loaded = catalog.snapshot();
    assert.equal(loaded.papers[paper.paperId].name, longName);
    for (const locator of [{ paperId: paper.paperId }, { topic: 'Topic', name: longName },
        { topic: 'Topic', name: 'Paper' }, { sessionId: 'old-exact-session' }])
        assert.equal(catalog.resolvePaper(locator).pdfPath, join(root, 'Topic', longName + '.pdf'));
    const next = await catalog.transact(loaded.revision, d => { d.operations['metadata-only'] = true; });
    assert.equal(next.papers[paper.paperId].name, longName);
});

test('existing/source path helpers allow legacy parents and leaves; missing-leaf target stays strict', async t => {
    const { resolveCollectionPath, resolvePdfPath } = await pathsApi(); const { root } = await fixture(t);
    const parent = 'p'.repeat(140), oldName = 'x'.repeat(140);
    await mkdir(join(root, parent, 'foo..bar'), { recursive: true });
    for (const name of [oldName, 'foo..bar', '.hidden']) await writeFile(join(root, parent, name + '.pdf'), '%PDF legacy');
    assert.equal(resolveCollectionPath(root, [parent, 'foo..bar']), join(root, parent, 'foo..bar'));
    assert.equal(resolveCollectionPath(root, [parent, 'Short'], { allowMissingLeaf: true }), join(root, parent, 'Short'));
    for (const name of [oldName, 'foo..bar', '.hidden']) {
        assert.equal(resolvePdfPath(root, [parent], name), join(root, parent, name + '.pdf'));
        assert.throws(() => resolvePdfPath(root, [parent], name, { allowMissingLeaf: true }), { code: 'invalid' });
    }
    assert.equal(resolvePdfPath(root, [parent], 'Short', { allowMissingLeaf: true }), join(root, parent, 'Short.pdf'));
    for (const name of [parent, 'foo..bar', '.hidden', '\ud800'])
        assert.throws(() => resolveCollectionPath(root, [parent, name], { allowMissingLeaf: true }), { code: 'invalid' });
    assert.throws(() => resolvePdfPath(root, [parent], 'x'.repeat(252)), { code: 'invalid' });
});

test('short new child and imported paper under a legacy long parent remain strict transaction targets', async t => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const parent = 'p'.repeat(140); await mkdir(join(root, parent));
    await writeFile(join(root, parent, 'Old.pdf'), '%PDF old');
    const catalog = createCatalog(root); const first = await catalog.initializeBaseline();
    const owner = collectionNamed(first, parent), id = randomUUID();
    await mkdir(join(root, parent, 'Short')); await writeFile(join(root, parent, 'Short', 'New.pdf'), '%PDF new');
    const paperId = randomUUID();
    const committed = await catalog.transact(first.revision, d => {
        d.collections[id] = { collectionId: id, parentId: owner.collectionId, name: 'Short', segments: [parent, 'Short'], revision: 1, note: '' };
        d.ingestSeq++;
        d.papers[paperId] = { paperId, collectionId: id, name: 'New', segments: [parent, 'Short'], locationRevision: 1, status: 'active', origin: 'import', ingestSeq: d.ingestSeq };
    });
    assert.equal(catalog.resolveCollection({ collectionId: id }).dirPath, join(root, parent, 'Short'));
    assert.equal(catalog.resolvePaper({ paperId }).pdfPath, join(root, parent, 'Short', 'New.pdf'));
    for (const name of ['x'.repeat(140), 'foo..bar', '.hidden', '\ud800']) {
        if (name.isWellFormed()) await writeFile(join(root, parent, 'Short', name + '.pdf'), '%PDF external source');
        await assert.rejects(catalog.transact(committed.revision, d => {
            const nextId = randomUUID(); d.ingestSeq++;
            d.papers[nextId] = { ...d.papers[paperId], paperId: nextId, name, ingestSeq: d.ingestSeq };
        }), { code: 'invalid' });
        await assert.rejects(catalog.transact(committed.revision, d => { d.papers[paperId].name = name; }), { code: 'invalid' });
        if (name.isWellFormed()) await mkdir(join(root, parent, 'Short', name));
        await assert.rejects(catalog.transact(committed.revision, d => {
            const nextId = randomUUID();
            d.collections[nextId] = { collectionId: nextId, parentId: id, name, segments: [parent, 'Short', name], revision: 1, note: '' };
        }), { code: 'invalid' });
    }
    assert.deepEqual(catalog.snapshot(), committed);
});

test('newly visible leading-dot PDF names retain NFC collision protection', async t => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const composed = join(root, 'Topic', '.caf\u00e9.pdf'), decomposed = join(root, 'Topic', '.cafe\u0301.pdf');
    await writeFile(composed, '%PDF composed', { flag: 'wx' });
    try { await writeFile(decomposed, '%PDF decomposed', { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') { t.skip('filesystem aliases Unicode normalization forms'); return; } throw e; }
    await assert.rejects(createCatalog(root).initializeBaseline(), { code: 'path-collision', status: 409 });
    assert.equal(await readFile(composed, 'utf8'), '%PDF composed');
    assert.equal(await readFile(decomposed, 'utf8'), '%PDF decomposed');
    assert.equal((await readdir(root)).includes('.dpr-paper-catalog.json'), false);
});

test('renaming an ancestor keeps legacy descendant basenames and historical claims usable', async t => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const child = 'c'.repeat(140);
    await mkdir(join(root, 'Before', child), { recursive: true });
    await writeFile(join(root, 'Before', child, 'foo..bar.pdf'), '%PDF legacy child');
    const catalog = createCatalog(root); const initial = await catalog.initializeBaseline();
    const original = paperNamed(initial, 'foo..bar');
    await rename(join(root, 'Before'), join(root, 'After'));
    const next = await catalog.transact(initial.revision, d => {
        for (const c of Object.values(d.collections)) if (c.segments[0] === 'Before') {
            c.segments[0] = 'After'; if (c.parentId === null) c.name = 'After';
        }
        for (const p of Object.values(d.papers)) if (p.segments[0] === 'Before') p.segments[0] = 'After';
        d.sessionBindings.ancestor = original.paperId;
    });
    assert.equal(catalog.resolvePaper({ paperId: original.paperId }).pdfPath, join(root, 'After', child, 'foo..bar.pdf'));
    assert.equal(catalog.resolvePaper({ topic: `Before/${child}`, name: 'foo..bar' }).paperId, original.paperId);
    assert.equal(catalog.resolvePaper({ sessionId: 'ancestor' }).paperId, original.paperId);
    assert.equal(next.papers[original.paperId].locationRevision, 2);
});

test('a real legacy session prefix for a 200-Han stem binds exactly and survives restart', async t => {
    const { createCatalog } = await api(); const { root } = await fixture(t), name = '文'.repeat(200);
    const path = join(root, 'Topic', name + '.pdf');
    try { await writeFile(path, '%PDF long Chinese legacy name'); }
    catch (e) { if (e.code === 'ENAMETOOLONG') { t.skip('filesystem limits bytes rather than Windows UTF-16 leaf units'); return; } throw e; }
    const sid = `dpr-${Buffer.from(`Topic/${name}`).toString('base64url')}`;
    assert.ok(sid.length > 800);
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    const original = paperNamed(first, name);
    await catalog.transact(first.revision, d => { d.sessionBindings[sid] = original.paperId; });
    assert.equal(catalog.resolvePaper({ sessionId: sid }).paperId, original.paperId);
    const child = await runNode(`import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();console.log(c.resolvePaper({sessionId:${JSON.stringify(sid)}}).paperId);`);
    assert.equal(child.code, 0, child.stderr); assert.equal(child.stdout, original.paperId);
    assert.equal(await readFile(path, 'utf8'), '%PDF long Chinese legacy name');
});

test('session-binding keys accept 8192 units while retaining control, immutable and other JSON-key limits', async t => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    const original = paperNamed(first, 'Paper'), other = paperNamed(first, 'Third'), sid = 's'.repeat(8192);
    const next = await catalog.transact(first.revision, d => { d.sessionBindings[sid] = original.paperId; });
    assert.equal(catalog.resolvePaper({ sessionId: sid }).paperId, original.paperId);
    const beforeBytes = await readFile(file);
    for (const mutate of [
        d => { d.sessionBindings[sid + 'x'] = original.paperId; },
        d => { d.sessionBindings['bad\ncontrol'] = original.paperId; },
        d => { d.sessionBindings[sid] = other.paperId; },
        d => { delete d.sessionBindings[sid]; },
        d => { d.operations['not-session'] = { ['k'.repeat(4097)]: true }; },
    ]) {
        await assert.rejects(catalog.transact(next.revision, mutate), { code: 'invalid' });
        assert.deepEqual(await readFile(file), beforeBytes);
    }
    assert.deepEqual(catalog.snapshot(), next);
});

test('previously readable ASCII, Chinese and combining claim bytes remain unchanged', async t => {
    const { createCatalog } = await api(); const { claimKey } = await pathsApi(); const { root } = await fixture(t);
    const names = ['Paper', '中文', 'cafe\u0301', '\u0130'];
    for (const name of names.slice(1)) await writeFile(join(root, 'Topic', name + '.pdf'), '%PDF previous readable');
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    for (const name of names) {
        const oldKey = JSON.stringify([['topic'], name.normalize('NFC').toLowerCase()]);
        assert.equal(claimKey(['Topic'], name), oldKey);
        assert.ok(Object.hasOwn(first.claims, oldKey));
    }
    const previousBytes = Buffer.from(JSON.stringify(first.claims));
    const next = await catalog.transact(first.revision, d => { d.operations['unchanged-claims'] = true; });
    assert.deepEqual(Buffer.from(JSON.stringify(next.claims)), previousBytes);
    assert.deepEqual(Buffer.from(JSON.stringify(catalog.snapshot().claims)), previousBytes);
});

test('lowercase-created NFC compositions baseline and reopen with stable claim keys', async t => {
    const { createCatalog } = await api(); const { claimKey, validateClaimKey, foldName } = await pathsApi();
    const { root } = await fixture(t), name = 'Greek\u03aa\u0301';
    const path = join(root, 'Topic', name + '.pdf'); await writeFile(path, '%PDF exact Greek spelling');
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    assert.equal(foldName(foldName(name)), foldName(name));
    assert.equal(foldName(name), foldName(name).normalize('NFC'));
    const original = paperNamed(first, name), key = claimKey(['Topic'], name);
    assert.equal(validateClaimKey(key), key);
    const next = await catalog.transact(first.revision, d => { d.sessionBindings.greek = original.paperId; });
    assert.deepEqual(catalog.snapshot(), next);
    const child = await runNode(`import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();console.log(JSON.stringify([c.resolvePaper({paperId:${JSON.stringify(original.paperId)}}).paperId,c.resolvePaper({topic:'Topic',name:${JSON.stringify(name)}}).paperId,c.resolvePaper({sessionId:'greek'}).paperId]));`);
    assert.equal(child.code, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), Array(3).fill(original.paperId));
    assert.equal(await readFile(path, 'utf8'), '%PDF exact Greek spelling');
});

test('post-lowercase NFC collisions fail closed before creating a catalog', async t => {
    const { createCatalog } = await api(); const { root } = await fixture(t);
    const a = join(root, 'Topic', 'Greek\u03aa\u0301.pdf'), b = join(root, 'Topic', 'Greek\u0390.pdf');
    await writeFile(a, '%PDF uppercase decomposed', { flag: 'wx' });
    try { await writeFile(b, '%PDF lowercase composed', { flag: 'wx' }); }
    catch (e) { if (e.code === 'EEXIST') { t.skip('filesystem already aliases the case/normalization pair'); return; } throw e; }
    await assert.rejects(createCatalog(root).initializeBaseline(), { code: 'path-collision', status: 409 });
    assert.equal(await readFile(a, 'utf8'), '%PDF uppercase decomposed');
    assert.equal(await readFile(b, 'utf8'), '%PDF lowercase composed');
    assert.equal((await readdir(root)).includes('.dpr-paper-catalog.json'), false);
});

for (const unit of ['\u0130', '\u0344']) test(`fold-expanding legacy stem U+${unit.codePointAt(0).toString(16)} survives claims reload and exact sessions`, async t => {
    const { createCatalog } = await api(); const { claimKey, foldName } = await pathsApi();
    const { root } = await fixture(t), name = unit.repeat(128);
    assert.equal(name.length, 128); assert.ok(foldName(name).length > 255);
    const path = join(root, 'Topic', name + '.pdf');
    try { await writeFile(path, '%PDF physical spelling is preserved'); }
    catch (e) { if (e.code === 'ENAMETOOLONG') { t.skip('filesystem limits bytes rather than Windows UTF-16 leaf units'); return; } throw e; }
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    const original = paperNamed(first, name);
    assert.ok(first.claims[claimKey(['Topic'], name)].includes(original.paperId));
    const next = await catalog.transact(first.revision, d => { d.sessionBindings.expanded = original.paperId; });
    for (const locator of [{ paperId: original.paperId }, { topic: 'Topic', name }, { sessionId: 'expanded' }])
        assert.equal(catalog.resolvePaper(locator).pdfPath, path);
    assert.deepEqual(catalog.snapshot(), next);
    const child = await runNode(`import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();console.log(JSON.stringify([c.resolvePaper({paperId:${JSON.stringify(original.paperId)}}).paperId,c.resolvePaper({topic:'Topic',name:${JSON.stringify(name)}}).paperId,c.resolvePaper({sessionId:'expanded'}).paperId]));`);
    assert.equal(child.code, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), Array(3).fill(original.paperId));
    assert.equal(await readFile(path, 'utf8'), '%PDF physical spelling is preserved');
});

test('fold-expanding existing parent paths may exceed canonical physical-length budgets without losing claims', async t => {
    const { createCatalog } = await api(); const { claimKey, foldName } = await pathsApi(); const { root } = await fixture(t);
    const segments = Array(5).fill('\u0130'.repeat(120));
    assert.ok(segments.join('/').length < 1024); assert.ok(segments.map(foldName).join('/').length > 1024);
    await mkdir(join(root, ...segments), { recursive: true });
    await writeFile(join(root, ...segments, 'Short.pdf'), '%PDF long canonical parent');
    const catalog = createCatalog(root), first = await catalog.initializeBaseline();
    const original = Object.values(first.papers).find(p => p.name === 'Short' && p.segments.length === 5);
    assert.ok(first.claims[claimKey(segments, 'Short')].includes(original.paperId));
    const next = await catalog.transact(first.revision, d => { d.sessionBindings.expandedParent = original.paperId; });
    assert.equal(catalog.resolvePaper({ paperId: original.paperId }).pdfPath, join(root, ...segments, 'Short.pdf'));
    assert.equal(catalog.resolvePaper({ topic: segments.join('/'), name: 'Short' }).paperId, original.paperId);
    assert.equal(catalog.resolvePaper({ sessionId: 'expandedParent' }).paperId, original.paperId);
    assert.deepEqual(catalog.snapshot(), next);
});

test('stored canonical claim validation separates normalized lengths from physical source and strict target policies', async () => {
    const { validateClaimKey, claimKey, validateSegment, validateLegacySegment } = await pathsApi();
    assert.equal(typeof validateClaimKey, 'function');
    const physical = '\u0130'.repeat(128), key = claimKey(['Topic'], physical);
    assert.equal(validateClaimKey(key), key);
    assert.equal(validateLegacySegment(physical), physical);
    assert.throws(() => validateSegment(physical), { code: 'invalid' });
    for (const value of ['{bad', JSON.stringify([[], 'name']), JSON.stringify([['TOPIC'], 'name']),
        JSON.stringify([['topic'], '../escape']), JSON.stringify([['topic'], 'doc:stream']),
        JSON.stringify([['topic'], '\ud800']), JSON.stringify([['topic'], 'nul.pdf']),
        JSON.stringify([['topic'], 'x'.repeat(4096)]), '[ ["topic"], "name" ]'])
        assert.throws(() => validateClaimKey(value), { code: 'invalid' });
});

function runNode(script) {
    // Trace only syscall names/errno in child failures; never expose temporary absolute paths.
    const trace = `import traceFs from 'node:fs';import tracePromises from 'node:fs/promises';import {syncBuiltinESMExports as traceSync} from 'node:module';for(const name of ['openSync','lstatSync','readSync','closeSync']){const old=traceFs[name];traceFs[name]=(...args)=>{try{return old(...args)}catch(e){console.error(name+':'+e.code);throw e}}}for(const name of ['open','lstat','rename','unlink']){const old=tracePromises[name];tracePromises[name]=async(...args)=>{try{return await old(...args)}catch(e){console.error(name+':'+e.code);throw e}}}traceSync();`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', trace + script], { windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject); child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    });
}
test('independent Node writers sharing one catalog revision have exactly one winner', async (t) => {
    const { createCatalog } = await api(); const { root, file } = await fixture(t);
    const c = createCatalog(root), state = await c.initializeBaseline();
    const writers = await Promise.all(Array.from({ length: 4 }, (_, i) => runNode(`import {createCatalog} from ${JSON.stringify(catalogUrl)};try{const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();await c.transact(${JSON.stringify(state.revision)},d=>{d.operations[${JSON.stringify('op-' + i)}]={ok:true}});console.log('ok')}catch(e){console.log(e.code);process.exitCode=e.code==='conflict'?2:3}`)));
    assert.equal(writers.filter((r) => r.code === 0).length, 1, JSON.stringify(writers));
    assert.equal(writers.filter((r) => r.code === 2 && r.stdout === 'conflict').length, 3, JSON.stringify(writers));
    const latest = c.snapshot(); assert.equal(latest.generation, 2); assert.equal(Object.keys(latest.operations).length, 1);
    assert.equal(hash(await readFile(file)), latest.revision);
    assert.deepEqual((await readdir(root)).filter((n) => n.includes('.dpr-paper-catalog')), ['.dpr-paper-catalog.json']);
});

// Existing-delete identity compatibility: all physical lifecycle effects below are temp-directory renames.
const activeCollection = c => (c.status ?? 'active') === 'active';
async function trashKnownCollection(catalog, root, collectionId) {
    const before=catalog.snapshot(), target=before.collections[collectionId];
    const descendants=new Set([collectionId]);let grew=true;
    while(grew){grew=false;for(const c of Object.values(before.collections))if(descendants.has(c.parentId)&&!descendants.has(c.collectionId)){descendants.add(c.collectionId);grew=true;}}
    await rename(join(root,...target.segments),join(root,'.held-'+randomUUID()));
    return catalog.transact(before.revision,d=>{for(const id of descendants)d.collections[id].status='trashed';for(const p of Object.values(d.papers))if(descendants.has(p.collectionId))p.status='trashed';});
}
test('delete identity v1 optional collection fields expose known claims without rewriting baseline bytes',async t=>{
    const {createCatalog}=await api();const {root,file}=await fixture(t);const c=createCatalog(root);await c.initializeBaseline();
    const raw=JSON.parse(await readFile(file,'utf8'));delete raw.collectionClaims;for(const row of Object.values(raw.collections))delete row.status;await writeFile(file,JSON.stringify(raw));const original=await readFile(file);
    const loaded=c.snapshot();assert.equal(loaded.version,1);assert.equal(loaded.revision,hash(original));assert.deepEqual(loaded.collectionClaims[JSON.stringify(['topic'])],[collectionNamed(loaded,'Topic').collectionId]);
    assert.equal(c.resolveCollection({topic:'TOPIC'}).collectionId,collectionNamed(loaded,'Topic').collectionId);assert.deepEqual(await readFile(file),original);
    const committed=await c.transact(loaded.revision,d=>{d.operations.optional=true;});assert.ok(JSON.parse(await readFile(file,'utf8')).collectionClaims);assert.deepEqual(committed.collectionClaims,loaded.collectionClaims);
});
test('delete identity trashed collection subtree skips physical publish and ID or unique name returns 410',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),topic=collectionNamed(s,'Topic');const done=await trashKnownCollection(c,root,topic.collectionId);
    assert.equal(done.collections[topic.collectionId].revision,topic.revision+1);assert.equal(c.listCollections().length,1);assert.equal(c.listPapers().length,1);
    for(const locator of [{collectionId:topic.collectionId},{topic:'Topic'}])assert.throws(()=>c.resolveCollection(locator),{code:'gone',status:410});
    assert.throws(()=>c.listPapers({collectionId:topic.collectionId}),{code:'gone',status:410});
    assert.equal(c.resolveCollection({collectionId:collectionNamed(s,'Other').collectionId}).name,'Other');
});
test('delete identity trashed paper preserves ID claims and exact SID while all old refs return 410',async t=>{
    const {createCatalog}=await api();const {root,pdf}=await fixture(t);const c=createCatalog(root),initial=await c.initializeBaseline(),paper=paperNamed(initial,'Paper');
    const bound=await c.transact(initial.revision,d=>{d.sessionBindings.deletedExact=paper.paperId;});await rename(pdf,join(root,'.held-paper.pdf'));
    const done=await c.transact(bound.revision,d=>{d.papers[paper.paperId].status='trashed';});assert.equal(done.papers[paper.paperId].paperId,paper.paperId);assert.equal(done.sessionBindings.deletedExact,paper.paperId);
    for(const locator of [{paperId:paper.paperId},{sessionId:'deletedExact',topic:'Other',name:'Third'},{topic:'Topic',name:'Paper'}])assert.throws(()=>c.resolvePaper(locator),{code:'gone',status:410});
});
test('delete identity legacy collection rename and path reuse retain owners and reject 409 without ID',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),first=await c.initializeBaseline(),old=collectionNamed(first,'Other');await rename(join(root,'Other'),join(root,'Former'));
    let state=await c.transact(first.revision,d=>{d.collections[old.collectionId].name='Former';d.collections[old.collectionId].segments=['Former'];for(const p of Object.values(d.papers))if(p.collectionId===old.collectionId)p.segments=['Former'];});
    assert.equal(c.resolveCollection({topic:'Other'}).collectionId,old.collectionId);await mkdir(join(root,'Other'));const replacement=randomUUID();
    state=await c.transact(state.revision,d=>{d.collections[replacement]={collectionId:replacement,parentId:null,name:'Other',segments:['Other'],revision:1,note:''};});
    assert.deepEqual(state.collectionClaims[JSON.stringify(['other'])],[old.collectionId,replacement]);assert.throws(()=>c.resolveCollection({topic:'Other'}),{code:'collection-ref-ambiguous',status:409});
    assert.equal(c.resolveCollection({collectionId:old.collectionId,topic:'Other'}).name,'Former');assert.equal(c.resolveCollection({collectionId:replacement}).name,'Other');
});
test('delete identity recycled collection path can have one active owner while historical IDs stay 410',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),old=collectionNamed(s,'Other');const trashed=await trashKnownCollection(c,root,old.collectionId);await mkdir(join(root,'Other'));const replacement=randomUUID();
    const next=await c.transact(trashed.revision,d=>{d.collections[replacement]={collectionId:replacement,parentId:null,name:'Other',segments:['Other'],revision:1,note:'replacement'};});
    assert.equal(Object.values(next.collections).filter(activeCollection).length,3);assert.throws(()=>c.resolveCollection({collectionId:old.collectionId,topic:'Other'}),{code:'gone',status:410});assert.throws(()=>c.resolveCollection({topic:'other'}),{code:'collection-ref-ambiguous',status:409});assert.equal(c.resolveCollection({collectionId:replacement}).note,'replacement');
});
test('delete identity collection UUID rows are immutable and claims cannot be dropped or reassigned',async t=>{
    const {createCatalog}=await api();const {root,file}=await fixture(t);await mkdir(join(root,'Empty'));const c=createCatalog(root),s=await c.initializeBaseline(),empty=collectionNamed(s,'Empty'),other=collectionNamed(s,'Other'),key=JSON.stringify(['empty']);
    for(const mutate of [d=>{delete d.collections[empty.collectionId];},d=>{d.collections[empty.collectionId].collectionId=randomUUID();},d=>{delete d.collectionClaims[key];},d=>{d.collectionClaims[key]=[other.collectionId];}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
    assert.equal(hash(await readFile(file)),s.revision);
});
test('delete identity collection claims accept only a new owners actual current location',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),topic=collectionNamed(s,'Topic'),other=collectionNamed(s,'Other');
    for(const mutate of [d=>{d.collectionClaims[JSON.stringify(['topic'])].push(other.collectionId);},d=>{d.collectionClaims[JSON.stringify(['never-occupied'])]=[topic.collectionId];}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
    assert.deepEqual(c.snapshot(),s);
});
test('delete identity active collection and active paper require fully active ancestry',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),topic=collectionNamed(s,'Topic'),other=collectionNamed(s,'Other');
    await assert.rejects(c.transact(s.revision,d=>{d.collections[topic.collectionId].status='trashed';for(const p of Object.values(d.papers))if(p.collectionId===topic.collectionId)p.status='trashed';}),{code:'invalid'});
    await assert.rejects(c.transact(s.revision,d=>{d.collections[other.collectionId].status='trashed';}),{code:'invalid'});
});
test('delete identity ancestor rename freezes historical descendants and never fabricates paper or collection claims',async t=>{
    const {createCatalog}=await api();const {claimKey}=await pathsApi();const {root}=await fixture(t);const c=createCatalog(root),first=await c.initializeBaseline(),nested=collectionNamed(first,'Nested'),topic=collectionNamed(first,'Topic'),second=paperNamed(first,'Second');
    let state=await c.transact(first.revision,d=>{d.sessionBindings.frozen=second.paperId;});state=await trashKnownCollection(c,root,nested.collectionId);const oldCollection=structuredClone(state.collections[nested.collectionId]),oldPaper=structuredClone(state.papers[second.paperId]);await rename(join(root,'Topic'),join(root,'Renamed'));
    state=await c.transact(state.revision,d=>{d.collections[topic.collectionId].name='Renamed';d.collections[topic.collectionId].segments=['Renamed'];for(const p of Object.values(d.papers))if(p.status==='active'&&p.collectionId===topic.collectionId)p.segments=['Renamed'];});
    assert.deepEqual(state.collections[nested.collectionId],oldCollection);assert.deepEqual(state.papers[second.paperId],oldPaper);assert.equal(state.claims[claimKey(['Renamed','Nested'],'Second')],undefined);assert.equal(state.collectionClaims[JSON.stringify(['renamed','nested'])],undefined);
    assert.throws(()=>c.resolvePaper({sessionId:'frozen'}),{code:'gone',status:410});assert.throws(()=>c.resolveCollection({topic:'Topic/Nested'}),{code:'gone',status:410});
});
test('delete identity trashed locations are immutable and tombstones cannot resurrect',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),first=await c.initializeBaseline(),other=collectionNamed(first,'Other'),third=paperNamed(first,'Third');const s=await trashKnownCollection(c,root,other.collectionId);
    for(const mutate of [d=>{d.collections[other.collectionId].name='Moved';d.collections[other.collectionId].segments=['Moved'];},d=>{d.collections[other.collectionId].parentId=collectionNamed(d,'Topic').collectionId;},d=>{d.papers[third.paperId].segments=['Topic'];},d=>{d.papers[third.paperId].name='Moved';},d=>{d.collections[other.collectionId].status='active';},d=>{d.papers[third.paperId].status='active';}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
});
test('delete identity nonactive historical parent chains remain valid and cyclic or absent ancestors are rejected',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s0=await c.initializeBaseline(),topic=collectionNamed(s0,'Topic'),nested=collectionNamed(s0,'Nested');const s=await trashKnownCollection(c,root,topic.collectionId);
    for(const mutate of [d=>{d.collections[topic.collectionId].parentId=nested.collectionId;},d=>{d.collections[nested.collectionId].parentId=randomUUID();}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
    assert.equal(c.snapshot().collections[nested.collectionId].parentId,topic.collectionId);
});
test('delete identity active paths still require physical directories after a collection status migration',async t=>{
    const {createCatalog}=await api();const {root,file}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline();await rename(join(root,'Other'),join(root,'.held-active'));
    await assert.rejects(c.transact(s.revision,d=>{d.operations.localOnly=true;}),{code:'not-found'});assert.equal(hash(await readFile(file)),s.revision);
});
test('delete identity canonical collection claim validators preserve Unicode expansion and strict new targets',async t=>{
    const p=await pathsApi();assert.equal(typeof p.collectionClaimKey,'function');assert.equal(typeof p.validateCollectionClaimKey,'function');const segment='\u0130'.repeat(128),key=p.collectionClaimKey([segment]);assert.equal(p.validateCollectionClaimKey(key),key);assert.ok(JSON.parse(key)[0].length>255);assert.throws(()=>p.validateSegment(segment),{code:'invalid'});
    for(const key of ['{bad',JSON.stringify([]),JSON.stringify(['TOPIC']),JSON.stringify(['../escape']),JSON.stringify(['a:stream']),JSON.stringify(['\ud800']),JSON.stringify(['x'.repeat(4096)]),'[ "topic" ]'])assert.throws(()=>p.validateCollectionClaimKey(key),{code:'invalid'});
});
test('delete identity fold expanding legacy collections retain claims across restart without a new target exception',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t),name='\u0130'.repeat(128);await mkdir(join(root,name));const c=createCatalog(root),s=await c.initializeBaseline(),owner=collectionNamed(s,name);assert.deepEqual(s.collectionClaims[JSON.stringify([name.normalize('NFC').toLowerCase().normalize('NFC')])],[owner.collectionId]);
    const child=await runNode(`import {createCatalog} from ${JSON.stringify(catalogUrl)};const c=createCatalog(${JSON.stringify(root)});await c.initializeBaseline();console.log(c.resolveCollection({topic:${JSON.stringify(name)}}).collectionId)`);assert.equal(child.code,0,child.stderr);assert.equal(child.stdout,owner.collectionId);
    await assert.rejects(c.transact(s.revision,d=>{const id=randomUUID();d.collections[id]={...owner,collectionId:id,parentId:collectionNamed(d,'Topic').collectionId,segments:['Topic',name]};}),{code:'invalid'});
});
test('delete identity invalid optional collection schema remains byte-identical and fails closed',async t=>{
    const {createCatalog}=await api();const {root,file}=await fixture(t);const c=createCatalog(root);await c.initializeBaseline();const valid=JSON.parse(await readFile(file,'utf8')),id=Object.keys(valid.collections)[0];
    for(const mutate of [d=>{d.collections[id].status='missing';},d=>{d.collectionClaims=[];},d=>{d.collectionClaims={[JSON.stringify(['TOPIC'])]:[id]};},d=>{d.collectionClaims={[JSON.stringify(['topic'])]:[randomUUID()]};}]){const bad=structuredClone(valid);mutate(bad);const bytes=JSON.stringify(bad);await writeFile(file,bytes);assert.throws(()=>c.snapshot(),{code:'catalog-invalid'});assert.equal(await readFile(file,'utf8'),bytes);}
});
test('delete identity legacy claims migration uses only known current locations and does not guess old names',async t=>{
    const {createCatalog}=await api();const {root,file}=await fixture(t);const c=createCatalog(root);await c.initializeBaseline();const raw=JSON.parse(await readFile(file,'utf8')),other=collectionNamed(raw,'Other');delete raw.collectionClaims;await rename(join(root,'Other'),join(root,'KnownCurrent'));other.name='KnownCurrent';other.segments=['KnownCurrent'];for(const p of Object.values(raw.papers))if(p.collectionId===other.collectionId){p.segments=['KnownCurrent'];raw.claims[JSON.stringify([['knowncurrent'],p.name.toLowerCase()])]=[p.paperId];}await writeFile(file,JSON.stringify(raw));
    assert.equal(c.resolveCollection({topic:'KnownCurrent'}).collectionId,other.collectionId);assert.throws(()=>c.resolveCollection({topic:'Other'}),{code:'not-found'});assert.equal(c.snapshot().collectionClaims[JSON.stringify(['other'])],undefined);
});
test('delete identity new UUIDs cannot fabricate inactive historical occupants without an active location',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),other=collectionNamed(s,'Other');
    for(const mutate of [d=>{const id=randomUUID();d.collections[id]={collectionId:id,parentId:null,name:'Fictional',segments:['Fictional'],revision:1,note:'',status:'trashed'};},d=>{const id=randomUUID();d.ingestSeq++;d.papers[id]={paperId:id,collectionId:other.collectionId,name:'Fictional',segments:other.segments,locationRevision:1,status:'trashed',origin:'import',ingestSeq:d.ingestSeq};}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
});
test('delete identity the first trash transition freezes the last witnessed location instead of adding a fictional rename claim',async t=>{
    const {createCatalog}=await api();const {root}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),other=collectionNamed(s,'Other'),third=paperNamed(s,'Third');
    for(const mutate of [d=>{const row=d.collections[other.collectionId];row.status='trashed';row.name='NeverOccupied';row.segments=['NeverOccupied'];d.papers[third.paperId].status='trashed';},d=>{const row=d.papers[third.paperId];row.status='trashed';row.name='NeverOccupied';}])await assert.rejects(c.transact(s.revision,mutate),{code:'invalid'});
});
test('delete identity active-to-missing retains witnessed name and segments while reactivation verifies an actual file',async t=>{
    const {createCatalog}=await api();const {root,pdf}=await fixture(t);const c=createCatalog(root),s=await c.initializeBaseline(),paper=paperNamed(s,'Paper');
    await assert.rejects(c.transact(s.revision,d=>{d.papers[paper.paperId].status='missing';d.papers[paper.paperId].name='NeverOccupied';}),{code:'invalid'});
    const missing=await c.transact(s.revision,d=>{d.papers[paper.paperId].status='missing';});await rename(pdf,join(root,'.held-missing.pdf'));
    await assert.rejects(c.transact(missing.revision,d=>{d.papers[paper.paperId].status='active';}),{code:'not-found'});await rename(join(root,'.held-missing.pdf'),pdf);
    const restored=await c.transact(missing.revision,d=>{d.papers[paper.paperId].status='active';});assert.equal(restored.papers[paper.paperId].paperId,paper.paperId);assert.equal(c.resolvePaper({paperId:paper.paperId}).pdfPath,pdf);
});
