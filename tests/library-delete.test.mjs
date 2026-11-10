import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, link, unlink, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCatalog } from '../dist/paper-catalog.js';
import { createLibraryService } from '../dist/library-service.js';
import * as metadata from '../dist/paper-metadata.js';
const moduleUrl = new URL('../dist/library-service.js', import.meta.url).href;
const hash = value => createHash('sha256').update(value).digest('hex');
const pdf = name => `%PDF-1.7\n/Annots [ /Text /Contents (legacy ${name}) ]\n${'% preserve source\n'.repeat(10)}%%EOF`;
const rejects = wanted => e => { assert.equal(e.code, wanted); assert.equal(/[A-Z]:[\\/]|dpr-delete-test-/.test(e.message), false); return true; };
function gate(log = []) { return async ({ paperIds, operation }) => { log.push({ paperIds, operation }); assert.ok(['delete-paper', 'delete-collection', 'clear-collection', 'rename-paper', 'rename-collection'].includes(operation.type)); return { release: async result => { log.push({ release: result }); } }; }; }
async function fixture(t, opts = {}) {
    const base = await mkdtemp(join(tmpdir(), 'dpr-delete-test-')), root = join(base, 'library'); t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(root, 'Alpha'), { recursive: true }); await mkdir(join(root, 'Empty'));
    await writeFile(join(root, 'Alpha', 'Paper.pdf'), pdf('Paper')); await writeFile(join(root, 'Alpha', 'Second.pdf'), pdf('Second'));
    if (opts.child) { await mkdir(join(root, 'Alpha', 'Child')); await writeFile(join(root, 'Alpha', 'Child', 'Nested.pdf'), pdf('Nested')); }
    const catalog = createCatalog(root); await catalog.initializeBaseline();
    const collection = catalog.listCollections().find(c => c.name === 'Alpha'), empty = catalog.listCollections().find(c => c.name === 'Empty'), paper = catalog.listPapers().find(p => p.name === 'Paper');
    const service = createLibraryService(root, { catalog, prepareReaders: gate(), ...opts.service }); await service.initialize();
    assert.equal(typeof service.planDelete, 'function', 'planDelete export exists'); assert.equal(typeof service.applyDelete, 'function', 'applyDelete export exists');
    return { base, root, catalog, service, collection, empty, paper };
}
async function realRuntime(f, t) {
    const { createPaperRuntime } = await import('../dist/library-runtime.js');
    const runtime = createPaperRuntime(f.root, {}, { createEnrichmentService: () => ({ initialize: async () => {}, stop: async () => {}, admitNew: async () => {} }) });
    await runtime.ready; t.after(() => runtime.stop()); return runtime;
}
async function family(f) {
    const owned = ['Paper.pdf', 'Paper.txt', 'Paper.pages.json', 'Paper.transcript.json', 'Paper.study.json', 'Paper.mineru.md', 'Paper.mineru.json', 'Paper.embeddings.json'];
    for (const v of ['', '-en', '-zh', '-dual']) {
        if (v) owned.push(`Paper${v}.pdf`);
        owned.push(`Paper${v}.pdf.dpr-ink.json`, `Paper${v}.pdf.dpr-original.bak`, `Paper${v}.pdf.dpr-original.bak.json`);
    }
    for (const file of owned) if (file !== 'Paper.pdf') await writeFile(join(f.root, 'Alpha', file), 'owned:' + file);
    await mkdir(join(f.root, 'Alpha', '.dpr-health')); const health = hash('Paper') + '.json'; await writeFile(join(f.root, 'Alpha', '.dpr-health', health), 'health relationship');
    return [...owned.map(name => 'Alpha/' + name), 'Alpha/.dpr-health/' + health];
}
async function findFiles(root, path = '') { const out = []; for (const e of await readdir(join(root, path), { withFileTypes: true })) { const name = path ? path + '/' + e.name : e.name; if (e.isDirectory()) out.push(...await findFiles(root, name)); else out.push(name); } return out; }
async function child(script) { return new Promise((resolve, reject) => { const p = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true }); let stdout = '', stderr = ''; p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; }); p.on('error', reject); p.on('close', exit => resolve({ exit, stdout, stderr })); }); }

