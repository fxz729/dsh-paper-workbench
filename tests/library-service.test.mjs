import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, unlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createCatalog } from '../dist/paper-catalog.js';
import * as metadata from '../dist/paper-metadata.js';
import { matchArtifactName } from '../dist/library-manage.js';
const serviceUrl = new URL('../dist/library-service.js', import.meta.url).href;
const pdf = (text = 'paper') => `%PDF-1.7\n% ${text}\n/Annots [ /Text /Contents (legacy note) ]\n${'% stable bytes\n'.repeat(12)}%%EOF`;
const hash = b => createHash('sha256').update(b).digest('hex');
async function api() {
    const mod = await import(serviceUrl).catch(e => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e));
    assert.equal(typeof mod.createLibraryService, 'function', 'createLibraryService export exists'); return mod;
}
async function fixture(t) {
    const base = await mkdtemp(join(tmpdir(), 'dpr-service-test-')), root = join(base, 'library'), source = join(base, 'external.pdf');
    t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(root, 'Topic', 'Nested'), { recursive: true }); await mkdir(join(root, 'Other'));
    await writeFile(join(root, 'Topic', 'Paper.pdf'), pdf()); await writeFile(join(root, 'Topic', 'Nested', 'Child.pdf'), pdf('child'));
    await writeFile(source, pdf('external'));
    const catalog = createCatalog(root); await catalog.initializeBaseline();
    const paper = catalog.listPapers().find(p => p.name === 'Paper'), collection = catalog.listCollections().find(c => c.name === 'Topic');
    return { base, root, source, catalog, paper, collection };
}
function gate(root, calls = []) {
    return async ({ paperIds, operation }) => {
        calls.push({ phase: 'prepare', paperIds, operation });
        assert.equal(existsSync(join(root, '.dpr-paper-catalog.json.lock')), false, 'reader handshake precedes catalog lock');
        await Promise.resolve();
        return { release: async () => { calls.push({ phase: 'release' }); } };
    };
}
const code = (expected) => e => { assert.equal(e.code, expected); assert.equal(/[A-Z]:[\\/]|dpr-service-test-/.test(e.message), false); return true; };
async function artifacts(root) {
    const owned = ['Paper.pdf', 'Paper-en.pdf', 'Paper-zh.pdf', 'Paper-dual.pdf', 'Paper.study.json', 'Paper.txt', 'Paper.pages.json', 'Paper.transcript.json', 'Paper.mineru.md', 'Paper.mineru.json', 'Paper.embeddings.json'];
    for (const variant of ['', '-en', '-zh', '-dual']) owned.push(`Paper${variant}.pdf.dpr-ink.json`, `Paper${variant}.pdf.dpr-original.bak`, `Paper${variant}.pdf.dpr-original.bak.json`);
    for (const name of owned) if (name !== 'Paper.pdf') await writeFile(join(root, 'Topic', name), `owned:${name}`);
    const neighbours = ['Paper More.pdf', 'Paper-backup.pdf.dpr-ink.json', 'Paper.pdf.unrelated', 'Paper-other.study.json'];
    for (const name of neighbours) await writeFile(join(root, 'Topic', name), `neighbour:${name}`);
    return { owned, neighbours };
}

test('service initializes, lists nested stable IDs and reads metadata without modifying PDFs', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), before = hash(await readFile(join(f.root, 'Topic', 'Paper.pdf')));
    const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const tree = await service.listTree(); assert.equal(tree.papers.length, 2); assert.equal(tree.collections.length, 3);
    const details = await service.getDetails({ paperId: f.paper.paperId });
    assert.equal(details.kind, 'paper'); assert.equal(details.entity.paperId, f.paper.paperId); assert.equal(details.metadata.revision, null);
    assert.equal(hash(await readFile(join(f.root, 'Topic', 'Paper.pdf'))), before);
});

test('createCollection is nested, non-overwriting and operation-idempotent; notes/details use local CAS', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const operationId = randomUUID(), request = { parentId: f.collection.collectionId, name: 'New', note: '研究备注 https://example.org', operationId };
    const created = await service.createCollection(request);
    assert.deepEqual(created.entity.segments, ['Topic', 'New']); assert.ok(existsSync(join(f.root, 'Topic', 'New')));
    const replay = await service.createCollection(request); assert.equal(replay.entity.collectionId, created.entity.collectionId);
    await assert.rejects(service.createCollection({ ...request, name: 'Different' }), code('conflict'));
    const detail = await service.getDetails({ collectionId: created.entity.collectionId }); assert.equal(detail.metadata.note, request.note);
    const updated = await service.updateDetails({ collectionId: created.entity.collectionId, revision: detail.metadata.revision, note: 'updated' }, 'model');
    assert.equal(updated.metadata.note, 'updated');
    await assert.rejects(service.updateDetails({ collectionId: created.entity.collectionId, revision: detail.metadata.revision, note: 'stale' }, 'manual'), code('conflict'));
    await assert.rejects(service.createCollection({ name: '..', operationId: randomUUID() }), code('invalid'));
});

test('paper rename needs a reader/activity lease and never waits for it under catalog lock', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const unsafe = createLibraryService(f.root, { catalog: f.catalog }); await unsafe.initialize();
    const plan = await unsafe.planRename({ paperId: f.paper.paperId, name: 'Renamed', expectedLocationRevision: 1 });
    await assert.rejects(unsafe.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('reader-busy'));
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf')));
    const calls = [], service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root, calls) }); await service.initialize();
    const result = await service.applyRename({ planId: plan.planId, operationId: randomUUID() });
    assert.equal(result.entity.paperId, f.paper.paperId); assert.equal(result.entity.name, 'Renamed');
    assert.equal(calls[0].phase, 'prepare'); assert.equal(calls.at(-1).phase, 'release');
});

