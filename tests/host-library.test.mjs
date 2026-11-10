import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { registerRoutes } = await import('../dist/host.js');
import { createPaperRuntime } from '../dist/library-runtime.js';
import { ShortTextError } from '../dist/transcribe.js';
const pdf = '%PDF-1.4\n' + 'fixture'.repeat(30);
async function fixture(t, rows = [], automationState) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-host-library-'));
  await mkdir(join(root, 'parent', 'child'), { recursive: true });
  await writeFile(join(root, 'parent', 'child', 'paper.pdf'), pdf);
  let apiCalls = 0, register, dispose;
  const runtime = createPaperRuntime(root, {}, {
    createEnrichmentService: options => ({ initialize: async () => {}, stop: async () => {}, admitNew: async () => {},
      getAutomation: async () => ({ revision: null, autoSummary: false, autoName: false, epoch: 0 }), jobs: async () => [],
      plan: async args => ({ planId: 'local-plan', ...args, model: 'fixture', inputChars: 30, costNotice: 'test' }),
      run: async (args, proof) => { assert.equal(options.authorize(proof, { action: 'run', planId: args.planId, operationId: args.operationId }), true); apiCalls++; return { jobId: 'job', status: 'done' }; },
    }),
    resolveEndpoint: async () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', model: 'fixture' }),
  });
  await runtime.ready;
  if (automationState) await writeFile(join(root, '.dpr-library-automation.json'), JSON.stringify(automationState));
  let inspectSessions;
  const setSessionInspector = runtime.setSessionInspector;
  runtime.setSessionInspector = inspector => { inspectSessions = inspector; return setSessionInspector(inspector); };
  const ctx = { webServer: { register: r => { register = r.handler; return () => {}; } },
    connection: { requestRejection: () => undefined },
    sessionController: { list: async () => ({ items: structuredClone(rows) }), create: async s => { rows.push({ ...s, blank: true, running: false }); return s; } },
    workspaceController: { create: async () => ({ workspace: { workspaceId: 'workspace' } }) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => {} },
    effect: fn => { dispose = fn(); },
  };
  registerRoutes(ctx, { dataDir: root, translate: {} }, { runtime });
  const server = http.createServer((req, res) => register(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await dispose(); await runtime.stop(); await new Promise(r => server.close(r)); });
  const request = async (path, body, headers = {}) => {
    const response = await fetch(origin + '/paper-reader' + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, value };
  };
  return { root, runtime, request, origin, calls: () => apiCalls, paper: runtime.catalog.listPapers()[0], inspectSessions: (...args) => inspectSessions(...args) };
}
test('recovery session admission retains unbound legacy and v2 owners after the source has moved', async t => {
  const rows = [], f = await fixture(t, rows), id = f.paper.paperId;
  await f.request('/api/library/tree');
  const source = join(f.root, 'external.pdf'); await writeFile(source, pdf);
  await f.runtime.service.importPdfs({ collectionId: f.paper.collectionId, sources: [{ path: source }], operationId: 'recovery-unrelated-import' });
  rows.push({ sessionId: `dpr-${Buffer.from('parent/child/external').toString('base64url')}`, running: false });
  await rename(join(f.root, 'parent', 'child', 'paper.pdf'), join(f.root, 'moved.pdf'));
  for (const sessionId of [`dpr-${Buffer.from('parent/child/paper').toString('base64url')}`, `dpr-v2-${id}-1`]) {
    rows.push({ sessionId, running: true });
    await assert.rejects(f.inspectSessions([id], { recovering: true }), e => e.code === 'session-running');
    rows.pop();
  }
  rows.push({ sessionId: 'unrelated', running: true });
  await f.inspectSessions([id], { recovering: true });
});
test('real Host serves recursive tree and canonical ID paper responses without server paths', async t => {
  const f = await fixture(t), tree = await f.request('/api/library/tree');
  assert.equal(tree.status, 200);
  assert.equal(tree.value.collections.length, 2);
  assert.equal(tree.value.papers[0].paperId, f.paper.paperId);
  const paper = await f.request('/api/paper?paperId=' + f.paper.paperId);
  assert.equal(paper.status, 200); assert.equal(paper.value.paperId, f.paper.paperId);
  assert.equal(paper.value.pdfPath, undefined);
});
test('details local writes use metadata CAS and manual provenance', async t => {
  const f = await fixture(t), id = f.paper.paperId;
  const initial = await f.request('/api/library/details?paperId=' + id);
  assert.equal(initial.status, 200); assert.equal(initial.value.metadata.revision, null);
  assert.equal(initial.value.endpoint.apiKey, undefined);
  const saved = await f.request('/api/library/details', { paperId: id, revision: null, summaryText: 'user local draft', source: 'api' });
  assert.equal(saved.status, 200); assert.equal(saved.value.metadata.summary.source, 'manual');
  const stale = await f.request('/api/library/details', { paperId: id, revision: null, summaryText: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(f.calls(), 0);
});
test('reader gate HTTP credentials and prepare/ACK/resume protect the same service rename', async t => {
  const f = await fixture(t), registered = await f.request('/api/readers/register', { paperId: f.paper.paperId });
  assert.equal(registered.status, 200);
  const credentials = registered.value;
  assert.ok(credentials.token);
  const pending = f.runtime.gate.prepare({ paperIds: [f.paper.paperId], operation: { operationId: 'host-prepare', type: 'rename-paper' } });
  const heartbeat = await f.request('/api/readers/heartbeat', credentials);
  assert.equal(heartbeat.value.command.type, 'prepare');
  assert.equal((await f.request('/api/readers/ack', { ...credentials, operationId: 'host-prepare', nonce: heartbeat.value.command.nonce, ok: true })).status, 200);
  const lease = await pending;
  lease.release({ entityId: f.paper.paperId });
  const resumed = await f.request('/api/readers/heartbeat', credentials);
  assert.equal(resumed.value.command.type, 'resume');
  await f.request('/api/readers/ack', { ...credentials, operationId: 'host-prepare', nonce: resumed.value.command.nonce, ok: true });
  assert.equal((await f.request('/api/readers/unregister', credentials)).status, 200);
});
test('shared plan/apply physically renames while old URL claims resolve by stable identity', async t => {
  const f = await fixture(t), id = f.paper.paperId;
  const planned = await f.request('/api/library/changes/plan', { paperId: id, name: 'renamed', expectedLocationRevision: 1 });
  assert.equal(planned.status, 200);
  const applied = await f.request('/api/library/changes/apply', { planId: planned.value.plan.planId, operationId: 'host-rename' });
  assert.equal(applied.status, 200); assert.equal(applied.value.entity.paperId, id);
  assert.equal(await readFile(join(f.root, 'parent', 'child', 'renamed.pdf'), 'utf8'), pdf);
  const old = await f.request('/api/paper?topic=parent%2Fchild&name=paper');
  assert.equal(old.value.paperId, id); assert.equal(old.value.name, 'renamed');
});
test('new sublibraries share the same root and upload bytes enter stable catalog once', async t => {
  const f = await fixture(t), parentId = f.paper.collectionId;
  const created = await f.request('/api/library/collections', { parentId, name: 'new child', note: 'classification', operationId: 'host-child' });
  assert.equal(created.status, 200);
  const response = await fetch(f.origin + '/paper-reader/api/library/upload', { method: 'POST', headers: { origin: f.origin, 'x-dpr-collection-id': created.value.entity.collectionId, 'x-dpr-name': 'new.pdf' }, body: pdf });
  assert.equal(response.status, 200);
  const uploaded = await response.json(); assert.ok(uploaded.paperId);
  assert.equal(f.runtime.catalog.resolvePaper({ paperId: uploaded.paperId }).origin, 'import');
});
test('prepared reader leases reject ink writes before altering sidecars', async t => {
  const f = await fixture(t), paperId = f.paper.paperId;
  const initial = await f.request('/api/ink?paperId=' + paperId);
  assert.equal(initial.status, 200);
  const lease = await f.runtime.gate.prepare({ paperIds: [paperId], operation: { operationId: 'frozen-paper', type: 'rename-paper' } });
  try {
    const response = await f.request('/api/ink', { paperId, variant: 'orig', revision: initial.value.revision, document: initial.value.document });
    assert.equal(response.status, 409);
    assert.equal(response.value.code, 'reader-busy');
  } finally { lease.release(); }
});

test('legacy topic creation enters the same indexed library tree', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/library/topic', { name: 'legacy topic' });
  assert.equal(created.status, 200);
  const tree = await f.request('/api/library/tree');
  assert.ok(tree.value.collections.some(c => c.name === 'legacy topic'));
});

test('new actual sessions bind immediately and legacy same-number sessions stay distinct', async t => {
  const prefix = `dpr-${Buffer.from('parent/child/paper').toString('base64url')}`;
  const rows = [{ sessionId: prefix, blank: false }, { sessionId: prefix + '-1', blank: false }];
  const f = await fixture(t, rows);
  const listed = await f.request('/api/sessions?paperId=' + f.paper.paperId);
  assert.equal(listed.status, 200); assert.equal(listed.value.sessions.length, 2);
  const created = await f.request('/api/sessions/new', { paperId: f.paper.paperId });
  assert.equal(created.status, 200);
  assert.match(created.value.sessionId, /^dpr-v2-/);
  assert.equal(f.runtime.catalog.resolvePaper({ sessionId: created.value.sessionId }).paperId, f.paper.paperId);
});

test('legacy rename endpoint uses the shared ID transaction and preserves session bindings', async t => {
  const f = await fixture(t), id = f.paper.paperId;
  const renamed = await f.request('/api/library/rename-paper', { paperId: id, topic: 'parent/child', name: 'paper', newName: 'legacy renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(f.runtime.catalog.resolvePaper({ paperId: id }).name, 'legacy renamed');
  assert.equal(renamed.value.detachedSessions || 0, 0);
});

test('archiving a real bound legacy draft uses exact binding rather than the current ID prefix', async t => {
  const sessionId = `dpr-${Buffer.from('parent/child/paper').toString('base64url')}-1`;
  const f = await fixture(t, [{ sessionId, blank: true, running: false }]);
  const response = await f.request('/api/sessions/archive', { paperId: f.paper.paperId, sessionId });
  assert.equal(response.status, 200);
});

test('ask rejects an explicitly supplied session outside the selected immutable paper', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/ask', { paperId: f.paper.paperId, sessionId: 'unbound-other-session', question: 'local fixture question' });
  assert.equal(response.status, 409);
});

test('nested location lookup resolves exact stable references without running the file manager', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/library/location', { paperId: f.paper.paperId, action: 'path' });
  assert.equal(response.status, 200);
  assert.equal(response.value.path, join(f.root, 'parent', 'child', 'paper.pdf'));
});

test('all shared mutation entry points reject a running bound companion before moving files', async t => {
  const sessionId = `dpr-${Buffer.from('parent/child/paper').toString('base64url')}-1`;
  const f = await fixture(t, [{ sessionId, running: true, blank: false }]);
  const planned = await f.request('/api/library/changes/plan', { paperId: f.paper.paperId, name: 'while running' });
  assert.equal(planned.status, 200);
  const response = await f.request('/api/library/changes/apply', { planId: planned.value.plan.planId, operationId: 'running-session-http' });
  assert.equal(response.status, 409);
  const direct = await f.runtime.service.planRename({ paperId: f.paper.paperId, name: 'direct while running' });
  await assert.rejects(f.runtime.service.applyRename({ planId: direct.planId, operationId: 'running-session-direct' }), e => e.code === 'reader-busy');
  assert.equal(f.runtime.catalog.resolvePaper({ paperId: f.paper.paperId }).name, 'paper');
  assert.equal(await readFile(join(f.root, 'parent', 'child', 'paper.pdf'), 'utf8'), pdf);
});

test('a companion starting during reader-save wait is rechecked before rename admission', async t => {
  const sessionId = `dpr-${Buffer.from('parent/child/paper').toString('base64url')}-1`, rows = [{ sessionId, running: false, blank: false }];
  const f = await fixture(t, rows), paperId = f.paper.paperId;
  const registered = await f.request('/api/readers/register', { paperId }), credentials = registered.value;
  const planned = await f.request('/api/library/changes/plan', { paperId, name: 'late session' });
  const pending = f.request('/api/library/changes/apply', { planId: planned.value.plan.planId, operationId: 'late-session-gate' });
  let command;
  for (let i = 0; i < 200; i++) {
    command = f.runtime.gate.heartbeat(credentials).command;
    if (command?.type === 'prepare') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(command?.type, 'prepare');
  rows[0].running = true;
  await f.request('/api/readers/ack', { ...credentials, operationId: command.operationId, nonce: command.nonce, ok: true });
  const outcome = await pending;
  assert.equal(outcome.status, 409);
  assert.equal(f.runtime.catalog.resolvePaper({ paperId }).name, 'paper');
  assert.equal(f.runtime.gate.heartbeat(credentials).command.type, 'resume');
  f.runtime.gate.unregister(credentials);
});

test('an idle ambiguous historical session does not freeze unrelated immutable IDs', async t => {
  const rows = [], f = await fixture(t, rows);
  const original = await f.runtime.service.planRename({ paperId: f.paper.paperId, name: 'old moved' });
  await f.runtime.service.applyRename({ planId: original.planId, operationId: 'ambiguous-move' });
  const source = join(f.root, 'source.pdf'); await writeFile(source, pdf);
  const reused = await f.runtime.service.importPdfs({ collectionId: f.paper.collectionId, sources: [{ path: source, name: 'paper' }], operationId: 'ambiguous-reuse' });
  const other = await f.runtime.service.createCollection({ name: 'Unrelated', operationId: 'unrelated-collection' });
  const imported = await f.runtime.service.importPdfs({ collectionId: other.entity.collectionId, sources: [{ path: source, name: 'safe' }], operationId: 'unrelated-import' });
  rows.push({ sessionId: `dpr-${Buffer.from('parent/child/paper').toString('base64url')}-1`, running: false, blank: false });
  const plan = await f.runtime.service.planRename({ paperId: imported.results[0].paperId, name: 'unrelated moved' });
  await assert.doesNotReject(f.runtime.service.applyRename({ planId: plan.planId, operationId: 'unrelated-rename' }));
  rows[0].running = true;
  const protectedPlan = await f.runtime.service.planRename({ paperId: reused.results[0].paperId, name: 'ambiguous running target' });
  await assert.rejects(f.runtime.service.applyRename({ planId: protectedPlan.planId, operationId: 'ambiguous-running' }), e => e.code === 'reader-busy');
});

test('legacy collection rename uses the shared transaction and keeps nested paper identity', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/library/rename-topic', { collectionId: f.paper.collectionId, topic: 'parent/child', newName: 'new child' });
  assert.equal(response.status, 200);
  const current = f.runtime.catalog.resolvePaper({ paperId: f.paper.paperId });
  assert.deepEqual(current.segments, ['parent', 'new child']);
  assert.equal(current.paperId, f.paper.paperId);
  assert.equal(await readFile(current.pdfPath, 'utf8'), pdf);
});

test('selection translation recognizes an ID-only missing target before resolving any paid endpoint', async t => {
  const f = await fixture(t);
  const response = await f.request('/api/translate-selection', { paperId: randomUUID(), chunks: [{ kind: 'text', page: 1, text: 'a local quote' }] });
  assert.equal(response.status, 404);
  assert.equal(response.value.code, 'not-found');
  assert.equal(f.calls(), 0);
});

test('workspace discovery includes canonical nested collections', async t => {
  const f = await fixture(t), response = await f.request('/api/library/workspaces');
  assert.equal(response.status, 200);
  assert.ok(response.value.paths.includes(join(f.root, 'parent', 'child')));
});

test('write locators prioritize immutable ID over a stale path and honor prepared readers', async t => {
  const f = await fixture(t), paperId = f.paper.paperId;
  const lease = await f.runtime.gate.prepare({ paperIds: [paperId], operation: { operationId: 'transcript-frozen', type: 'rename-paper' } });
  try {
    const response = await f.request('/api/transcribe', { paperId, path: join(f.root, 'old-name.pdf'), source: 'pdfjs' });
    assert.equal(response.status, 409);
    assert.equal(response.value.code, 'reader-busy');
  } finally { lease.release(); }
});

test('generic library management shares rooted service and fixes metadata provenance to manual', async t => {
  const f = await fixture(t);
  const listed = await f.request('/api/library/manage', { action: 'list' });
  assert.equal(listed.status, 200); assert.equal(listed.value.result.collections.length, 2);
  const created = await f.request('/api/library/manage', { action: 'create_collection', parentId: f.paper.collectionId, name: 'from management', operationId: 'generic-create' });
  assert.equal(created.status, 200); assert.ok(created.value.result.entity.collectionId);
  const saved = await f.request('/api/library/manage', { action: 'update_paper', paperId: f.paper.paperId, revision: null, summaryText: 'local generic draft', source: 'api' });
  assert.equal(saved.status, 200); assert.equal(saved.value.result.metadata.summary.source, 'manual');
  assert.equal((await f.request('/api/library/manage', { action: 'delete_everything' })).status, 400);
  assert.equal(f.calls(), 0);
});

test('generic paid management keeps the same explicit confirmation boundary', async t => {
  const f = await fixture(t);
  const args = { action: 'run_enrichment', planId: 'local-plan', operationId: 'generic-paid' };
  assert.equal((await f.request('/api/library/manage', args)).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/library/manage', { ...args, confirmCosts: true })).status, 200);
  assert.equal(f.calls(), 1);
});

test('parallel initial ink reads share local IO admission without permanent startup conflicts', async t => {
  const f = await fixture(t);
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/ink?paperId=' + f.paper.paperId)));
  assert.deepEqual(replies.map(response => response.status), Array(12).fill(200));
});

test('insufficient local text is an actionable no-charge review condition', async t => {
  const f = await fixture(t);
  f.runtime.enrichment.plan = async () => { throw new ShortTextError('本地提取的文本过少'); };
  const response = await f.request('/api/enrichment/plan', { paperId: f.paper.paperId, features: ['summary'] });
  assert.equal(response.status, 422);
  assert.equal(response.value.code, 'text-unavailable');
  assert.match(response.value.error, /未调用 API/);
  assert.doesNotMatch(response.value.error, /填写|手写|草稿/);
  assert.equal(f.calls(), 0);
});

test('paid run requires explicit same-origin confirmation and local plan makes zero requests', async t => {
  const f = await fixture(t);
  const plan = await f.request('/api/enrichment/plan', { paperId: f.paper.paperId, features: ['summary'] });
  assert.equal(plan.status, 200); assert.equal(f.calls(), 0);
  const args = { planId: plan.value.plan.planId, operationId: 'host-generate' };
  assert.equal((await f.request('/api/enrichment/run', args)).status, 403);
  assert.equal((await f.request('/api/enrichment/run', { ...args, confirmCosts: true }, { origin: 'https://other.invalid' })).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/enrichment/run', { ...args, confirmCosts: true })).status, 200);
  assert.equal(f.calls(), 1);
});

async function detailsCapability(f) {
  const page = await f.request('/paper-details.html?paperId=' + f.paper.paperId);
  assert.equal(page.status, 200);
  const match = typeof page.value === 'string' && page.value.match(/<meta name="dpr-ui-csrf" content="([0-9a-f-]{36})">/);
  assert.ok(Boolean(match), 'authenticated no-store details HTML contains an in-memory UI capability');
  return match[1];
}
test('Desktop paid request without Origin requires the private details capability', async t => {
  const f = await fixture(t), token = await detailsCapability(f);
  const args = { planId: 'local-plan', operationId: 'desktop-cap', confirmCosts: true };
  assert.equal((await f.request('/api/enrichment/run', args, { origin: '' })).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/enrichment/run', args, { origin: '', 'x-dpr-ui-csrf': token })).status, 200);
  assert.equal(f.calls(), 1);
});
test('Desktop capability rejects cross-site, wrong capability and missing click authorization', async t => {
  const f = await fixture(t), token = await detailsCapability(f), args = { planId: 'local-plan', operationId: 'desktop-invalid', confirmCosts: true };
  for (const headers of [
    { origin: '', 'x-dpr-ui-csrf': 'wrong' },
    { origin: 'https://other.invalid', 'x-dpr-ui-csrf': token },
    { origin: 'null', 'x-dpr-ui-csrf': token, 'sec-fetch-site': 'cross-site' },
    { origin: 'null' },
  ]) assert.equal((await f.request('/api/enrichment/run', args, headers)).status, 403);
  assert.equal((await f.request('/api/enrichment/run', { ...args, confirmCosts: false }, { origin: '', 'x-dpr-ui-csrf': token })).status, 403);
  assert.equal(f.calls(), 0);
  assert.equal((await f.request('/api/enrichment/run', args, { origin: 'null', 'x-dpr-ui-csrf': token })).status, 200);
  assert.equal(f.calls(), 1);
});
test('capabilities from another Host instance cannot authorize this instance', async t => {
  const first = await fixture(t), second = await fixture(t), token = await detailsCapability(first);
  assert.equal((await second.request('/api/enrichment/run', { planId: 'local-plan', operationId: 'old-cap', confirmCosts: true }, { origin: '', 'x-dpr-ui-csrf': token })).status, 403);
  assert.equal(second.calls(), 0);
});
test('explicit retry route keeps the new click tied to its original job', async t => {
  const f = await fixture(t); let calls = 0;
  f.runtime.enrichment.retry = async (args, proof) => { assert.ok(proof && typeof proof === 'object'); assert.equal(args.jobId, 'old-job'); calls++; return { jobId: 'retry-job', status: 'done' }; };
  const args = { jobId: 'old-job', operationId: 'explicit-retry', confirmCosts: true };
  assert.equal((await f.request('/api/enrichment/retry', { ...args, confirmCosts: false })).status, 403);
  assert.equal((await f.request('/api/enrichment/retry', args)).status, 200);
  assert.equal(calls, 1);
});

test('batch page provides no-store capability for Desktop automatic translation confirmation', async t => {
  const f = await fixture(t);
  const page = await fetch(f.origin + '/paper-reader/batch');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text(), token = html.match(/<meta name="dpr-ui-csrf" content="([0-9a-f-]{36})">/)?.[1];
  assert.ok(token, 'batch HTML must carry the private page capability');
  const args = { collectionId: f.paper.collectionId, enabled: true, confirmCosts: true };
  assert.equal((await f.request('/api/automation', args, { origin: '' })).status, 403);
  assert.equal((await f.request('/api/automation', args, { origin: '', 'x-dpr-ui-csrf': token })).status, 200);
  assert.equal((await f.request('/api/automation', args, { origin: 'https://other.invalid', 'x-dpr-ui-csrf': token })).status, 403);
  assert.equal(f.calls(), 0);
});
test('legacy hint dismissal hides only display records and retains fee safety evidence', async t => {
  const legacyReview=[{topic:'Removed',name:'Old',signature:'a'.repeat(64),status:'intent'}];
  const f=await fixture(t,[],{version:2,rules:[],records:[],legacyReview});
  const before=await f.request('/api/automation'); assert.equal(before.status,200);
  const old=before.value.pending.find(p=>p.kind==='legacy'); assert.ok(old?.id);
  assert.equal((await f.request('/api/automation',{action:'dismiss-legacy',id:'unknown'})).status,400);
  assert.equal((await f.request('/api/automation',{action:'dismiss-legacy',id:old.id,enabled:true})).status,400);
  const after=await f.request('/api/automation',{action:'dismiss-legacy',id:old.id});
  assert.equal(after.status,200); assert.equal(after.value.pending.some(p=>p.kind==='legacy'),false);
  const saved=JSON.parse(await readFile(join(f.root,'.dpr-library-automation.json'),'utf8'));
  assert.deepEqual(saved.legacyReview,legacyReview); assert.equal(saved.rules.length,0); assert.equal(f.calls(),0);
  assert.equal((await f.request('/api/automation',{action:'dismiss-legacy'})).status,200);
});
test('global translation requires explicit scope, boolean and fee confirmation, with Desktop capability', async t => {
  const f = await fixture(t), token = await detailsCapability(f);
  const args = { scope: 'global', enabled: true, confirmCosts: true };
  assert.equal((await f.request('/api/automation', { ...args, confirmCosts: false })).status, 400);
  assert.equal((await f.request('/api/automation', args, { origin: '' })).status, 403);
  assert.equal((await f.request('/api/automation', { ...args, collectionId: f.paper.collectionId })).status, 400);
  assert.equal((await f.request('/api/automation', { ...args, scope: 'anything' })).status, 400);
  const enabled = await f.request('/api/automation', args, { origin: '', 'x-dpr-ui-csrf': token });
  assert.equal(enabled.status, 200); assert.equal(enabled.value.globalEnabled, true);
  assert.ok(enabled.value.enabledTopics.includes('parent/child'));
  const disabled = await f.request('/api/automation', { scope: 'global', enabled: false });
  assert.equal(disabled.status, 200); assert.equal(disabled.value.globalEnabled, false);
  assert.equal(f.calls(), 0);
});