test('public delete plans for three modes are pure, bounded relative string manifests', async t => {
    const f = await fixture(t), before = f.catalog.snapshot().revision;
    const plans = [await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper', expectedLocationRevision: 1 }), await f.service.planDelete({ collectionId: f.empty.collectionId, mode: 'empty-collection', expectedLocationRevision: 1 }), await f.service.planDelete({ collectionId: f.collection.collectionId, mode: 'clear-collection', expectedLocationRevision: 1 })];
    for (const p of plans) {
        assert.ok(p.planId && p.entityId && p.sourceRevision); assert.equal(p.trashRoot, '.trash'); assert.ok(p.trashRel.startsWith('.trash/'));
        for (const key of ['affectedFiles', 'conflicts', 'sessionEffects', 'sourceFiles', 'hidden']) assert.ok(Array.isArray(p[key]) && p[key].every(v => typeof v === 'string'));
        assert.equal(JSON.stringify(p).includes(f.root), false); assert.equal(typeof p.totalBytes, 'number');
    }
    assert.equal(f.catalog.snapshot().revision, before); assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf')));
    const root = join(f.base, 'arrow-name'); await mkdir(join(root, 'Topic'), { recursive: true }); await writeFile(join(root, 'Topic', 'Title→Graph.pdf'), pdf('arrow'));
    const catalog = createCatalog(root), service = createLibraryService(root, { catalog, prepareReaders: gate() }); await service.initialize();
    const plan = await service.planDelete({ paperId: catalog.listPapers()[0].paperId, mode: 'paper' });
    assert.deepEqual(plan.sourceFiles, ['Topic/Title→Graph.pdf']);
});

test('paper trash preserves every exact artifact hash, metadata and immutable session binding', async t => {
    let ingests = 0; const f = await fixture(t, { service: { onIngest: async () => { ingests++; } } }), owned = await family(f);
    await metadata.writePaperMetadata(f.root, f.paper.paperId, { revision: null, summaryText: 'retained summary' }, 'manual');
    await f.catalog.transact(f.catalog.snapshot().revision, d => { d.sessionBindings.oldSession = f.paper.paperId; });
    const hashes = Object.fromEntries(await Promise.all(owned.map(async path => [path, hash(await readFile(join(f.root, path)))])));
    const plan = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper', expectedLocationRevision: 1 }), op = randomUUID();
    const result = await f.service.applyDelete({ planId: plan.planId, operationId: op });
    assert.equal(result.entity.status, 'trashed'); assert.equal(result.entity.paperId, f.paper.paperId); assert.ok(result.trashRel.startsWith('.trash/'));
    const moved = await findFiles(join(f.root, result.trashRel));
    for (const path of owned) { const name = path.split('/').at(-1), found = moved.find(p => p.endsWith('/' + name) || p === name); assert.ok(found, name); assert.equal(hash(await readFile(join(f.root, result.trashRel, found))), hashes[path]); assert.equal(existsSync(join(f.root, path)), false); }
    assert.equal(f.catalog.snapshot().papers[f.paper.paperId].status, 'trashed'); assert.equal(f.catalog.snapshot().papers[f.paper.paperId].origin, 'baseline'); assert.equal(f.catalog.snapshot().ingestSeq, 0);
    assert.equal((await metadata.readPaperMetadata(f.root, f.paper.paperId)).summary.text, 'retained summary');
    assert.throws(() => f.catalog.resolvePaper({ sessionId: 'oldSession' }), rejects('gone'));
    assert.deepEqual(await f.service.applyDelete({ planId: plan.planId, operationId: op }), result); assert.equal(ingests, 0);
});

test('empty collection moves hidden normal entries intact and becomes a 410 tombstone', async t => {
    const f = await fixture(t); await mkdir(join(f.root, 'Empty', '.cache')); await writeFile(join(f.root, 'Empty', '.cache', 'data.bin'), 'hidden bytes');
    const plan = await f.service.planDelete({ collectionId: f.empty.collectionId, mode: 'empty-collection' }), result = await f.service.applyDelete({ planId: plan.planId, operationId: randomUUID() });
    assert.equal(existsSync(join(f.root, 'Empty')), false); assert.equal(result.entity.collectionId, f.empty.collectionId); assert.equal(result.entity.status, 'trashed');
    const files = await findFiles(join(f.root, result.trashRel)); assert.ok(files.some(p => p.endsWith('.cache/data.bin')));
    assert.throws(() => f.catalog.resolveCollection({ collectionId: f.empty.collectionId }), rejects('gone'));
    assert.equal((await f.service.listTree()).collections.some(c => c.collectionId === f.empty.collectionId), false);
    const hiddenRoot = join(f.base, 'hidden-active'); await mkdir(join(hiddenRoot, 'Topic'), { recursive: true });
    await writeFile(join(hiddenRoot, 'Topic', '.Hidden.pdf'), pdf('hidden active paper'));
    const catalog = createCatalog(hiddenRoot), service = createLibraryService(hiddenRoot, { catalog, prepareReaders: gate() }); await service.initialize();
    const collection = catalog.listCollections()[0], paper = catalog.listPapers()[0]; assert.equal(paper.name, '.Hidden');
    const empty = await service.planDelete({ collectionId: collection.collectionId, mode: 'empty-collection' });
    assert.ok(empty.conflicts.length, 'empty mode rejects every indexed active paper, including a hidden basename');
    await assert.rejects(service.applyDelete({ planId: empty.planId, operationId: randomUUID() }), rejects('conflict'));
    assert.ok(existsSync(join(hiddenRoot, 'Topic', '.Hidden.pdf'))); assert.equal(catalog.snapshot().papers[paper.paperId].status, 'active');
    const clear = await service.planDelete({ collectionId: collection.collectionId, mode: 'clear-collection' });
    const cleared = await service.applyDelete({ planId: clear.planId, operationId: randomUUID() }); assert.equal(cleared.receipt.cleared, 1);
    const actual = await fixture(t), runtime = await realRuntime(actual, t);
    for (const p of actual.catalog.listPapers({ collectionId: actual.collection.collectionId })) {
        const deletion = await runtime.service.planDelete({ paperId: p.paperId, mode: 'paper' });
        await runtime.service.applyDelete({ planId: deletion.planId, operationId: randomUUID() });
    }
    const emptyPlan = await runtime.service.planDelete({ collectionId: actual.collection.collectionId, mode: 'empty-collection' });
    assert.deepEqual(emptyPlan.paperIds, [], 'trashed records never enter real runtime resolve/admission');
    await runtime.service.applyDelete({ planId: emptyPlan.planId, operationId: randomUUID() });
    assert.throws(() => actual.catalog.resolveCollection({ collectionId: actual.collection.collectionId }), rejects('gone'));
});

test('clear collection recycles direct papers and hidden data in one directory transaction without ingest', async t => {
    let emitted = 0; const f = await fixture(t, { service: { onIngest: async () => { emitted++; } } }); await writeFile(join(f.root, 'Alpha', '.hidden'), 'keep hidden');
    const ids = f.catalog.listPapers({ collectionId: f.collection.collectionId }).map(p => p.paperId);
    const plan = await f.service.planDelete({ collectionId: f.collection.collectionId, mode: 'clear-collection' }), result = await f.service.applyDelete({ planId: plan.planId, operationId: randomUUID() });
    assert.equal(result.entity.status, 'trashed'); assert.equal(existsSync(join(f.root, 'Alpha')), false); assert.equal(result.receipt.cleared, 2);
    for (const id of ids) { assert.equal(f.catalog.snapshot().papers[id].status, 'trashed'); assert.throws(() => f.catalog.resolvePaper({ paperId: id }), rejects('gone')); }
    assert.equal(emitted, 0); assert.ok((await findFiles(join(f.root, result.trashRel))).some(p => p.endsWith('/.hidden')));
    const actual = await fixture(t), runtime = await realRuntime(actual, t);
    const first = await runtime.service.planDelete({ paperId: actual.paper.paperId, mode: 'paper' });
    await runtime.service.applyDelete({ planId: first.planId, operationId: randomUUID() });
    const current = await runtime.service.planDelete({ collectionId: actual.collection.collectionId, mode: 'clear-collection' });
    assert.equal(current.paperIds.includes(actual.paper.paperId), false, 'historical PID410 is excluded from real runtime Gate checks');
    await runtime.service.applyDelete({ planId: current.planId, operationId: randomUUID() });
    assert.equal(actual.catalog.snapshot().papers[actual.paper.paperId].status, 'trashed');
});

test('paper deletion never sweeps a near stem or unrelated PDF and cache', async t => {
    const f = await fixture(t); for (const name of ['Paper More.pdf', 'Paper-other.study.json', 'Paper.pdf.unrelated']) await writeFile(join(f.root, 'Alpha', name), 'near:' + name);
    const plan = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await f.service.applyDelete({ planId: plan.planId, operationId: randomUUID() });
    for (const name of ['Paper More.pdf', 'Paper-other.study.json', 'Paper.pdf.unrelated', 'Second.pdf']) assert.ok(existsSync(join(f.root, 'Alpha', name)), name);
});

test('both collection modes refuse active child collections before any move', async t => {
    const f = await fixture(t, { child: true });
    for (const mode of ['empty-collection', 'clear-collection']) {
        const p = await f.service.planDelete({ collectionId: f.collection.collectionId, mode }); assert.ok(p.conflicts.length);
        await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }), rejects('conflict'));
    }
    assert.ok(existsSync(join(f.root, 'Alpha', 'Child', 'Nested.pdf')));
});

