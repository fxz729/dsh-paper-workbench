// Full local Runtime/observer/Service/queue chain. PDF text and model responses are explicit test adapters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPaperRuntime } from '../dist/library-runtime.js';
import { createLibraryObserver } from '../dist/library-observer.js';
import { sourceFingerprint } from '../dist/paper-health.js';
import { readPaperMetadata } from '../dist/paper-metadata.js';
const pdf = '%PDF-1.7\n' + '% local owned discovery fixture\n'.repeat(10) + '%%EOF';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-discovery-enrichment-')); await mkdir(join(root, 'Topic')); await writeFile(join(root, 'Topic', 'Baseline.pdf'), pdf);
  let calls = 0;
  const runtime = createPaperRuntime(root, {}, {
    createLibraryObserver: options => createLibraryObserver({ ...options, stableMs: 0 }),
    resolveEndpoint: async () => ({ baseUrl: 'http://fake.invalid/v1', apiKey: 'fake-only', model: 'fake-model' }),
    readText: async ref => ({ text: 'Alice 2024 Study. Local fixture text with evidence.', sourceSignature: await sourceFingerprint(ref) }),
    request: async () => { calls++; return { summary: 'Qualified raw PDF summary', bibliography: {}, namingReady: false, proposedName: null, needsReview: false, model: 'fake-model' }; },
  });
  t.after(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
  await runtime.ready;
  const enable = async () => { const old = await runtime.enrichment.getAutomation(), flags = { expectedRevision: old.revision, autoSummary: true, autoName: false, confirmCosts: true }; return runtime.enrichment.setAutomation(flags, runtime.createUiAuthorization('set-automation', flags)); };
  return { root, runtime, calls: () => calls, enable };
}
test('a genuinely new raw PDF in a future child receives one global summary through the real local chain', async t => {
  const f = await fixture(t), parent = f.runtime.catalog.listCollections()[0]; await f.enable();
  assert.equal(f.calls(), 0);
  await mkdir(join(f.root, 'Topic', 'Future')); await writeFile(join(f.root, 'Topic', 'Future', 'Fresh.pdf'), pdf);
  await f.runtime.discovery.scan(); await f.runtime.discovery.scan();
  const paper = f.runtime.catalog.listPapers().find(row => row.name === 'Fresh'); assert.ok(paper);
  const child = f.runtime.catalog.resolveCollection({ collectionId: paper.collectionId }); assert.equal(child.parentId, parent.collectionId);
  assert.equal(f.calls(), 1); assert.equal((await readPaperMetadata(f.root, paper.paperId)).summary.text, 'Qualified raw PDF summary');
  assert.equal((await f.runtime.enrichment.jobs({ paperId: paper.paperId }))[0].status, 'done');
  await f.runtime.discovery.scan(); assert.equal(f.calls(), 1);
});
test('a raw PDF first observed before enabling stays uncharged even when registration finishes afterwards', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'Topic', 'Pending.pdf'), pdf); await f.runtime.discovery.scan();
  await f.enable();
  await f.runtime.discovery.scan(); await f.runtime.discovery.scan();
  const paper = f.runtime.catalog.listPapers().find(row => row.name === 'Pending'); assert.ok(paper);
  assert.equal(f.calls(), 0); assert.equal((await readPaperMetadata(f.root, paper.paperId)).summary.source, 'empty');
  assert.deepEqual(await f.runtime.enrichment.jobs({ paperId: paper.paperId }), []);
});