test('paper rename moves exact artifacts, original PDF backups and claims without changing any bytes', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), { owned, neighbours } = await artifacts(f.root);
    const hashes = Object.fromEntries(await Promise.all(owned.map(async name => [name, hash(await readFile(join(f.root, 'Topic', name)))])));
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Renamed', expectedLocationRevision: 1 });
    assert.equal(plan.conflicts.length, 0); assert.equal(plan.affectedFiles.length, owned.length);
    const operationId = randomUUID(), result = await service.applyRename({ planId: plan.planId, operationId });
    for (const name of owned) assert.equal(hash(await readFile(join(f.root, 'Topic', 'Renamed' + name.slice('Paper'.length)))), hashes[name], name);
    for (const name of neighbours) assert.ok(existsSync(join(f.root, 'Topic', name)), name);
    assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'Renamed');
    assert.equal(f.catalog.resolvePaper({ topic: 'Topic', name: 'Paper' }).paperId, f.paper.paperId);
    assert.equal((await service.applyRename({ planId: plan.planId, operationId })).entity.paperId, result.entity.paperId);
});

test('rename target conflict, expired plan and changed source preserve both parties', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let now = 100000;
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root), now: () => now }); await service.initialize();
    await writeFile(join(f.root, 'Topic', 'Occupied.pdf'), pdf('unindexed other file'));
    const conflict = await service.planRename({ paperId: f.paper.paperId, name: 'Occupied', expectedLocationRevision: 1 });
    assert.ok(conflict.conflicts.length);
    await assert.rejects(service.applyRename({ planId: conflict.planId, operationId: randomUUID() }), code('target-exists'));
    const stale = await service.planRename({ paperId: f.paper.paperId, name: 'New', expectedLocationRevision: 1 });
    now += 10 * 60 * 1000;
    await assert.rejects(service.applyRename({ planId: stale.planId, operationId: randomUUID() }), code('stale-plan'));
    const changed = await service.planRename({ paperId: f.paper.paperId, name: 'New', expectedLocationRevision: 1 });
    await writeFile(join(f.root, 'Topic', 'Paper.pdf'), pdf('changed after preview'));
    await assert.rejects(service.applyRename({ planId: changed.planId, operationId: randomUUID() }), code('stale-plan'));
    assert.equal(await readFile(join(f.root, 'Topic', 'Occupied.pdf'), 'utf8'), pdf('unindexed other file'));
});

test('move failure rolls back in reverse and always releases admitted reader lease', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), { owned } = await artifacts(f.root); const calls = []; let moves = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root, calls), moveFile: async (from, to) => {
        if (++moves === 3) throw new Error('injected move'); await link(from, to); await unlink(from);
    } }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Failed', expectedLocationRevision: 1 });
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }));
    for (const name of owned) assert.ok(existsSync(join(f.root, 'Topic', name)), name);
    assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'Paper'); assert.equal(calls.at(-1).phase, 'release');
});

test('catalog commit failure rolls back moved files and created directory, with no ingest emission', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let fail = false, events = 0;
    const catalog = { ...f.catalog, transact: (rev, mutate) => f.catalog.transact(rev, async d => { await mutate(d); if (fail) throw new Error('injected precommit failure'); }) };
    const service = createLibraryService(f.root, { catalog, prepareReaders: gate(f.root), onIngest: async () => { events++; } }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Failed', expectedLocationRevision: 1 }); fail = true;
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }));
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf'))); assert.equal(existsSync(join(f.root, 'Topic', 'Failed.pdf')), false);
    await assert.rejects(service.createCollection({ name: 'RolledBack', operationId: randomUUID() }));
    assert.equal(existsSync(join(f.root, 'RolledBack')), false); assert.equal(events, 0);
});

test('import copies only the selected PDF, leaves external source untouched and emits one stable ingest after metadata commit', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), before = hash(await readFile(f.source)); const events = [];
    const service = createLibraryService(f.root, { catalog: f.catalog, onIngest: async event => {
        assert.equal(existsSync(join(f.root, '.dpr-paper-catalog.json.lock')), false);
        assert.equal((await metadata.readPaperMetadata(f.root, event.paperId)).summary.text, 'provided summary'); events.push(event);
    } }); await service.initialize();
    const operationId = randomUUID(), request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Imported', summaryText: 'provided summary' }], operationId };
    const result = await service.importPdfs(request, 'model');
    assert.equal(result.results[0].created, true); assert.equal(events.length, 1); assert.ok(events[0].eventId);
    const id = result.results[0].paperId; assert.equal(f.catalog.resolvePaper({ paperId: id }).name, 'Imported');
    assert.equal(hash(await readFile(f.source)), before); assert.equal(hash(await readFile(join(f.root, 'Topic', 'Imported.pdf'))), before);
    await service.importPdfs(request, 'model'); assert.equal(events.length, 1);
    const detail = await service.getDetails({ paperId: id }); assert.equal(detail.metadata.summary.source, 'model');
});

test('import is non-overwriting, rejects invalid PDF and reports per-file partial failures', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), old = await readFile(join(f.root, 'Topic', 'Paper.pdf'));
    const bad = join(f.base, 'bad.pdf'); await writeFile(bad, 'not a PDF');
    const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const result = await service.importPdfs({ collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Paper' }, { path: bad, name: 'Invalid' }, { path: f.source, name: 'Good' }], operationId: randomUUID() });
    assert.deepEqual(result.results.map(r => r.created), [false, false, true]);
    assert.deepEqual(await readFile(join(f.root, 'Topic', 'Paper.pdf')), old); assert.equal(existsSync(join(f.root, 'Topic', 'Invalid.pdf')), false);
});

test('rename A then import B at its old name protects old IDs, sessions and ambiguous legacy refs', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    await f.catalog.transact(f.catalog.snapshot().revision, d => { d.sessionBindings.oldSession = f.paper.paperId; });
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'A-renamed', expectedLocationRevision: 1 });
    await service.applyRename({ planId: plan.planId, operationId: randomUUID() });
    const result = await service.importPdfs({ collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Paper' }], operationId: randomUUID() });
    assert.notEqual(result.results[0].paperId, f.paper.paperId);
    assert.equal(f.catalog.resolvePaper({ sessionId: 'oldSession' }).name, 'A-renamed');
    assert.throws(() => f.catalog.resolvePaper({ topic: 'Topic', name: 'Paper' }), code('paper-ref-ambiguous'));
});