test('unknown visible files and unindexed PDFs are preserved with preflight conflicts', async t => {
    const f = await fixture(t); await writeFile(join(f.root, 'Alpha', 'unrelated.bin'), 'unknown'); await writeFile(join(f.root, 'Alpha', 'Unindexed.pdf'), pdf('unindexed'));
    const p = await f.service.planDelete({ collectionId: f.collection.collectionId, mode: 'clear-collection' }); assert.ok(p.conflicts.some(v => v.includes('unrelated.bin'))); assert.ok(p.conflicts.some(v => v.includes('Unindexed.pdf')));
    await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }), rejects('conflict'));
    assert.equal(await readFile(join(f.root, 'Alpha', 'unrelated.bin'), 'utf8'), 'unknown'); assert.equal(f.catalog.snapshot().ingestSeq, 0);
});

test('existing paper trash requires reader admission and lease always releases', async t => {
    const f = await fixture(t), without = createLibraryService(f.root, { catalog: f.catalog }); await without.initialize();
    const p = await without.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await assert.rejects(without.applyDelete({ planId: p.planId, operationId: randomUUID() }), rejects('reader-busy'));
    const log = [], safe = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: input => { assert.equal(input.recovering, undefined, 'raw forward args never elevate to trusted recovery'); return gate(log)(input); } }); await safe.initialize(); await safe.applyDelete({ planId: p.planId, operationId: randomUUID(), recovering: true });
    assert.equal(log[0].operation.type, 'delete-paper'); assert.equal(log.at(-1).release.entityId, f.paper.paperId);
});

