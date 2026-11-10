import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const home = await mkdtemp(join(tmpdir(), 'dpr-host-discovery-home-')), previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
after(async () => { if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome; await rm(home, { recursive: true, force: true }); });
const { registerRoutes } = await import('../dist/host.js');
const { createPaperRuntime } = await import('../dist/library-runtime.js');
const { createLibraryObserver } = await import('../dist/library-observer.js');
const pdf = '%PDF-1.7\n' + '% owned local fixture\n'.repeat(10) + '%%EOF';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-host-discovery-'));
  await mkdir(join(root, 'Parent', 'Child'), { recursive: true }); await mkdir(join(root, 'Parent', 'Other'));
  await writeFile(join(root, 'Parent', 'Child', 'Paper.pdf'), pdf);
  let observerOptions, handler, dispose, server, requests = 0; const events = [];
  const runtime = createPaperRuntime(root, {}, {
    createLibraryObserver: options => { observerOptions = options; return createLibraryObserver({ ...options, stableMs: 0 }); },
    createEnrichmentService: () => ({ initialize: async () => {}, stop: async () => {},
      getAutomation: async () => ({ epoch: 0, autoSummary: false, autoName: false }), jobs: async () => [],
      admitNew: async event => { events.push(event); }, run: async () => { requests++; throw Error('provider prohibited'); } }),
  });
  t.after(async () => { await dispose?.(); await runtime.stop(); server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); assert.equal(requests, 0); });
  // Register before ready, as the actual Desktop Host does; discovery callbacks must stay lazy.
  const ctx = { webServer: { register: route => { handler = route.handler; return () => {}; } }, connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: [] }) }, workspaceController: {}, workspaceRegistry: {}, effect: fn => { dispose = fn(); } };
  registerRoutes(ctx, { dataDir: root }, { runtime });
  server = http.createServer((req, res) => handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = async (path, body) => { const response = await fetch(origin + '/paper-reader' + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, value: await response.json() }; };
  await runtime.ready;
  return { root, runtime, request, events, observerOptions };
}
test('Host enables an exact nested CID and exposes collection IDs for existing batch UI', async t => {
  const f = await fixture(t), collection = f.runtime.catalog.listCollections().find(row => row.name === 'Child');
  assert.equal((await f.request('/api/automation')).status, 200);
  const enabled = await f.request('/api/automation', { collectionId: collection.collectionId, enabled: true, confirmCosts: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.value));
  const rules = await f.observerOptions.getTranslationRules();
  assert.equal(rules.find(row => row.collectionId === collection.collectionId)?.enabled, true);
  assert.equal(rules.filter(row => row.enabled).length, 1);
  const library = await f.request('/api/library');
  assert.ok(library.value.collections.some(row => row.collectionId === collection.collectionId));
});
test('automation rejects invalid CID strings without treating inherited map properties as library rows', async t => {
  const f = await fixture(t);
  for (const collectionId of ['constructor', '__proto__', 'toString']) {
    const response = await f.request('/api/automation', { collectionId, enabled: false });
    assert.equal(response.status, 400, collectionId);
  }
});
test('legacy nested topic admission maps to one CID and deletion disables that retired rule', async t => {
  const f = await fixture(t), collection = f.runtime.catalog.listCollections().find(row => row.name === 'Child');
  assert.equal((await f.request('/api/automation', { topic: 'Parent/Child', enabled: true, confirmCosts: true })).status, 200);
  const planned = await f.request('/api/library/topic/clear-plan?collectionId=' + collection.collectionId); assert.equal(planned.status, 200);
  assert.equal((await f.request('/api/library/changes/delete', { planId: planned.value.planId, operationId: 'discovery-cleanup' })).status, 200);
  const state = JSON.parse(await readFile(join(f.root, '.dpr-library-automation.json'), 'utf8'));
  assert.equal(state.rules.find(row => row.collectionId === collection.collectionId)?.enabled, false);
});
test('the existing Host poller discovers raw PDFs even when both automation systems are off', async t => {
  const f = await fixture(t); await f.request('/api/automation');
  await writeFile(join(f.root, 'Parent', 'Child', 'Fresh.pdf'), pdf);
  await f.runtime.discovery.scan(); // First stable sample; the existing Host timer supplies the second.
  let added;
  for (const deadline = Date.now() + 9000; Date.now() < deadline;) {
    const library = await f.request('/api/library'); added = library.value.papers.find(row => row.name === 'Fresh');
    if (added && f.events.some(event => event.paperId === added.paperId)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(added?.paperId, 'the one existing poller must drive discovery without an enabled translation rule');
  assert.equal(f.runtime.catalog.resolvePaper({ paperId: added.paperId }).origin, 'import');
  assert.equal(f.events.length, 1); assert.equal(f.events[0].observedPolicyEpoch, null);
});
test('automatic enqueue receipts preserve exact PID, CID and source signature at the real Host adapter', async () => {
  const source = await readFile(new URL('../dist/host.js', import.meta.url), 'utf8');
  const begin = source.indexOf('const enqueueChecked = ') + 'const enqueueChecked = '.length, end = source.indexOf('    const automation =', begin);
  const ref = { paperId: '11111111-1111-4111-8111-111111111111', collectionId: '22222222-2222-4222-8222-222222222222', topic: 'Parent/Child', name: 'Paper', sourceSignature: 'a'.repeat(64) };
  const queue = { rows: [], snapshot() { return { items: this.rows }; }, enqueue(rows) { this.rows = rows.map((row, i) => ({ ...row, id: 'job-' + i, status: 'queued' })); return { added: this.rows.map(row => row.id) }; } };
  const context = { requireQueue: () => queue, safeLibraryRef: () => ref, translationHealth: async () => ({ state: 'missing' }), sourceFingerprint: async () => ref.sourceSignature, ManageError: Error };
  vm.runInNewContext('this.enqueue = ' + source.slice(begin, end), context);
  const receipt = await context.enqueue([ref], false, { authorize: () => true });
  assert.equal(receipt.enqueued[0].paperId, ref.paperId); assert.equal(receipt.enqueued[0].collectionId, ref.collectionId); assert.equal(receipt.enqueued[0].sourceSignature, ref.sourceSignature);
});
