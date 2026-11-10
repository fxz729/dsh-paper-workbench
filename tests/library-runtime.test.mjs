import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transcribe from '../dist/transcribe.js';
let module;
try { module = await import('../dist/library-runtime.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; module = {}; }
async function setup(t) {
  assert.equal(typeof module.createPaperRuntime, 'function', 'one shared runtime must own library and enrichment adapters');
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-'));
  await mkdir(join(root, 'collection'));
  await writeFile(join(root, 'collection', 'paper.pdf'), '%PDF-1.4\n' + 'x'.repeat(120));
  let callbacks, admissions = [];
  const runtime = module.createPaperRuntime(root, {}, {
    createEnrichmentService: options => { callbacks = options; return { initialize: async () => {}, stop: async () => {}, admitNew: async e => admissions.push(e) }; },
    resolveEndpoint: async () => ({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test-only', model: 'local-test' }),
    readText: async () => ({ text: 'verified local text', sourceSignature: 'a'.repeat(64) }),
  });
  await runtime.ready; t.after(() => runtime.stop());
  return { runtime, root, paper: runtime.catalog.listPapers()[0], callbacks, admissions };
}
test('local text extraction is available without replacing transcript caches', () => {
  assert.equal(typeof transcribe.extractLocal, 'function');
});
test('runtime initializes one catalog/service/gate and keeps imported events connected', async t => {
  const { runtime, root, callbacks, admissions } = await setup(t);
  const collectionId = runtime.catalog.listCollections()[0].collectionId;
  const source = join(root, 'external.pdf'); await writeFile(source, '%PDF-1.4\n' + 'z'.repeat(120));
  const result = await runtime.service.importPdfs({ collectionId, sources: [{ path: source }], operationId: 'runtime-import' });
  assert.equal(result.results[0].created, true);
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].origin, 'import');
  assert.equal((await callbacks.resolvePaper({ paperId: admissions[0].paperId })).paperId, admissions[0].paperId);
  assert.equal(await callbacks.getIngestSeq(), 1);
});
test('only trusted UI or exact owner-hook execution proofs authorize paid queue admission', async t => {
  const { runtime, callbacks } = await setup(t);
  assert.equal(callbacks.authorize({ confirmCosts: true }, { action: 'run', planId: 'plan', operationId: 'op' }), false);
  const exec = Object.freeze({ name: 'library_manage', token: Symbol('host-execution'), arguments: Object.freeze({ action: 'run_enrichment', planId: 'plan', operationId: 'op', confirmCosts: true }) });
  assert.equal(runtime.hasToolIntent(exec), false);
  runtime.recordToolIntent(exec);
  assert.equal(runtime.hasToolIntent(exec), true);
  assert.equal(callbacks.authorize(exec.token, { action: 'run', planId: 'plan', operationId: 'op', paperId: 'derived-from-plan' }), true);
  assert.equal(callbacks.authorize(exec.token, { action: 'run', planId: 'other', operationId: 'op' }), false);
  runtime.revokeToolIntent(exec);
  assert.equal(callbacks.authorize(exec.token, { action: 'run', planId: 'plan', operationId: 'op' }), false);
  const proof = runtime.createUiAuthorization('run', { planId: 'plan', operationId: 'op' });
  assert.equal(callbacks.authorize(proof, { action: 'run', planId: 'plan', operationId: 'op' }), true);
});
test('cancelled tool executions lose their paid proof before any later dispatch check', async t => {
  const { runtime, callbacks } = await setup(t), controller = new AbortController();
  const exec = { name: 'library_manage', token: Symbol('cancelled-execution'), signal: controller.signal, arguments: { action: 'run_enrichment', planId: 'plan', operationId: 'op' } };
  runtime.recordToolIntent(exec);
  const context = { action: 'run', planId: 'plan', operationId: 'op' };
  assert.equal(callbacks.authorize(exec.token, context), true);
  controller.abort();
  assert.equal(callbacks.authorize(exec.token, context), false);
  assert.equal(runtime.hasToolIntent(exec), false);
});

test('automation proof authorizes exactly the confirmed capability set', async t => {
  const { runtime, callbacks } = await setup(t);
  const proof = runtime.createUiAuthorization('set-automation', { autoSummary: true, autoName: false });
  assert.equal(callbacks.authorize(proof, { action: 'set-automation', features: ['summary'] }), true);
  assert.equal(callbacks.authorize(proof, { action: 'set-automation', features: ['name'] }), false);
  assert.equal(callbacks.authorize(proof, { action: 'set-automation', features: ['summary', 'name'] }), false);
});

test('long paper tasks prevent rename without holding the root IO mutex', async t => {
  const { runtime, root, paper } = await setup(t);
  let release, started;
  const ready = new Promise(r => { started = r; });
  const task = runtime.withPaperTask(paper.paperId, async ref => { started(); await new Promise(r => { release = r; }); return ref.name; });
  await ready;
  const collection = await runtime.service.createCollection({ name: 'independent', operationId: 'runtime-independent' });
  assert.ok(collection.entity.collectionId);
  const plan = await runtime.service.planRename({ paperId: paper.paperId, name: 'renamed' });
  await assert.rejects(runtime.service.applyRename({ planId: plan.planId, operationId: 'blocked-by-task' }), e => e.code === 'reader-busy');
  release(); assert.equal(await task, 'paper');
  const fresh = await runtime.service.planRename({ paperId: paper.paperId, name: 'renamed' });
  await runtime.service.applyRename({ planId: fresh.planId, operationId: 'after-task' });
  assert.match(await readFile(join(root, 'collection', 'renamed.pdf'), 'utf8'), /%PDF/);
});
test('a disposed Host root releases its singleton so a later plugin activation gets a live runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dpr-runtime-reopen-'));
  const first = module.getPaperRuntime(root); await first.ready;
  assert.equal(module.getPaperRuntime(root), first);
  await first.stop();
  const second = module.getPaperRuntime(root); t.after(() => second.stop());
  assert.notEqual(second, first);
  await second.ready;
  assert.equal(second.gate.snapshot().closed, false);
});