test('short write root lease blocks deletion and prevents orphan writes after retry', async t => {
    const f = await fixture(t), plan = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); let finish, entered;
    const started = new Promise(r => { entered = r; }), held = new Promise(r => { finish = r; });
    const writing = f.service.withPaperWrite({ paperId: f.paper.paperId }, async ref => { entered(); await held; await writeFile(ref.pdfPath.slice(0, -4) + '.study.json', 'late study'); }); await started;
    await assert.rejects(f.service.applyDelete({ planId: plan.planId, operationId: randomUUID() }), rejects('conflict')); finish(); await writing;
    const fresh = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await f.service.applyDelete({ planId: fresh.planId, operationId: randomUUID() });
    await assert.rejects(f.service.withPaperWrite({ paperId: f.paper.paperId }, () => {}), rejects('gone')); assert.equal(existsSync(join(f.root, 'Alpha', 'Paper.study.json')), false);
});

test('expired, changed-source and changed-catalog delete plans reject without touching files', async t => {
    let now = 100000; const f = await fixture(t, { service: { now: () => now } });
    const expired = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); now += 600000;
    await assert.rejects(f.service.applyDelete({ planId: expired.planId, operationId: randomUUID() }), rejects('stale-plan'));
    const changed = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await writeFile(join(f.root, 'Alpha', 'Paper.pdf'), pdf('changed'));
    await assert.rejects(f.service.applyDelete({ planId: changed.planId, operationId: randomUUID() }), rejects('stale-plan'));
    const index = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await f.service.createCollection({ name: 'New', operationId: randomUUID() });
    await assert.rejects(f.service.applyDelete({ planId: index.planId, operationId: randomUUID() }), rejects('stale-plan')); assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf')));
});

