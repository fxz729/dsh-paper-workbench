import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, truncate, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createCatalog } from '../dist/paper-catalog.js';
import { createLibraryService } from '../dist/library-service.js';
const sha = v => createHash('sha256').update(v).digest('hex');
const pdf = name => `%PDF-1.7\n${name}\n${'verified local fixture\n'.repeat(10)}%%EOF`;
const moduleUrl = new URL('../dist/library-service.js', import.meta.url).href;
const code = wanted => e => { assert.equal(e.code, wanted); return true; };
function stat(st) { return { dev: String(st.dev), ino: String(st.ino), size: Number(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), type: st.isDirectory() ? 'directory' : 'file' }; }
async function observed(f, segments, name) { const path = join(f.root, ...segments, ...(name === undefined ? [] : [name + '.pdf'])); return { observationId: randomUUID(), segments, ...(name === undefined ? {} : { name }), expectedStat: stat(await lstat(path, { bigint: true })), ...(name === undefined ? {} : { sourceSignature: sha(await readFile(path)) }) }; }
async function fixture(t, opts = {}) {
    const base = await mkdtemp(join(tmpdir(), 'dpr-registration-')), root = join(base, 'library'); t.after(() => rm(base, { recursive: true, force: true }));
    await mkdir(join(root, 'Existing'), { recursive: true }); await writeFile(join(root, 'Existing', 'Old.pdf'), pdf('baseline old'));
    const catalog = createCatalog(root); await catalog.initializeBaseline(); const capabilities = new Map(), events = [];
    const authorizeDiscovery = (proof, args) => { const p = capabilities.get(proof); return p && p.input === JSON.stringify(args) ? structuredClone(p.qualification) : null; };
    const service = createLibraryService(root, { catalog, authorizeDiscovery, onIngest: async e => events.push(e), prepareReaders: async () => ({ release() {} }), ...opts }); await service.initialize();
    assert.equal(typeof service.registerExisting, 'function');
    const proof = (args, classification = 'baseline', epoch = null, translation = null) => { const token = Symbol('private observer capability'); capabilities.set(token, { input: JSON.stringify(args), qualification: { classification, observedPolicyEpoch: epoch, observedTranslation: translation } }); return token; };
    return { base, root, catalog, service, events, proof, capabilities };
}
async function add(f, dir, name) { await mkdir(join(f.root, ...dir), { recursive: true }); await writeFile(join(f.root, ...dir, name + '.pdf'), pdf(name)); return observed(f, dir, name); }
async function runChild(script) { return new Promise((resolve, reject) => { const p = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true }); let stdout = '', stderr = ''; p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d); p.on('error', reject); p.on('close', exit => resolve({ exit, stdout, stderr })); }); }

test('baseline registration allocates complete real parent UUID chain without moving or changing source bytes', async t => {
    const f = await fixture(t), args = await add(f, ['Drop', 'Child'], 'Paper'), path = join(f.root, 'Drop', 'Child', 'Paper.pdf'), before = await lstat(path, { bigint: true });
    const result = await f.service.registerExisting(args, f.proof(args));
    assert.equal(result.created, true); assert.equal(result.entity.origin, 'baseline'); assert.equal(result.entity.ingestSeq, 0); assert.equal(f.events.length, 0);
    assert.equal(f.catalog.listCollections().filter(c => c.segments[0] === 'Drop').length, 2);
    assert.equal(sha(await readFile(path)), args.sourceSignature); assert.equal(String((await lstat(path, { bigint: true })).ino), String(before.ino));
    assert.equal(result.receipt.observationId, args.observationId); assert.equal(result.receipt.operationId, 'discover-' + sha(args.observationId));
});

test('live registration seals observed epochs and emits exactly one existing outbox event', async t => {
    const f = await fixture(t), args = await add(f, ['Existing'], 'Live'), cid = f.catalog.listCollections()[0].collectionId;
    const token = f.proof(args, 'live', 4, { collectionId: cid, epoch: 2 }), result = await f.service.registerExisting(args, token);
    assert.equal(result.entity.origin, 'import'); assert.equal(result.entity.ingestSeq, 1); assert.equal(f.events.length, 1);
    assert.equal(f.events[0].observedPolicyEpoch, 4); assert.deepEqual(f.events[0].observedTranslation, { collectionId: cid, epoch: 2 });
    assert.deepEqual(await f.service.registerExisting(args, token), result); assert.equal(f.events.length, 1); assert.equal(f.catalog.snapshot().ingestSeq, 1);
});