test('collection rename preserves subtree IDs, unknown files, notes and directory contents', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    await writeFile(join(f.root, 'Topic', 'unknown.bin'), 'unknown unchanged'); const ids = f.catalog.listPapers().map(p => p.paperId).sort();
    const calls = [], service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root, calls) }); await service.initialize();
    const plan = await service.planRename({ collectionId: f.collection.collectionId, name: 'Moved', expectedLocationRevision: f.collection.revision });
    assert.ok(plan.unknownFiles.some(name => name.endsWith('unknown.bin')));
    await service.applyRename({ planId: plan.planId, operationId: randomUUID() });
    assert.deepEqual(f.catalog.listPapers().map(p => p.paperId).sort(), ids);
    assert.ok(f.catalog.listPapers().every(p => p.segments[0] === 'Moved'));
    assert.equal(await readFile(join(f.root, 'Moved', 'unknown.bin'), 'utf8'), 'unknown unchanged'); assert.equal(existsSync(join(f.root, 'Topic')), false);
    assert.equal(calls.at(-1).phase, 'release');
});

test('confirmed catalog commit followed by transport error still completes postcommit metadata once', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let thrown = false, events = 0;
    const catalog = { ...f.catalog, transact: async (...args) => {
        const result = await f.catalog.transact(...args);
        if (!thrown) { thrown = true; throw new Error('lost response after actual commit'); }
        return result;
    } };
    const service = createLibraryService(f.root, { catalog, onIngest: async () => { events++; } }); await service.initialize();
    const request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Committed', summaryText: 'must be preserved' }], operationId: randomUUID() };
    const result = await service.importPdfs(request, 'model');
    assert.equal(result.results[0].created, true);
    assert.equal((await metadata.readPaperMetadata(f.root, result.results[0].paperId)).summary.text, 'must be preserved');
    assert.equal(events, 1); await service.importPdfs(request, 'model'); assert.equal(events, 1);
});

test('oversized source is rejected before hashing/reading it and source changes during copy cancel publication', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const originalOpen = fsPromises.open; let reads = 0;
    let hook = t.mock.method(fsPromises, 'open', async (path, ...args) => { if (path === f.source) reads++; return originalOpen(path, ...args); }); syncBuiltinESMExports();
    try {
        const service = createLibraryService(f.root, { catalog: f.catalog, maxPdfBytes: 100 }); await service.initialize();
        const result = await service.importPdfs({ collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'TooLarge' }], operationId: randomUUID() });
        assert.equal(result.results[0].code, 'too-large'); assert.equal(reads, 0);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
    reads = 0;
    hook = t.mock.method(fsPromises, 'open', async (path, ...args) => {
        if (path === f.source && ++reads === 3) await writeFile(f.source, pdf('changed while confirming source'));
        return originalOpen(path, ...args);
    }); syncBuiltinESMExports();
    try {
        const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
        const result = await service.importPdfs({ collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Changing' }], operationId: randomUUID() });
        assert.equal(result.results[0].created, false); assert.equal(result.results[0].code, 'source-changed');
        assert.equal(existsSync(join(f.root, 'Topic', 'Changing.pdf')), false);
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('postcommit metadata failure preserves committed copy, records warnings and never duplicates ingest on replay', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let events = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, metadata: { ...metadata, writePaperMetadata: async () => { throw new Error('injected metadata'); } }, onIngest: async () => { events++; } }); await service.initialize();
    const request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'LocalCopy', summaryText: 'provided' }], operationId: randomUUID() };
    const result = await service.importPdfs(request); assert.equal(result.results[0].created, true);
    assert.ok(result.receipt.warnings.includes('metadata-needs-review')); assert.equal(events, 0);
    await service.importPdfs(request); assert.equal(events, 0);
    assert.ok(existsSync(join(f.root, 'Topic', 'LocalCopy.pdf')));
});

function runChild(script) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true }); let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        child.on('error', reject); child.on('close', exit => resolve({ exit, stdout, stderr }));
    });
}
test('real process crash keeps busy journal; missing gate stays reviewable and admitted recovery reverses local steps', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), before = hash(await readFile(join(f.root, 'Topic', 'Paper.pdf')));
    const script = `import {createLibraryService} from ${JSON.stringify(serviceUrl)};const s=createLibraryService(${JSON.stringify(f.root)},{prepareReaders:async()=>({release(){}}),afterStep:async step=>{if(step.type==='move')process.exit(71)}});await s.initialize();const p=await s.planRename({paperId:${JSON.stringify(f.paper.paperId)},name:'Interrupted',expectedLocationRevision:1});await s.applyRename({planId:p.planId,operationId:${JSON.stringify(randomUUID())}});`;
    const child = await runChild(script); assert.equal(child.exit, 71, child.stderr);
    const blocked = createLibraryService(f.root, { catalog: f.catalog }); const status = await blocked.initialize();
    assert.ok(status.needsReview.length > 0);
    await assert.rejects(blocked.getDetails({ paperId: f.paper.paperId }), code('needs-review'));
    let authorizationChecks = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => ({ release() {} }), authorizeMutation: () => { authorizationChecks++; return false; } }); await service.initialize();
    assert.equal(authorizationChecks, 0, 'recovery undo does not depend on revoked forward authority');
    assert.equal(hash(await readFile(join(f.root, 'Topic', 'Paper.pdf'))), before);
    assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'Paper');
    assert.equal(existsSync(join(f.root, '.dpr-paper-catalog.json.lock')), false);
    assert.equal((await readdir(join(f.root, 'Topic'))).some(name => name.startsWith('.dpr-move-')), false);
});

test('persisted plan manifest tampering cannot move an unrelated root file', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const victim = join(f.root, 'Other', 'unrelated.bin'); await writeFile(victim, 'preserve unrelated');
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Safe', expectedLocationRevision: 1 });
    const file = join(f.root, '.dpr-library-journal.json'), state = JSON.parse(await readFile(file, 'utf8')), st = await lstat(victim, { bigint: true });
    state.plans[plan.planId].files.push({ from: 'Other/unrelated.bin', to: 'Other/relocated.bin', kind: 'file', identity: { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtime: String(st.mtimeNs), ctime: String(st.ctimeNs), mode: Number(st.mode) & 0o777, type: 'file', sha256: hash(await readFile(victim)) } });
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('needs-review'));
    assert.equal(await readFile(victim, 'utf8'), 'preserve unrelated');
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf')));
});