test('preoccupied owned trash destination preserves both source and existing target', async t => {
    const f = await fixture(t), p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' });
    await mkdir(join(f.root, p.trashRel), { recursive: true }); await writeFile(join(f.root, p.trashRel, 'foreign'), 'foreign target');
    await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }), rejects('target-exists'));
    assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf'))); assert.equal(await readFile(join(f.root, p.trashRel, 'foreign'), 'utf8'), 'foreign target');
});

test('Nth file move failure reverses trash moves and restores every associated file', async t => {
    let moves = 0; const f = await fixture(t, { service: { moveFile: async (a, b) => { if (++moves === 3) throw new Error('injected move'); await link(a, b); await unlink(a); } } }), files = await family(f);
    const p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }));
    for (const file of files) assert.ok(existsSync(join(f.root, file)), file); assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).status, 'active');
    const occupied = await fixture(t, { service: { moveFile: async (a, b) => { await link(a, b); await unlink(a); await writeFile(a, 'foreign replacement at original path'); throw new Error('source path occupied before rollback'); } } });
    const original = hash(await readFile(join(occupied.root, 'Alpha', 'Paper.pdf'))), plan = await occupied.service.planDelete({ paperId: occupied.paper.paperId, mode: 'paper' });
    await assert.rejects(occupied.service.applyDelete({ planId: plan.planId, operationId: randomUUID() }), rejects('needs-review'));
    assert.equal(await readFile(join(occupied.root, 'Alpha', 'Paper.pdf'), 'utf8'), 'foreign replacement at original path');
    const trash = await findFiles(join(occupied.root, plan.trashRel)), saved = trash.find(name => name.endsWith('/Paper.pdf'));
    assert.ok(saved); assert.equal(hash(await readFile(join(occupied.root, plan.trashRel, saved))), original);
    await assert.rejects(occupied.service.withPaperWrite({ paperId: occupied.paper.paperId }, () => {}), rejects('needs-review'));
});

test('catalog commit failure restores the whole directory and original identity state', async t => {
    const f = await fixture(t), wrapped = { ...f.catalog, transact: (revision, mutate) => f.catalog.transact(revision, async draft => { await mutate(draft); throw new Error('before commit'); }) };
    const s = createLibraryService(f.root, { catalog: wrapped, prepareReaders: gate() }); await s.initialize();
    const p = await s.planDelete({ collectionId: f.collection.collectionId, mode: 'clear-collection' }); await assert.rejects(s.applyDelete({ planId: p.planId, operationId: randomUUID() }));
    assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf'))); assert.equal(f.catalog.resolveCollection({ collectionId: f.collection.collectionId }).name, 'Alpha');
});

test('authority revoked after trash movement rolls back and never commits tombstones', async t => {
    let allowed = true; const f = await fixture(t, { service: { authorizeMutation: () => allowed, afterStep: async row => { if (row.type === 'move') allowed = false; } } });
    const p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }), before = f.catalog.snapshot().revision;
    await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }), rejects('reader-busy'));
    assert.equal(f.catalog.snapshot().revision, before); assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf')));
});

async function crashDelete(f, mode, type, exit = 71) {
    const id = mode === 'paper' ? { paperId: f.paper.paperId } : { collectionId: f.collection.collectionId }, op = randomUUID();
    const script = `import {createLibraryService} from ${JSON.stringify(moduleUrl)};const s=createLibraryService(${JSON.stringify(f.root)},{prepareReaders:async()=>({release(){}}),afterStep:async row=>{if(row.type===${JSON.stringify(type)})process.exit(${exit})}});await s.initialize();const p=await s.planDelete(${JSON.stringify({ ...id, mode })});await s.applyDelete({planId:p.planId,operationId:${JSON.stringify(op)}});`;
    const result = await child(script); assert.equal(result.exit, exit, result.stderr); return op;
}
test('real paper-move crash restores source bytes through admitted journal recovery', async t => {
    const f = await fixture(t), before = hash(await readFile(join(f.root, 'Alpha', 'Paper.pdf'))); await crashDelete(f, 'paper', 'move');
    const s = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate(), authorizeMutation: () => false }); await s.initialize();
    assert.equal(hash(await readFile(join(f.root, 'Alpha', 'Paper.pdf'))), before); assert.equal(f.catalog.resolvePaper({ paperId: f.paper.paperId }).status, 'active');
    const actual = await fixture(t), original = hash(await readFile(join(actual.root, 'Alpha', 'Paper.pdf')));
    await crashDelete(actual, 'paper', 'move'); await realRuntime(actual, t);
    assert.ok(existsSync(join(actual.root, 'Alpha', 'Paper.pdf')), 'real runtime admits WAL recovery although canonical PDF is temporarily absent');
    assert.equal(hash(await readFile(join(actual.root, 'Alpha', 'Paper.pdf'))), original);
});