test('trusted tool rename aborts while waiting for reader save instead of committing after a late ACK', async t => {
  const { runtime, paper } = await setup(t);
  assert.equal(typeof runtime.applyToolRename, 'function');
  const credentials = runtime.gate.register({ paperId: paper.paperId });
  const plan = await runtime.service.planRename({ collectionId: paper.collectionId, name: 'renamed collection' });
  const controller = new AbortController(), args = { collectionId: paper.collectionId, planId: plan.planId, operationId: 'cancelled-rename' };
  const exec = { name: 'library_manage', token: Symbol('rename-execution'), signal: controller.signal, arguments: { action: 'update_collection', ...args } };
  runtime.recordToolIntent(exec);
  const work = runtime.applyToolRename(exec, args); work.catch(() => {});
  let command;
  for (let i = 0; i < 200; i++) {
    command = runtime.gate.heartbeat(credentials).command;
    if (command?.type === 'prepare') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(command?.type, 'prepare');
  controller.abort(); runtime.revokeToolIntent(exec);
  await assert.rejects(work);
  assert.equal(runtime.catalog.resolveCollection({ collectionId: paper.collectionId }).name, 'collection');
  runtime.gate.unregister(credentials);
});

test('same-process short IO runs FIFO instead of returning a transient disk-lock conflict', async t => {
  const { runtime, paper } = await setup(t), order = [];
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const first = runtime.withPaperWrite(paper.paperId, async () => { order.push('first'); entered(); await new Promise(resolve => { release = resolve; }); order.push('released'); });
  await started;
  const second = runtime.withPaperWrite(paper.paperId, async () => { order.push('second'); }); second.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 20)); release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'released', 'second']);
});

test('nested short IO remains a conflict rather than waiting behind its own lease', async t => {
  const { runtime, paper } = await setup(t);
  await runtime.withPaperWrite(paper.paperId, async () => {
    await assert.rejects(runtime.withPaperWrite(paper.paperId, async () => {}), e => e.code === 'conflict');
  });
});

test('short local IO leases re-resolve IDs and reject prepared reader operations', async t => {
  const { runtime, paper } = await setup(t);
  assert.equal(await runtime.withPaperWrite(paper.paperId, async ref => ref.paperId), paper.paperId);
  const lease = await runtime.gate.prepare({ paperIds: [paper.paperId], operation: { operationId: 'prepared-for-write', type: 'rename-paper' } });
  await assert.rejects(runtime.withPaperWrite(paper.paperId, async () => assert.fail('prepared write must not execute')), e => e.code === 'reader-busy');
  lease.release();
});