test('ordinary empty directory registration creates only collection records and no ingest', async t => {
    const f = await fixture(t); await mkdir(join(f.root, 'Folders', 'Empty'), { recursive: true }); const args = await observed(f, ['Folders', 'Empty']);
    const result = await f.service.registerExisting(args, f.proof(args, 'live', 5));
    assert.equal(result.created, true); assert.equal(result.entity.name, 'Empty'); assert.equal(result.entity.paperId, undefined); assert.equal(f.events.length, 0); assert.equal(f.catalog.snapshot().ingestSeq, 0);
    assert.ok(existsSync(join(f.root, 'Folders', 'Empty'))); assert.equal(f.catalog.resolveCollection({ collectionId: result.entity.collectionId }).name, 'Empty');
    const again = { ...structuredClone(args), observationId: randomUUID() }, existing = await f.service.registerExisting(again, f.proof(again));
    assert.equal(existing.created, false); assert.equal(existing.entity.collectionId, result.entity.collectionId); assert.equal(existing.receipt.classification, 'baseline');
});

test('same-file concurrent observations absorb one active PID and never create a second ingest', async t => {
    const f = await fixture(t), a = await add(f, ['Existing'], 'Same'), b = { ...structuredClone(a), observationId: randomUUID() };
    const first = await f.service.registerExisting(a, f.proof(a, 'live', 3));
    const second = await f.service.registerExisting(b, f.proof(b, 'live', 8));
    assert.equal(second.created, false); assert.equal(second.entity.paperId, first.entity.paperId); assert.equal(second.eligibility.observedPolicyEpoch, 3); assert.equal(f.events.length, 1);
});

test('untrusted JSON, missing authorizer, async proof result and kind/extra fields never grant discovery', async t => {
    const f = await fixture(t), args = await add(f, ['Existing'], 'Denied');
    await assert.rejects(f.service.registerExisting(args, { classification: 'live', observedPolicyEpoch: 9 }), code('needs-review'));
    for (const extra of [{ kind: 'paper' }, { classification: 'live' }, { observedPolicyEpoch: 9 }]) await assert.rejects(f.service.registerExisting({ ...args, ...extra }, f.proof({ ...args, ...extra })), code('invalid'));
    const bare = createLibraryService(f.root, { catalog: f.catalog }); await bare.initialize(); await assert.rejects(bare.registerExisting(args, Symbol()), code('needs-review'));
    const wrong = createLibraryService(f.root, { catalog: f.catalog, authorizeDiscovery: async () => ({ classification: 'live', observedPolicyEpoch: 9, observedTranslation: null }) }); await wrong.initialize();
    await assert.rejects(wrong.registerExisting(args, Symbol()), code('needs-review')); assert.equal(f.catalog.listPapers().length, 1);
});

test('registration arguments are detached before first await and changed stat/hash fail closed', async t => {
    const f = await fixture(t), args = await add(f, ['Existing'], 'Snapshot'), original = structuredClone(args), token = f.proof(args);
    const registering = f.service.registerExisting(args, token); args.name = 'Changed'; args.expectedStat.size = 0;
    assert.equal((await registering).entity.name, 'Snapshot');
    const changed = await add(f, ['Existing'], 'Changing'), cap = f.proof(changed); await writeFile(join(f.root, 'Existing', 'Changing.pdf'), pdf('new bytes'));
    await assert.rejects(f.service.registerExisting(changed, cap), code('source-changed'));
    const badHash = await observed(f, ['Existing'], 'Changing'); badHash.sourceSignature = '0'.repeat(64);
    await assert.rejects(f.service.registerExisting(badHash, f.proof(badHash)), code('source-changed')); assert.ok(original.sourceSignature);
});