test('persisted plan cannot remove actual reader admission IDs and release failure preserves committed receipt', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const noGate = createLibraryService(f.root, { catalog: f.catalog }); await noGate.initialize();
    const plan = await noGate.planRename({ paperId: f.paper.paperId, name: 'New', expectedLocationRevision: 1 });
    const file = join(f.root, '.dpr-library-journal.json'), state = JSON.parse(await readFile(file, 'utf8'));
    state.plans[plan.planId].paperIds = []; await writeFile(file, JSON.stringify(state));
    await assert.rejects(noGate.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('reader-busy'));
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => ({ release: async () => { throw new Error('release transport error'); } }) }); await service.initialize();
    const next = await service.planRename({ paperId: f.paper.paperId, name: 'Final', expectedLocationRevision: 1 });
    const result = await service.applyRename({ planId: next.planId, operationId: randomUUID() });
    assert.equal(result.entity.name, 'Final'); assert.ok(result.receipt.warnings.includes('reader-release-needs-review'));
    assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'Final');
});

test('cross-process duplicate import publishes once and emits one stable event', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), eventLog = join(f.base, 'events.txt');
    const operationId = randomUUID(), request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'Once' }], operationId };
    const script = `import {createLibraryService} from ${JSON.stringify(serviceUrl)};import {appendFile} from 'node:fs/promises';try{const s=createLibraryService(${JSON.stringify(f.root)},{onIngest:async e=>appendFile(${JSON.stringify(eventLog)},e.eventId+'\\n')});await s.initialize();const r=await s.importPdfs(${JSON.stringify(request)});console.log('ok:'+r.results[0].paperId)}catch(e){console.log(e.code);process.exitCode=e.code==='conflict'?2:3}`;
    const children = await Promise.all([runChild(script), runChild(script), runChild(script)]);
    assert.ok(children.some(c => c.exit === 0), JSON.stringify(children));
    assert.ok(children.every(c => c.exit === 0 || c.exit === 2), JSON.stringify(children));
    const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const replay = await service.importPdfs(request); assert.equal(replay.results[0].created, true);
    assert.equal((await readFile(eventLog, 'utf8')).trim().split('\n').length, 1);
    assert.equal(f.catalog.listPapers().filter(p => p.name === 'Once').length, 1);
});

test('case-only paper and collection renames preserve bytes and stable IDs', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), before = hash(await readFile(join(f.root, 'Topic', 'Paper.pdf')));
    const releases = [], service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async ({ operation }) => {
        assert.ok(['rename-paper', 'rename-collection'].includes(operation.type)); assert.ok(operation.operationId);
        return { release: async result => { assert.deepEqual(Object.keys(result).sort(), ['entityId', 'operationId']); releases.push(result); } };
    } }); await service.initialize();
    const p = await service.planRename({ paperId: f.paper.paperId, name: 'paper', expectedLocationRevision: 1 });
    await service.applyRename({ planId: p.planId, operationId: randomUUID() });
    const c = await service.planRename({ collectionId: f.collection.collectionId, name: 'topic', expectedLocationRevision: 1 });
    await service.applyRename({ planId: c.planId, operationId: randomUUID() });
    const ref = f.catalog.resolvePaper({ paperId: f.paper.paperId }); assert.equal(ref.topic, 'topic'); assert.equal(ref.name, 'paper');
    assert.equal(hash(await readFile(ref.pdfPath)), before); assert.equal(releases.length, 2);
});

test('collection failure rolls back all unknown files and unsafe junction never escapes root', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); await writeFile(join(f.root, 'Topic', 'unknown.bin'), 'keep me'); let moved = false;
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root), moveFile: async (from, to) => {
        await link(from, to); if (!moved) { moved = true; throw new Error('interrupted before unlink'); } await unlink(from);
    } }); await service.initialize();
    const plan = await service.planRename({ collectionId: f.collection.collectionId, name: 'FailedDir', expectedLocationRevision: 1 });
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }));
    assert.equal(await readFile(join(f.root, 'Topic', 'unknown.bin'), 'utf8'), 'keep me');
    assert.ok(existsSync(join(f.root, 'Topic', 'Nested', 'Child.pdf'))); assert.equal(existsSync(join(f.root, 'FailedDir')), false);
    const outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'external.bin'), 'never move');
    const { symlink } = await import('node:fs/promises'); await symlink(outside, join(f.root, 'Topic', 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(service.planRename({ collectionId: f.collection.collectionId, name: 'Escaped', expectedLocationRevision: 1 }), code('needs-review'));
    assert.equal(await readFile(join(outside, 'external.bin'), 'utf8'), 'never move');
});

test('corrupt persistent journal is retained and never rebuilt or used to move PDFs', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), path = join(f.root, '.dpr-library-journal.json');
    await writeFile(path, '{broken journal'); const before = hash(await readFile(join(f.root, 'Topic', 'Paper.pdf')));
    await assert.rejects(createLibraryService(f.root, { catalog: f.catalog }).initialize(), code('journal-invalid'));
    assert.equal(await readFile(path, 'utf8'), '{broken journal'); assert.equal(hash(await readFile(join(f.root, 'Topic', 'Paper.pdf'))), before);
});

test('forged recovery created-file rows never delete an existing PDF', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    await service.planRename({ paperId: f.paper.paperId, name: 'Preview', expectedLocationRevision: 1 });
    const file = join(f.root, '.dpr-library-journal.json'), state = JSON.parse(await readFile(file, 'utf8')), victim = join(f.root, 'Topic', 'Paper.pdf'), st = await lstat(victim, { bigint: true }), before = hash(await readFile(victim));
    const id = randomUUID(); state.operations[id] = { operationId: id, generation: randomUUID(), requestHash: 'a'.repeat(64), kind: 'import', paperIds: [], collectionIds: [f.collection.collectionId], status: 'moving', ownerPid: process.pid, steps: [{ type: 'created-file', path: 'Topic/Paper.pdf', identity: { dev: String(st.dev), ino: String(st.ino) }, phase: 'done' }] };
    await writeFile(file, JSON.stringify(state));
    await assert.rejects(createLibraryService(f.root, { catalog: f.catalog }).initialize(), code('journal-invalid'));
    assert.equal(hash(await readFile(victim)), before);
});

