import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaperRuntime } from '../dist/library-runtime.js';
async function fixture(t, observerFailure = false) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-observer-runtime-'));
  await mkdir(join(root, 'Topic')); await writeFile(join(root, 'Topic', 'Paper.pdf'), '%PDF-1.7\n' + 'fixture'.repeat(30));
  const order = [], events = []; let queueOptions, observerOptions, fences = 0;
  const observer = { initialize: async () => { order.push('observer-ready'); if (observerFailure) throw Error('invalid local observer ledger'); }, scan: async () => {}, snapshot: () => ({ pending: [] }),
    withPolicyFence: async fn => { fences++; return fn(); }, authorizeDiscovery: () => null,
    captureIngestPolicy: async () => ({ observedPolicyEpoch: null, observedTranslation: null }),
    rememberImport: async event => { order.push('remember'); events.push(event); }, getEligibility: () => null,
    stop: async () => { order.push('observer-stop'); } };
  const runtime = createPaperRuntime(root, {}, {
    createEnrichmentService: options => { queueOptions = options; return { initialize: async () => {}, stop: async () => { order.push('queue-stop'); },
      getAutomation: async () => ({ epoch: 4, autoSummary: true, autoName: false }), admitNew: async event => { order.push('admit'); events.push(event); } }; },
    createLibraryObserver: options => { observerOptions = options; return observer; },
  });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  await runtime.ready;
  return { runtime, root, observer, order, events, queueOptions, get observerOptions() { return observerOptions; }, get fences() { return fences; } };
}
test('one runtime owns the observer and forwards queue policy changes through its fence', async t => {
  const f = await fixture(t);
  assert.equal(f.runtime.discovery, f.observer);
  assert.equal(typeof f.queueOptions.withPolicyFence, 'function');
  assert.equal(await f.queueOptions.withPolicyFence(async () => 'saved-policy'), 'saved-policy');
  assert.equal(f.fences, 1);
  assert.equal(typeof f.observerOptions.registerExisting, 'function');
  assert.deepEqual(await f.observerOptions.getPolicy(), { epoch: 4, autoSummary: true, autoName: false });
});
test('runtime records import eligibility before automatic admission and defaults old events to no authority', async t => {
  const f = await fixture(t), collectionId = f.runtime.catalog.listCollections()[0].collectionId;
  const source = join(f.root, 'External.pdf'); await writeFile(source, '%PDF-1.7\n' + 'external'.repeat(30));
  await f.runtime.service.importPdfs({ collectionId, sources: [{ path: source }], operationId: 'observer-order' });
  assert.deepEqual(f.order.filter(value => ['remember', 'admit'].includes(value)), ['remember', 'admit']);
  assert.equal(f.events.at(-1).observedPolicyEpoch, null);
});
test('translation rules use the exact Host provider and queue stops before observer work is awaited', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.runtime.setTranslationRulesProvider, 'function');
  const rules = [{ collectionId: f.runtime.catalog.listCollections()[0].collectionId, enabled: true, epoch: 2 }];
  f.runtime.setTranslationRulesProvider(() => rules);
  assert.deepEqual(await f.observerOptions.getTranslationRules(), rules);
  await f.runtime.stop();
  assert.ok(f.order.indexOf('queue-stop') >= 0 && f.order.indexOf('queue-stop') < f.order.indexOf('observer-stop'));
});
test('an invalid observer ledger disables automatic authority while local library work remains available', async t => {
  const f = await fixture(t, true);
  assert.ok(f.order.includes('observer-ready'));
  assert.ok((await f.runtime.service.listTree()).collections.length > 0);
  const collectionId = f.runtime.catalog.listCollections()[0].collectionId;
  const source = join(f.root, 'Manual.pdf'); await writeFile(source, '%PDF-1.7\n' + 'manual'.repeat(30));
  const copied = await f.runtime.service.importPdfs({ collectionId, sources: [{ path: source }], operationId: 'observer-bad-local-copy' });
  assert.equal(copied.results[0].created, true);
  assert.equal(f.events.at(-1).observedPolicyEpoch, null);
  await assert.rejects(f.queueOptions.withPolicyFence(async () => 'unsafe-enable'));
});