test('unsupported raw names, translated variants, corrupt header and oversized source remain untouched', async t => {
    const f = await fixture(t);
    for (const name of ['.Hidden', 'bad..name', 'x'.repeat(121), 'Paper-zh']) { const args = await add(f, ['Existing'], name); await assert.rejects(f.service.registerExisting(args, f.proof(args, 'live', 3)), code('needs-review')); assert.ok(existsSync(join(f.root, 'Existing', name + '.pdf'))); }
    for (const [index, content] of ['not a PDF', '%PDF-', '%PDF-junk' + '.'.repeat(150)].entries()) {
        const name = 'Header' + index; await writeFile(join(f.root, 'Existing', name + '.pdf'), content); const args = await observed(f, ['Existing'], name);
        await assert.rejects(f.service.registerExisting(args, f.proof(args, 'live', 7)), code('pdf-invalid'));
        assert.equal(await readFile(join(f.root, 'Existing', name + '.pdf'), 'utf8'), content);
    }
    const big = join(f.root, 'Existing', 'Large.pdf'); await writeFile(big, pdf('large')); await truncate(big, 512 * 1024 * 1024 + 1);
    const huge = { observationId: randomUUID(), segments: ['Existing'], name: 'Large', expectedStat: stat(await lstat(big, { bigint: true })), sourceSignature: 'a'.repeat(64) };
    await assert.rejects(f.service.registerExisting(huge, f.proof(huge)), code('too-large')); assert.equal(f.events.length, 0); assert.equal(f.catalog.listPapers().length, 1);
});

test('trashed paper or historical collection path is reviewable and never revived by external reappearance', async t => {
    const f = await fixture(t), old = f.catalog.listPapers()[0], plan = await f.service.planDelete({ paperId: old.paperId, mode: 'paper' }); await f.service.applyDelete({ planId: plan.planId, operationId: randomUUID() });
    const args = await add(f, ['Existing'], 'Old'); await assert.rejects(f.service.registerExisting(args, f.proof(args, 'live', 5)), code('needs-review'));
    assert.equal(f.catalog.snapshot().papers[old.paperId].status, 'trashed'); assert.equal(f.catalog.snapshot().ingestSeq, 0);
    await mkdir(join(f.root, 'Gone')); const directory = await observed(f, ['Gone']);
    const c = await f.service.registerExisting(directory, f.proof(directory));
    const remove = await f.service.planDelete({ collectionId: c.entity.collectionId, mode: 'empty-collection' }); await f.service.applyDelete({ planId: remove.planId, operationId: randomUUID() });
    await mkdir(join(f.root, 'Gone')); const replacement = await observed(f, ['Gone']);
    await assert.rejects(f.service.registerExisting(replacement, f.proof(replacement, 'live', 5)), code('needs-review'));
    assert.equal(f.catalog.snapshot().collections[c.entity.collectionId].status, 'trashed');
});