test('crash immediately after catalog commit durably resumes supplied metadata and only never-sent events', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), operationId = randomUUID(), events = [];
    const request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'CommittedCrash', summaryText: 'durable supplied summary' }], operationId };
    const catalogUrl = new URL('../dist/paper-catalog.js', import.meta.url).href;
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};import {createLibraryService} from ${JSON.stringify(serviceUrl)};const c=createCatalog(${JSON.stringify(f.root)});await c.initializeBaseline();const proxy={...c,transact:async(...a)=>{const r=await c.transact(...a);process.exit(73);return r}};const s=createLibraryService(${JSON.stringify(f.root)},{catalog:proxy});await s.initialize();await s.importPdfs(${JSON.stringify(request)},'model');`;
    const child = await runChild(script); assert.equal(child.exit, 73, child.stderr);
    const service = createLibraryService(f.root, { catalog: f.catalog, onIngest: async e => { events.push(e); } }); await service.initialize();
    const result = await service.importPdfs(request, 'model');
    assert.equal((await metadata.readPaperMetadata(f.root, result.results[0].paperId)).summary.text, 'durable supplied summary');
    assert.equal(events.length, 1); await service.importPdfs(request, 'model'); assert.equal(events.length, 1);
});

test('a second crash inside rollback still leaves a recoverable operation and proven catalog lock', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), operationId = randomUUID();
    const crash = `import {createLibraryService} from ${JSON.stringify(serviceUrl)};const s=createLibraryService(${JSON.stringify(f.root)},{prepareReaders:async()=>({release(){}}),afterStep:async step=>{if(step.type==='move')process.exit(71)}});await s.initialize();const p=await s.planRename({paperId:${JSON.stringify(f.paper.paperId)},name:'Interrupted',expectedLocationRevision:1});await s.applyRename({planId:p.planId,operationId:${JSON.stringify(operationId)}});`;
    assert.equal((await runChild(crash)).exit, 71);
    const recovery = `import fs from 'node:fs/promises';import {existsSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {createLibraryService} from ${JSON.stringify(serviceUrl)};const old=fs.rename;fs.rename=async(...a)=>{const r=await old(...a);if(a[1]===${JSON.stringify(join(f.root, '.dpr-library-journal.json'))}&&existsSync(${JSON.stringify(join(f.root, '.dpr-paper-catalog.json.lock'))})){const j=JSON.parse(await fs.readFile(a[1],'utf8'));const o=j.operations[${JSON.stringify(operationId)}];if(o?.steps.length&&o.steps.every(s=>s.phase==='undone')&&['rolled-back','recovering'].includes(o.status))process.exit(72)}return r};syncBuiltinESMExports();await createLibraryService(${JSON.stringify(f.root)},{prepareReaders:async()=>({release(){}})}).initialize();`;
    const twice = await runChild(recovery); assert.equal(twice.exit, 72, twice.stderr);
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => ({ release() {} }) }); await service.initialize();
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf'))); assert.equal(existsSync(join(f.root, '.dpr-paper-catalog.json.lock')), false);
    await service.createCollection({ name: 'Recovered', operationId: randomUUID() });
});

test('crash while staging lock owner never publishes an empty unrecoverable mutex', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t);
    const lockPath = join(f.root, '.dpr-library-journal.json.lock');
    const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {createLibraryService} from ${JSON.stringify(serviceUrl)};const old=fs.open;fs.open=async(path,...args)=>{const h=await old(path,...args);if(String(path).startsWith(${JSON.stringify(lockPath)}))process.exit(74);return h};syncBuiltinESMExports();const s=createLibraryService(${JSON.stringify(f.root)});await s.initialize();await s.createCollection({name:'BeforeCrash',operationId:${JSON.stringify(randomUUID())}});`;
    const child = await runChild(script); assert.equal(child.exit, 74, child.stderr);
    const service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    await service.createCollection({ name: 'AfterCrash', operationId: randomUUID() });
    assert.ok(existsSync(join(f.root, 'AfterCrash'))); assert.equal(existsSync(lockPath), false);
});

test('event sent intent survives crash as unknown and never blindly re-emits', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), log = join(f.base, 'sent.txt'), request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'UnknownEvent' }], operationId: randomUUID() };
    const script = `import {createLibraryService} from ${JSON.stringify(serviceUrl)};import {appendFile} from 'node:fs/promises';const s=createLibraryService(${JSON.stringify(f.root)},{onIngest:async e=>{await appendFile(${JSON.stringify(log)},e.eventId+'\\n');process.exit(76)}});await s.initialize();await s.importPdfs(${JSON.stringify(request)});`;
    assert.equal((await runChild(script)).exit, 76);
    let sends = 0; const service = createLibraryService(f.root, { catalog: f.catalog, onIngest: async () => { sends++; } });
    const status = await service.initialize(); assert.ok(status.needsReview.includes(request.operationId));
    const replay = await service.importPdfs(request); assert.equal(sends, 0);
    assert.ok(replay.receipt.warnings.includes('event-delivery-unknown'));
    assert.equal((await readFile(log, 'utf8')).trim().split('\n').length, 1);
});