test('real whole-directory trash crash restores its complete tree', async t => {
    const f = await fixture(t); await writeFile(join(f.root, 'Alpha', '.hidden'), 'hidden remains'); await crashDelete(f, 'clear-collection', 'trash-directory');
    await realRuntime(f, t);
    assert.equal(await readFile(join(f.root, 'Alpha', '.hidden'), 'utf8'), 'hidden remains'); assert.ok(existsSync(join(f.root, 'Alpha', 'Second.pdf')));
});

test('second crash during trash rollback remains recoverable without resurrecting committed data', async t => {
    const f = await fixture(t), op = await crashDelete(f, 'paper', 'move');
    const script = `import fs from 'node:fs/promises';import {existsSync} from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {createLibraryService} from ${JSON.stringify(moduleUrl)};const old=fs.rename;fs.rename=async(...a)=>{const r=await old(...a);if(a[1]===${JSON.stringify(join(f.root, '.dpr-library-journal.json'))}&&existsSync(${JSON.stringify(join(f.root, '.dpr-paper-catalog.json.lock'))})){const j=JSON.parse(await fs.readFile(a[1],'utf8'));const o=j.operations[${JSON.stringify(op)}];if(o?.steps.length&&o.steps.every(s=>s.phase==='undone')&&o.status==='recovering')process.exit(72)}return r};syncBuiltinESMExports();await createLibraryService(${JSON.stringify(f.root)},{prepareReaders:async()=>({release(){}})}).initialize();`;
    assert.equal((await child(script)).exit, 72);
    await createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate() }).initialize();
    assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf'))); assert.equal(existsSync(join(f.root, '.dpr-paper-catalog.json.lock')), false);
});