test('source links and bad stat wire types are rejected before catalog registration', async t => {
    const f = await fixture(t), outside = join(f.base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'Link.pdf'), pdf('outside'));
    await symlink(outside, join(f.root, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const args = { observationId: randomUUID(), segments: ['Linked'], name: 'Link', expectedStat: stat(await lstat(join(outside, 'Link.pdf'), { bigint: true })), sourceSignature: sha(await readFile(join(outside, 'Link.pdf'))) };
    await assert.rejects(f.service.registerExisting(args, f.proof(args)));
    const clean = await add(f, ['Existing'], 'BadStat'); clean.expectedStat.ino = 123;
    await assert.rejects(f.service.registerExisting(clean, f.proof(clean)), code('invalid')); assert.equal(f.catalog.listPapers().length, 1);
});

test('explicit imports capture policy outside root locks and late outbox/replay never upgrade epoch', async t => {
    let f, epoch = null, captures = 0, delivered = [];
    f = await fixture(t, { captureIngestPolicy: async context => { captures++; assert.equal(typeof context.operationId, 'string'); assert.equal(context.requestHash.length, 64); assert.equal(existsSync(join(f.root, '.dpr-library-journal.json.lock')), false); return { observedPolicyEpoch: epoch, observedTranslation: null }; }, onIngest: async event => { epoch = 8; delivered.push(event); } });
    const source = join(f.base, 'external.pdf'); await writeFile(source, pdf('explicit')); const args = { collectionId: f.catalog.listCollections()[0].collectionId, sources: [{ path: source, name: 'Import' }], operationId: randomUUID() };
    const result = await f.service.importPdfs(args); assert.equal(delivered[0].observedPolicyEpoch, null); assert.equal(result.events[0].observedPolicyEpoch, null);
    assert.deepEqual(await f.service.importPdfs(args), result); assert.equal(captures, 1); assert.equal(delivered.length, 1);
});

test('existing PID eligibility is read only from matching durable ingest event, never fresh observation policy', async t => {
    const f = await fixture(t, { captureIngestPolicy: async ({ collectionId }) => ({ observedPolicyEpoch: 4, observedTranslation: { collectionId, epoch: 2 } }) });
    const source = join(f.base, 'source.pdf'); await writeFile(source, pdf('known import')); const cid = f.catalog.listCollections()[0].collectionId;
    const imported = await f.service.importPdfs({ collectionId: cid, sources: [{ path: source, name: 'Owned' }], operationId: randomUUID() });
    const args = await observed(f, ['Existing'], 'Owned'), result = await f.service.registerExisting(args, f.proof(args, 'live', 99));
    assert.equal(result.created, false); assert.equal(result.entity.paperId, imported.results[0].paperId); assert.deepEqual(result.eligibility, { observedPolicyEpoch: 4, observedTranslation: { collectionId: cid, epoch: 2 } });
    await writeFile(join(f.root, 'Existing', 'Owned.pdf'), pdf('modified existing')); const changed = await observed(f, ['Existing'], 'Owned');
    const existing = await f.service.registerExisting(changed, f.proof(changed, 'live', 99)); assert.equal(existing.entity.paperId, result.entity.paperId); assert.equal(existing.eligibility, null); assert.equal(f.events.length, 1);
});

test('missing/failed import policy capture allows local import with null automatic eligibility', async t => {
    const f = await fixture(t, { captureIngestPolicy: async () => { throw new Error('unavailable observer policy'); } }), source = join(f.base, 'source.pdf'); await writeFile(source, pdf('local copy'));
    const result = await f.service.importPdfs({ collectionId: f.catalog.listCollections()[0].collectionId, sources: [{ path: source }], operationId: randomUUID() });
    assert.equal(result.results[0].created, true); assert.equal(result.events[0].observedPolicyEpoch, null); assert.equal(result.events[0].observedTranslation, null);
});

test('real Runtime and observer register a late baseline raw file and retain explicit live import epoch', async t => {
    const f = await fixture(t), { createPaperRuntime } = await import('../dist/library-runtime.js'), { createLibraryObserver } = await import('../dist/library-observer.js');
    const admissions = []; let clock = 1000;
    const runtime = createPaperRuntime(f.root, {}, {
        createLibraryObserver: options => createLibraryObserver({ ...options, stableMs: 0, now: () => clock }),
        createEnrichmentService: () => ({ initialize: async () => { await mkdir(join(f.root, 'LateBaseline')); await writeFile(join(f.root, 'LateBaseline', 'Raw.pdf'), pdf('late baseline raw')); }, stop: async () => {},
            getAutomation: async () => ({ epoch: 7, autoSummary: true, autoName: false }), admitNew: async event => admissions.push(event) }),
        request: async () => { throw new Error('fixture must never invoke a network request'); },
    });
    t.after(() => runtime.stop()); await runtime.ready; clock++; await runtime.discovery.scan(); clock++; await runtime.discovery.scan();
    const raw = f.catalog.listPapers().find(p => p.name === 'Raw'); assert.ok(raw, JSON.stringify(runtime.discovery.snapshot())); assert.equal(raw.origin, 'baseline'); assert.equal(raw.ingestSeq, 0); assert.equal(admissions.length, 0);
    const source = join(f.base, 'runtime.pdf'); await writeFile(source, pdf('runtime live import'));
    const imported = await runtime.service.importPdfs({ collectionId: f.catalog.listCollections().find(c => c.name === 'Existing').collectionId, sources: [{ path: source }], operationId: randomUUID() });
    assert.equal(imported.results[0].created, true); assert.equal(admissions.length, 1); assert.equal(admissions[0].observedPolicyEpoch, 7);
    const eligibility = await runtime.discovery.getEligibility({ paperId: imported.results[0].paperId, sourceSignature: imported.events[0].sourceSignature }); assert.equal(eligibility.observedPolicyEpoch, 7);
    await runtime.stop();
});

test('a legitimately released reaper between stat and read does not become manual recovery', async t => {
    const f = await fixture(t), journalUrl = new URL('../dist/library-journal.js', import.meta.url).href, reaperPath = join(f.root, '.dpr-library-journal.json.lock.reaper');
    const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const path=${JSON.stringify(reaperPath)};await fs.writeFile(path,JSON.stringify({pid:process.pid,token:'completed-owned-guard'}));const read=fs.readFile;let released=false;fs.readFile=async(p,...a)=>{if(p===path&&!released){released=true;await fs.unlink(path)}return read(p,...a)};syncBuiltinESMExports();const {createJournal}=await import(${JSON.stringify(journalUrl)});try{await createJournal(${JSON.stringify(f.root)}).exclusive(async()=>{});console.log('ok')}catch(e){console.log(e.code);console.error(e.stack);process.exitCode=e.code==='conflict'?2:3}`;
    const result = await runChild(script); assert.ok(result.exit === 0 || result.exit === 2, JSON.stringify(result));
});

test('recovery outbox cannot replace the original catalog receipt policy with another epoch', async t => {
    const f = await fixture(t), args = await add(f, ['Existing'], 'EpochGuard'), catalogUrl = new URL('../dist/paper-catalog.js', import.meta.url).href;
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};import {createLibraryService} from ${JSON.stringify(moduleUrl)};const c=createCatalog(${JSON.stringify(f.root)});const s=createLibraryService(${JSON.stringify(f.root)},{catalog:{...c,transact:async(...a)=>{await c.transact(...a);process.exit(73)}},authorizeDiscovery:()=>({classification:'live',observedPolicyEpoch:3,observedTranslation:null})});await s.initialize();await s.registerExisting(${JSON.stringify(args)},Symbol());`;
    assert.equal((await runChild(script)).exit, 73);
    const path = join(f.root, '.dpr-library-journal.json'), state = JSON.parse(await readFile(path, 'utf8'));
    const op = Object.values(state.operations).find(o => o.kind === 'register-existing'); op.post.events[0].event.observedPolicyEpoch = 99; await writeFile(path, JSON.stringify(state));
    await assert.rejects(f.service.initialize(), code('journal-invalid')); assert.equal(f.events.length, 0); assert.equal(f.catalog.snapshot().ingestSeq, 1);
});

test('catalog-commit crash registration replays original PID and qualification with no filesystem undo', async t => {
    const f = await fixture(t), args = await add(f, ['New', 'Child'], 'Crash'), catalogUrl = new URL('../dist/paper-catalog.js', import.meta.url).href;
    const script = `import {createCatalog} from ${JSON.stringify(catalogUrl)};import {createLibraryService} from ${JSON.stringify(moduleUrl)};const c=createCatalog(${JSON.stringify(f.root)});const proxy={...c,transact:async(...a)=>{const r=await c.transact(...a);process.exit(73);return r}};const s=createLibraryService(${JSON.stringify(f.root)},{catalog:proxy,authorizeDiscovery:()=>({classification:'live',observedPolicyEpoch:3,observedTranslation:null})});await s.initialize();await s.registerExisting(${JSON.stringify(args)},Symbol());`;
    assert.equal((await runChild(script)).exit, 73);
    const source = join(f.root, 'New', 'Child', 'Crash.pdf'), before = sha(await readFile(source)); await f.service.initialize();
    const result = await f.service.registerExisting(args, f.proof(args, 'live', 99)); assert.equal(result.eligibility.observedPolicyEpoch, 3); assert.equal(sha(await readFile(source)), before); assert.equal(f.catalog.snapshot().ingestSeq, 1); assert.equal(f.events.length, 1);
});