test('dead journal owner reclaimers remain mutually exclusive across processes', async t => {
    await api(); const f = await fixture(t), journalUrl = new URL('../dist/library-journal.js', import.meta.url).href, marker = join(f.base, 'exclusive.marker');
    const dead = `import {createJournal} from ${JSON.stringify(journalUrl)};await createJournal(${JSON.stringify(f.root)}).exclusive(async()=>process.exit(75));`;
    assert.equal((await runChild(dead)).exit, 75);
    const script = `import {createJournal} from ${JSON.stringify(journalUrl)};import {open,unlink} from 'node:fs/promises';import {setTimeout} from 'node:timers/promises';try{await createJournal(${JSON.stringify(f.root)}).exclusive(async()=>{const h=await open(${JSON.stringify(marker)},'wx');await setTimeout(30);await h.close();await unlink(${JSON.stringify(marker)})});console.log('ok')}catch(e){console.log(e.code);process.exitCode=e.code==='conflict'?2:3}`;
    const children = await Promise.all([runChild(script), runChild(script), runChild(script), runChild(script)]);
    assert.ok(children.some(c => c.exit === 0), JSON.stringify(children));
    assert.ok(children.every(c => c.exit === 0 || c.exit === 2), JSON.stringify(children));
    assert.equal(existsSync(marker), false);
});

test('legacy long and internal-dot PDF sources can be renamed while new targets stay strict', async t => {
    const { createLibraryService } = await api(); const base = await mkdtemp(join(tmpdir(), 'dpr-legacy-service-')); t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(base, 'Topic')); const names = ['a'.repeat(140), 'foo..bar'];
    for (const name of names) await writeFile(join(base, 'Topic', name + '.pdf'), pdf(name));
    const catalog = createCatalog(base), service = createLibraryService(base, { catalog, prepareReaders: gate(base) }); await service.initialize();
    for (let i = 0; i < names.length; i++) {
        const p = catalog.listPapers().find(p => p.name === names[i]), before = hash(await readFile(join(base, 'Topic', names[i] + '.pdf')));
        await assert.rejects(service.planRename({ paperId: p.paperId, name: 'b'.repeat(121), expectedLocationRevision: 1 }));
        const plan = await service.planRename({ paperId: p.paperId, name: 'Short' + i, expectedLocationRevision: 1 });
        await service.applyRename({ planId: plan.planId, operationId: randomUUID() });
        assert.equal(hash(await readFile(catalog.resolvePaper({ paperId: p.paperId }).pdfPath)), before);
    }
});

test('a legacy long parent permits short new collection and imported PDF names', async t => {
    const { createLibraryService } = await api(); const base = await mkdtemp(join(tmpdir(), 'dpr-legacy-parent-')); t.after(() => rm(base, { recursive: true, force: true }));
    const parentName = 'p'.repeat(140); await mkdir(join(base, parentName));
    const source = join(base, 'source.pdf'); await writeFile(source, pdf('source'));
    const catalog = createCatalog(base), service = createLibraryService(base, { catalog }); await service.initialize();
    const parent = catalog.listCollections()[0], created = await service.createCollection({ parentId: parent.collectionId, name: 'Child', operationId: randomUUID() });
    const imported = await service.importPdfs({ collectionId: created.entity.collectionId, sources: [{ path: source, name: 'Short' }], operationId: randomUUID() });
    assert.equal(imported.results[0].created, true);
    assert.deepEqual(catalog.resolvePaper({ paperId: imported.results[0].paperId }).segments, [parentName, 'Child']);
});

test('an existing uppercase PDF extension is included in the precise rename manifest', async t => {
    const { createLibraryService } = await api(); const base = await mkdtemp(join(tmpdir(), 'dpr-uppercase-pdf-')); t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(base, 'Topic')); await writeFile(join(base, 'Topic', 'Original.PDF'), pdf('upper extension'));
    const catalog = createCatalog(base), service = createLibraryService(base, { catalog, prepareReaders: gate(base) }); await service.initialize();
    const paper = catalog.listPapers()[0], plan = await service.planRename({ paperId: paper.paperId, name: 'Renamed', expectedLocationRevision: 1 });
    assert.equal(plan.affectedFiles.length, 1);
    await service.applyRename({ planId: plan.planId, operationId: randomUUID() });
    assert.equal(await readFile(catalog.resolvePaper({ paperId: paper.paperId }).pdfPath, 'utf8'), pdf('upper extension'));
});

test('initialize is idempotent when idle and replay never schedules postcommit work twice', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let events = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, onIngest: async () => { events++; } });
    await service.initialize(); const request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'StableInit' }], operationId: randomUUID() };
    const first = await service.importPdfs(request), token = f.catalog.snapshot().revision;
    await service.initialize(); await service.initialize();
    assert.equal(f.catalog.snapshot().revision, token); assert.equal(events, 1);
    const replay = await service.importPdfs(request); assert.deepEqual(replay, first); assert.equal(events, 1);
});

test('initial details save preserves explicit null metadata CAS for paper and collection', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const paper = await service.updateDetails({ paperId: f.paper.paperId, revision: null, summaryText: 'first summary' }, 'manual');
    assert.equal(paper.metadata.summary.text, 'first summary');
    const collection = await service.updateDetails({ collectionId: f.collection.collectionId, revision: null, note: 'first note' }, 'model');
    assert.equal(collection.metadata.note, 'first note');
});

test('short paper write lease holds rename root mutex and re-resolves ID after release without orphan sidecars', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), calls = [];
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root, calls) }); await service.initialize();
    assert.equal(typeof service.withPaperWrite, 'function');
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Renamed', expectedLocationRevision: 1 });
    const before = f.catalog.snapshot(), journalFile = join(f.root, '.dpr-library-journal.json'), journalHash = hash(await readFile(journalFile));
    let entered, finish; const started = new Promise(r => { entered = r; }), hold = new Promise(r => { finish = r; });
    const writing = service.withPaperWrite({ paperId: f.paper.paperId }, async ref => {
        assert.equal(ref.pdfPath, join(f.root, 'Topic', 'Paper.pdf')); entered(); await hold;
        await writeFile(ref.pdfPath.slice(0, -4) + '.study.json', 'saved inside lease'); return 'saved';
    });
    await started;
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('conflict'));
    assert.equal(calls.at(-1).phase, 'release');
    finish(); assert.equal(await writing, 'saved');
    assert.equal(f.catalog.snapshot().revision, before.revision); assert.equal(hash(await readFile(journalFile)), journalHash, 'write lease never mutates journal body');
    const refreshed = await service.planRename({ paperId: f.paper.paperId, name: 'Renamed', expectedLocationRevision: 1 });
    await service.applyRename({ planId: refreshed.planId, operationId: randomUUID() });
    assert.equal(await readFile(join(f.root, 'Topic', 'Renamed.study.json'), 'utf8'), 'saved inside lease');
    assert.equal(existsSync(join(f.root, 'Topic', 'Paper.study.json')), false);
    assert.equal(await service.withPaperWrite({ paperId: f.paper.paperId }, ref => ref.name), 'Renamed');
});