test('post-catalog-commit crash preserves trash terminal state and never re-deletes on replay', async t => {
    const f = await fixture(t), catalogUrl = new URL('../dist/paper-catalog.js', import.meta.url).href, operationId = randomUUID();
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};import {createLibraryService} from ${JSON.stringify(moduleUrl)};const c=createCatalog(${JSON.stringify(f.root)});await c.initializeBaseline();const proxy={...c,transact:async(...a)=>{const r=await c.transact(...a);process.exit(73);return r}};const s=createLibraryService(${JSON.stringify(f.root)},{catalog:proxy,prepareReaders:async()=>({release(){}})});await s.initialize();const p=await s.planDelete({paperId:${JSON.stringify(f.paper.paperId)},mode:'paper'});console.log(p.planId);await s.applyDelete({planId:p.planId,operationId:${JSON.stringify(operationId)}});`;
    const result = await child(script); assert.equal(result.exit, 73, result.stderr); const planId = result.stdout.trim();
    let prepareCalls = 0;
    const committedRecovery = createLibraryService(f.root, { catalog: f.catalog, prepareReaders: async () => { prepareCalls++; throw new Error('committed IDs need no forward admission'); } });
    await committedRecovery.initialize(); assert.equal(prepareCalls, 0, 'catalog receipt proof skips Gate even while journal status is moving');
    await assert.rejects(committedRecovery.getDetails({ paperId: f.paper.paperId }), rejects('gone'));
    const runtime = await realRuntime(f, t), s = runtime.service; const replay = await s.applyDelete({ planId, operationId });
    await assert.rejects(s.getDetails({ paperId: f.paper.paperId }), rejects('gone'));
    assert.equal(replay.entity.status, 'trashed'); assert.equal(existsSync(join(f.root, 'Alpha', 'Paper.pdf')), false); assert.throws(() => f.catalog.resolvePaper({ paperId: f.paper.paperId }), rejects('gone'));
});

test('forged deletion journal cannot claim an unrelated source or another trash bundle', async t => {
    const f = await fixture(t), p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await crashDelete(f, 'paper', 'move');
    const path = join(f.root, '.dpr-library-journal.json'), state = JSON.parse(await readFile(path, 'utf8')), op = Object.values(state.operations).find(o => o.status === 'moving');
    const move = op.steps.find(s => s.type === 'move'); move.from = 'Alpha/Second.pdf';
    await writeFile(path, JSON.stringify(state));
    await assert.rejects(createLibraryService(f.root, { catalog: f.catalog, prepareReaders: gate() }).initialize(), rejects('journal-invalid'));
    assert.equal(await readFile(join(f.root, 'Alpha', 'Second.pdf'), 'utf8'), pdf('Second')); assert.ok(p.planId);
});

test('renaming an active UUID subtree never relocates a same-prefix tombstone or creates pseudo claims', async t => {
    const f = await fixture(t); const p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await f.service.applyDelete({ planId: p.planId, operationId: randomUUID() });
    const old = structuredClone(f.catalog.snapshot().papers[f.paper.paperId]);
    const plan = await f.service.planRename({ collectionId: f.collection.collectionId, name: 'Renamed', expectedLocationRevision: 1 }); await f.service.applyRename({ planId: plan.planId, operationId: randomUUID() });
    assert.deepEqual(f.catalog.snapshot().papers[f.paper.paperId], old);
    const second = f.catalog.listPapers()[0]; assert.equal(second.segments[0], 'Renamed');
    assert.equal(Object.values(f.catalog.snapshot().claims).filter(ids => ids.includes(old.paperId)).length, 1);
});

test('paper and collection name reuse retain UUID tombstones and make old path-only references ambiguous', async t => {
    const f = await fixture(t); let p = await f.service.planDelete({ collectionId: f.empty.collectionId, mode: 'empty-collection' }); await f.service.applyDelete({ planId: p.planId, operationId: randomUUID() });
    const newCollection = await f.service.createCollection({ name: 'Empty', operationId: randomUUID() }); assert.notEqual(newCollection.entity.collectionId, f.empty.collectionId);
    assert.throws(() => f.catalog.resolveCollection({ topic: 'Empty' }), rejects('collection-ref-ambiguous')); assert.throws(() => f.catalog.resolveCollection({ collectionId: f.empty.collectionId }), rejects('gone'));
    const tombstone = structuredClone(f.catalog.snapshot().collections[f.empty.collectionId]);
    const rename = await f.service.planRename({ collectionId: newCollection.entity.collectionId, name: 'MovedEmpty', expectedLocationRevision: 1 });
    await f.service.applyRename({ planId: rename.planId, operationId: randomUUID() });
    assert.deepEqual(f.catalog.snapshot().collections[f.empty.collectionId], tombstone, 'same-prefix historical collection is not an active UUID descendant');
    assert.equal(f.catalog.resolveCollection({ collectionId: newCollection.entity.collectionId }).name, 'MovedEmpty');
    p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await f.service.applyDelete({ planId: p.planId, operationId: randomUUID() });
    const source = join(f.base, 'new.pdf'); await writeFile(source, pdf('replacement')); const imported = await f.service.importPdfs({ collectionId: f.collection.collectionId, sources: [{ path: source, name: 'Paper' }], operationId: randomUUID() });
    assert.notEqual(imported.results[0].paperId, f.paper.paperId); assert.throws(() => f.catalog.resolvePaper({ topic: 'Alpha', name: 'Paper' }), rejects('paper-ref-ambiguous'));
});

test('source and trash-root junctions are rejected without following or modifying external data', async t => {
    const f = await fixture(t), outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'untouched'), 'external');
    await symlink(outside, join(f.root, 'Empty', '.linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const unsafe = await f.service.planDelete({ collectionId: f.empty.collectionId, mode: 'empty-collection' }); assert.ok(unsafe.conflicts.length);
    await assert.rejects(f.service.applyDelete({ planId: unsafe.planId, operationId: randomUUID() }), rejects('conflict'));
    const p = await f.service.planDelete({ paperId: f.paper.paperId, mode: 'paper' }); await symlink(outside, join(f.root, '.trash'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.service.applyDelete({ planId: p.planId, operationId: randomUUID() }));
    assert.equal(await readFile(join(outside, 'untouched'), 'utf8'), 'external'); assert.ok(existsSync(join(f.root, 'Alpha', 'Paper.pdf')));
});