test('short-write callback throw and runtime gate recheck release root lock without catalog, journal or event mutation', async t => {
    const { createLibraryService, LibraryError } = await api(); const f = await fixture(t); let events = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, onIngest: async () => { events++; } }); await service.initialize();
    assert.equal(typeof service.withPaperWrite, 'function'); const before = f.catalog.snapshot();
    await assert.rejects(service.withPaperWrite({ paperId: f.paper.paperId }, async () => { throw new Error('callback local IO failure'); }), code('io'));
    assert.equal(await service.withPaperWrite({ paperId: f.paper.paperId }, ref => ref.paperId), f.paper.paperId);
    let prepared = false;
    const writing = service.withPaperWrite({ paperId: f.paper.paperId }, async ref => {
        // The runtime's second Gate.assertWritable runs here, immediately before actual IO.
        if (prepared) throw new LibraryError('reader-busy');
        await writeFile(ref.pdfPath + '.unexpected', 'must never execute');
    });
    prepared = true; await assert.rejects(writing, code('reader-busy'));
    assert.equal(existsSync(join(f.root, 'Topic', 'Paper.pdf.unexpected')), false);
    assert.deepEqual(f.catalog.snapshot(), before); assert.equal(events, 0);
    assert.equal(existsSync(join(f.root, '.dpr-library-journal.json')), false);
    assert.equal(existsSync(join(f.root, '.dpr-library-journal.json.lock')), false);
});

test('dirty reader Gate flush changes the manifest and conservatively requires a fresh preview', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let dirty = true, released = 0;
    const inkPath = join(f.root, 'Topic', 'Paper.pdf.dpr-ink.json'), payload = JSON.stringify({ version: 1, document: { pages: {} } });
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => {
        if (dirty) { await writeFile(inkPath, payload); dirty = false; }
        return { release: async () => { released++; } };
    } }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Saved', expectedLocationRevision: 1 });
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('stale-plan'));
    assert.equal(released, 1); assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf'))); assert.equal(await readFile(inkPath, 'utf8'), payload);
    const refreshed = await service.planRename({ paperId: f.paper.paperId, name: 'Saved', expectedLocationRevision: 1 });
    assert.ok(refreshed.affectedFiles.some(name => name.includes('.dpr-ink.json')));
    await service.applyRename({ planId: refreshed.planId, operationId: randomUUID() });
    assert.equal(await readFile(join(f.root, 'Topic', 'Saved.pdf.dpr-ink.json'), 'utf8'), payload); assert.equal(released, 2);
});

test('public create/import capture one detached request for hashing, IO and receipt replay', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const create = { parentId: f.collection.collectionId, name: 'Before', note: 'original note', operationId: randomUUID() }, originalCreate = structuredClone(create);
    const pending = service.createCollection(create, 'model'); create.name = 'After'; create.note = 'mutated note';
    const created = await pending; assert.equal(created.entity.name, 'Before');
    assert.equal((await service.createCollection(originalCreate, 'model')).entity.collectionId, created.entity.collectionId);
    assert.equal(existsSync(join(f.root, 'Topic', 'After')), false);
    const request = { collectionId: f.collection.collectionId, sources: [{ path: f.source, name: 'OriginalInput', summaryText: 'original summary', bibliography: { firstAuthor: 'Initial', year: '2020' } }], operationId: randomUUID() }, original = structuredClone(request);
    const copying = service.importPdfs(request, 'model');
    request.collectionId = f.catalog.listCollections().find(c => c.name === 'Other').collectionId;
    request.sources[0].path = join(f.base, 'missing.pdf'); request.sources[0].name = 'Late'; request.sources[0].summaryText = 'late summary'; request.sources[0].bibliography.firstAuthor = 'Late author';
    request.sources.push({ path: f.source, name: 'UnexpectedSecond' });
    const imported = await copying; assert.equal(imported.results.length, 1); assert.equal(imported.results[0].created, true); assert.equal(imported.results[0].name, 'OriginalInput');
    const detail = await service.getDetails({ paperId: imported.results[0].paperId });
    assert.equal(detail.entity.collectionId, f.collection.collectionId); assert.equal(detail.metadata.summary.text, 'original summary'); assert.equal(detail.metadata.bibliography.firstAuthor, 'Initial');
    assert.deepEqual(await service.importPdfs(original, 'model'), imported);
});

test('public read/update IDs, patches and nested bibliography are detached before available awaits', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const other = f.catalog.listPapers().find(p => p.paperId !== f.paper.paperId);
    const read = { paperId: f.paper.paperId }, reading = service.getDetails(read); read.paperId = other.paperId;
    assert.equal((await reading).entity.paperId, f.paper.paperId);
    const update = { paperId: f.paper.paperId, revision: null, summaryText: 'initial patch', bibliography: { firstAuthor: 'Original author', year: '2021' } };
    const saving = service.updateDetails(update, 'model'); update.paperId = other.paperId; update.summaryText = 'late patch'; update.bibliography.firstAuthor = 'Mutated author';
    const saved = await saving; assert.equal(saved.metadata.summary.text, 'initial patch'); assert.equal(saved.metadata.bibliography.firstAuthor, 'Original author');
    assert.equal((await service.getDetails({ paperId: other.paperId })).metadata.revision, null);
    const request = { collectionId: f.collection.collectionId, revision: null, note: 'initial collection note' }, updating = service.updateCollection(request, 'manual');
    request.collectionId = f.catalog.listCollections().find(c => c.name === 'Other').collectionId; request.note = 'late note';
    assert.equal((await updating).metadata.note, 'initial collection note');
});

test('public plan/apply capture IDs and names so a live argument cannot switch the mutation target', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const request = { paperId: f.paper.paperId, name: 'BeforeAwait', expectedLocationRevision: 1 }, pending = service.planRename(request); request.name = 'LateName';
    const first = await pending; assert.equal(first.newName, 'BeforeAwait');
    const other = f.catalog.listPapers().find(p => p.paperId !== f.paper.paperId), second = await service.planRename({ paperId: other.paperId, name: 'OtherRenamed', expectedLocationRevision: 1 });
    const apply = { planId: first.planId, operationId: randomUUID() }, applying = service.applyRename(apply); apply.planId = second.planId;
    const result = await applying; assert.equal(result.entity.paperId, f.paper.paperId); assert.equal(result.entity.name, 'BeforeAwait');
    assert.equal(f.catalog.resolvePaper({ paperId: other.paperId }).name, other.name);
});

test('non-plain, accessor and uncloneable public args fail invalid without invoking callbacks or writing files', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog }); await service.initialize();
    const base = { name: 'Invalid', operationId: randomUUID() }, cyclic = { ...base }; cyclic.self = cyclic;
    for (const value of [null, [], { ...base, fn() {} }, cyclic, { ...base, when: new Date() }]) await assert.rejects(service.createCollection(value), code('invalid'));
    let accessed = false; const accessor = { operationId: randomUUID(), get name() { accessed = true; return 'Invalid'; } };
    await assert.rejects(service.createCollection(accessor), code('invalid')); assert.equal(accessed, false);
    assert.equal(existsSync(join(f.root, 'Invalid')), false);
    assert.equal(await service.withPaperWrite({ paperId: f.paper.paperId }, ref => ref.paperId), f.paper.paperId, 'trusted fn remains a separate, un-cloned parameter');
});

test('applyRename binds an optional expected collection ID to the plan and replay fingerprint', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const other = f.catalog.listCollections().find(c => c.name === 'Other'), plan = await service.planRename({ collectionId: f.collection.collectionId, name: 'RenamedCollection', expectedLocationRevision: 1 });
    await assert.rejects(service.applyRename({ planId: plan.planId, collectionId: other.collectionId, operationId: randomUUID() }), code('conflict'));
    const operationId = randomUUID(), correct = { planId: plan.planId, collectionId: f.collection.collectionId, operationId };
    const result = await service.applyRename(correct); assert.equal(result.entity.collectionId, f.collection.collectionId);
    assert.deepEqual(await service.applyRename(correct), result);
    await assert.rejects(service.applyRename({ ...correct, collectionId: other.collectionId }), code('conflict'));
    assert.equal(f.catalog.resolveCollection({ collectionId: other.collectionId }).name, 'Other');
});

test('paper rename plan cannot be applied through an expected collection context', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t), service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(f.root) }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'PaperNew', expectedLocationRevision: 1 });
    await assert.rejects(service.applyRename({ planId: plan.planId, collectionId: f.collection.collectionId, operationId: randomUUID() }), code('conflict'));
    assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'Paper');
    const legacy = await service.applyRename({ planId: plan.planId, operationId: randomUUID() }); assert.equal(legacy.entity.name, 'PaperNew');
});

test('trusted mutation authority revoked during async reader prepare blocks commit and releases lease', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); let allowed = true, entered, resume, released = 0, checked = 0;
    const arrived = new Promise(r => { entered = r; }), held = new Promise(r => { resume = r; });
    const service = createLibraryService(f.root, { catalog: f.catalog, authorizeMutation: context => { checked++; assert.equal(context.kind, 'rename'); return allowed; }, prepareReaders: async () => {
        entered(); await held; return { release: async () => { released++; } };
    } }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Denied', expectedLocationRevision: 1 }), before = f.catalog.snapshot().revision;
    const applying = service.applyRename({ planId: plan.planId, operationId: randomUUID() }); await arrived; allowed = false; resume();
    await assert.rejects(applying, code('reader-busy'));
    assert.equal(released, 1); assert.ok(checked > 0); assert.equal(f.catalog.snapshot().revision, before);
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf'))); assert.equal(existsSync(join(f.root, 'Topic', 'Denied.pdf')), false);
});

test('trusted mutation authority revoked after local moves rolls back before catalog publish with no orphan or ingest', async t => {
    const { createLibraryService } = await api(); const f = await fixture(t); await writeFile(join(f.root, 'Topic', 'Paper.study.json'), 'legacy study');
    let allowed = true, checked = 0, released = 0, events = 0;
    const service = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => ({ release: async () => { released++; } }), authorizeMutation: () => { checked++; return allowed; }, afterStep: async row => { if (row.type === 'move' && row.to.endsWith('/Denied.pdf')) allowed = false; }, onIngest: async () => { events++; } }); await service.initialize();
    const plan = await service.planRename({ paperId: f.paper.paperId, name: 'Denied', expectedLocationRevision: 1 }), before = f.catalog.snapshot().revision;
    await assert.rejects(service.applyRename({ planId: plan.planId, operationId: randomUUID() }), code('reader-busy'));
    assert.equal(checked, 2); assert.equal(released, 1); assert.equal(events, 0); assert.equal(f.catalog.snapshot().revision, before);
    assert.equal(await readFile(join(f.root, 'Topic', 'Paper.study.json'), 'utf8'), 'legacy study');
    assert.ok(existsSync(join(f.root, 'Topic', 'Paper.pdf'))); assert.equal(existsSync(join(f.root, 'Topic', 'Denied.pdf')), false);
    assert.equal((await readdir(join(f.root, 'Topic'))).some(n => n.startsWith('.dpr-move-')), false);
});

test('precise lifecycle recognizes PDF original backup pair only, for each translation basename', async t => {
    for (const variant of ['', '-en', '-zh', '-dual']) {
        assert.equal(matchArtifactName('Paper', `Paper${variant}.pdf.dpr-original.bak`), true);
        assert.equal(matchArtifactName('Paper', `Paper${variant}.pdf.dpr-original.bak.json`), true);
    }
    for (const name of ['Paper Extra.pdf.dpr-original.bak', 'Paper.pdf.dpr-original.bak.extra', 'Paper-v2.pdf.dpr-original.bak']) assert.equal(matchArtifactName('Paper', name), false);
});
