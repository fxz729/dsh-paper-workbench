import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createReaderGate } from '../dist/reader-gate.js';
const path = new URL('../reader/reader-sync.js', import.meta.url);
const scope = { URLSearchParams, AbortController, setTimeout, clearTimeout };
if (fs.existsSync(path)) vm.runInNewContext(fs.readFileSync(path, 'utf8'), scope);
const api = scope.DprReaderSync || {};
const plain = value => JSON.parse(JSON.stringify(value));
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, overrides = {}) {
  assert.equal(typeof api.createReaderSync, 'function');
  let clock = 0, canonical, saveCount = 0, resumeCount = 0, suspendCount = 0, rejoinCount = 0, locked = false, mutationLocked = false, scheduled;
  const id = randomUUID(), collectionId = randomUUID(), requests = [], errors = [], applied = [];
  canonical = { paperId: id, collectionId, topic: 'T', name: 'A', locationRevision: 1, pdfPath: 'C:/PRIVATE/not-public.pdf' };
  const gate = createReaderGate({ now: () => clock, timeoutMs: 1000, ttlMs: 10000 });
  const ink = { async prepareMutation() { saveCount++; mutationLocked = true; locked = true; await overrides.save?.(); }, async resumeMutation() { resumeCount++; mutationLocked = false; locked = sync.blocked; }, suspendSync() { suspendCount++; locked = true; }, async rejoinSync() { rejoinCount++; await overrides.rejoin?.(); mutationLocked = false; }, resumeSync() { locked = mutationLocked || sync.blocked; } };
  const request = async (route, body, options) => {
    const input = body === undefined ? undefined : plain(body); requests.push({ route, body: input, options });
    if (overrides.request) { const handled = await overrides.request(route, input); if (handled !== undefined) return handled; }
    if (route === '/readers/register') return gate.register(input);
    if (route === '/readers/heartbeat') return gate.heartbeat(input);
    if (route === '/readers/ack') { const value = gate.ack(input); if (overrides.ackLost?.(input)) throw Error('ACK transport lost'); return value; }
    if (route === '/readers/unregister') return gate.unregister(input);
    if (route === '/paper?paperId=' + id) { if (overrides.metadataError?.()) throw Error('local metadata busy'); return canonical; }
    throw Error('unexpected route ' + route);
  };
  const sync = api.createReaderSync({ paperId: id, request, getInk: () => ink, applyCanonical: ref => { applied.push(plain(ref)); }, onError: e => errors.push(e), setTimer: fn => { scheduled = fn; return 1; }, clearTimer: () => { scheduled = null; } });
  t.after(async () => { await sync.stop(); gate.close(); });
  return { sync, gate, id, collectionId, ink, requests, errors, applied, canonical, clock: value => { clock = value; }, counts: () => ({ saveCount, resumeCount, suspendCount, rejoinCount, locked }), scheduled: () => scheduled };
}
test('reader sync exports explicit protocol helpers', () => {
  for (const key of ['createReaderSync', 'reference', 'canonicalRef', 'acceptDetailsMessage']) assert.equal(typeof api[key], 'function', key);
});
test('register and heartbeat use exact Gate shape, keep credentials private, and unregister once', async t => {
  const f = fixture(t); await f.sync.start(); await f.sync.tick();
  assert.deepEqual(f.requests[0].body, { paperId: f.id });
  assert.deepEqual(Object.keys(f.requests[1].body).sort(), ['clientId', 'token']);
  assert.equal(f.gate.snapshot().clients.length, 1); assert.ok(f.scheduled());
  assert.doesNotMatch(JSON.stringify(f.sync), /token|nonce/);
  await f.sync.stop(); await f.sync.stop(); assert.equal(f.requests.filter(r => r.route === '/readers/unregister').length, 1); assert.equal(f.gate.snapshot().clients.length, 0);
});
test('prepare ACK waits for actual flush; resume fetches ID canonical reference and releases editor before ACK', async t => {
  let release; const f = fixture(t, { save: () => new Promise(resolve => { release = resolve; }) });
  await f.sync.start(); const pending = f.gate.prepare({ paperIds: [f.id], operation: 'rename-1' });
  await f.sync.tick(); await turn(); assert.equal(f.counts().locked, true); assert.equal(f.requests.filter(r => r.route === '/readers/ack').length, 0);
  release(); await f.sync.settle(); const lease = await pending;
  assert.throws(() => f.gate.assertWritable(f.id), { code: 'reader-busy' });
  f.canonical.name = 'Renamed'; f.canonical.locationRevision = 2; lease.release({ pdfPath: 'C:/PRIVATE/ignored.pdf' });
  await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().locked, false); assert.equal(f.counts().resumeCount, 1);
  assert.deepEqual(f.applied[0], { paperId: f.id, collectionId: f.collectionId, topic: 'T', name: 'Renamed', locationRevision: 2 });
  assert.equal(f.requests.at(-1).route, '/readers/ack'); assert.equal(f.requests.at(-1).body.ok, true);
  assert.equal(f.gate.snapshot().clients[0].command, null);
});
test('redelivery and lost ACK retry do not snapshot or flush again', async t => {
  let lost = true; const f = fixture(t, { ackLost: input => input.ok && lost ? (lost = false, true) : false });
  await f.sync.start(); const pending = f.gate.prepare({ paperIds: [f.id], operation: 'rename-retry' });
  await f.sync.tick(); await f.sync.settle(); const lease = await pending;
  await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().saveCount, 1);
  const acks = f.requests.filter(r => r.route === '/readers/ack'); assert.equal(acks.length, 2); assert.deepEqual(acks[0].body, acks[1].body);
  lease.release(); await f.sync.tick(); await f.sync.settle();
});
test('failed save rejects mutation with a bounded error then drains explicit resume', async t => {
  const f = fixture(t, { save: async () => { throw Error('private\ncredential must not be echoed'); } });
  await f.sync.start(); const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'fail-save' });
  await f.sync.tick(); await f.sync.settle(); await assert.rejects(waiting, { code: 'reader-busy' });
  const failed = f.requests.find(r => r.route === '/readers/ack'); assert.equal(failed.body.ok, false); assert.doesNotMatch(failed.body.error, /private|credential|\n/);
  await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().locked, false);
});
test('resume metadata failure keeps freeze and retries only local reconciliation', async t => {
  let fail = true; const f = fixture(t, { metadataError: () => fail }); await f.sync.start();
  const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'resume-busy' }); await f.sync.tick(); await f.sync.settle(); (await waiting).release();
  await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().locked, true); assert.equal(f.gate.snapshot().clients[0].command, 'resume');
  fail = false; await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().locked, false); assert.equal(f.counts().saveCount, 1);
});
test('heartbeat remains available during long save; timeout resume never unlocks a different operation', async t => {
  let release; const f = fixture(t, { save: () => new Promise(resolve => { release = resolve; }) }); await f.sync.start();
  const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'slow-save' }); waiting.catch(() => {});
  await f.sync.tick(); await turn(); await f.sync.tick(); assert.equal(f.requests.filter(r => r.route === '/readers/heartbeat').length, 2);
  f.clock(2000); await f.sync.tick(); await assert.rejects(waiting, { code: 'reader-busy' });
  assert.equal(f.counts().locked, true); release(); await f.sync.settle(); assert.equal(f.counts().locked, false);
});
test('forged commands and mismatched canonical ID never release a lease', async t => {
  const f = fixture(t, { request: route => route === '/readers/heartbeat' ? { command: { type: 'eval', operationId: 'x', nonce: 'f'.repeat(64) } } : undefined });
  await f.sync.start(); await f.sync.tick(); await f.sync.settle(); assert.equal(f.counts().saveCount, 0); assert.equal(f.requests.filter(r => r.route === '/readers/ack').length, 0);
  assert.throws(() => api.canonicalRef({ ...f.canonical, paperId: randomUUID() }, f.id));
});
test('expired credentials freeze actual ink and safely re-register as a visible Gate participant', async t => {
  const f = fixture(t); await f.sync.start(); f.clock(20000); await f.sync.tick();
  assert.ok(f.counts().suspendCount > 0); assert.ok(f.counts().rejoinCount > 0); assert.equal(f.sync.blocked, false); assert.equal(f.gate.snapshot().clients.length, 1);
  let admitted = false; const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'after-rejoin' }).then(lease => { admitted = true; return lease; });
  await turn(); assert.equal(admitted, false); await f.sync.tick(); await f.sync.settle(); (await waiting).release(); await f.sync.tick(); await f.sync.settle();
});
test('reserved filesystem lease prevents re-registration and keeps disconnected editor readonly', async t => {
  const f = fixture(t); await f.sync.start(); f.clock(20000);
  const lease = await f.gate.prepare({ paperIds: [f.id], operation: 'filesystem-still-owned' });
  await f.sync.tick(); assert.equal(f.sync.blocked, true); assert.equal(f.counts().locked, true); assert.equal(f.gate.snapshot().clients.length, 0);
  lease.release(); await f.sync.tick(); assert.equal(f.sync.blocked, false); assert.equal(f.counts().locked, false); assert.equal(f.gate.snapshot().clients.length, 1);
});
test('initial registration failure stays blocked and retries only local registration/canonical/rejoin', async t => {
  let fail = true; const f = fixture(t, { request: route => { if (fail && route === '/readers/register') throw Error('offline'); } });
  await assert.rejects(f.sync.start()); assert.equal(f.sync.blocked, true); assert.equal(f.counts().locked, true);
  fail = false; await f.sync.tick(); assert.equal(f.sync.blocked, false); assert.equal(f.counts().rejoinCount, 1); assert.equal(f.gate.snapshot().clients.length, 1);
});
test('rejoin requires canonical lookup and actual save completion before restoring editability', async t => {
  let releaseMetadata, releaseSave, shouldWait = false;
  const f = fixture(t, { request: route => shouldWait && route.startsWith('/paper?') ? new Promise(resolve => { releaseMetadata = resolve; }) : undefined, rejoin: () => new Promise(resolve => { releaseSave = resolve; }) });
  await f.sync.start(); shouldWait = true; f.clock(20000); const recovering = f.sync.tick(); await turn();
  assert.equal(f.sync.blocked, true); assert.equal(f.counts().locked, true); releaseMetadata(f.canonical); await turn();
  assert.equal(f.sync.blocked, true); assert.equal(f.counts().locked, true); releaseSave(); await recovering; assert.equal(f.sync.blocked, false); assert.equal(f.counts().locked, false);
});
test('rejoin save crossing successor TTL never unlocks an invisible expired reader', async t => {
  let release, wait = true; const f = fixture(t, { rejoin: () => wait ? new Promise(resolve => { release = resolve; }) : undefined });
  await f.sync.start(); f.clock(20000); const recovering = f.sync.tick(); await turn();
  assert.equal(f.sync.blocked, true); assert.equal(f.gate.snapshot().clients.length, 1); f.clock(40000); assert.equal(f.gate.snapshot().clients.length, 0);
  release(); await recovering; assert.equal(f.sync.blocked, true); assert.equal(f.counts().locked, true);
  wait = false; await f.sync.tick(); assert.equal(f.sync.blocked, false); assert.equal(f.gate.snapshot().clients.length, 1);
});
test('rejoin save renews heartbeat independently while the save promise remains pending', async t => {
  let release; const f = fixture(t, { rejoin: () => new Promise(resolve => { release = resolve; }) });
  await f.sync.start(); f.clock(20000); const recovering = f.sync.tick(); await turn();
  const before = f.requests.filter(r => r.route === '/readers/heartbeat').length;
  await f.scheduled()(); await turn();
  assert.ok(f.requests.filter(r => r.route === '/readers/heartbeat').length > before, 'renewal cannot await rejoin flush'); assert.equal(f.sync.blocked, true);
  release(); await recovering;
});
test('final rejoin liveness heartbeat feeds its command into the same epoch FIFO', async t => {
  let release; const f = fixture(t, { rejoin: () => new Promise(resolve => { release = resolve; }) });
  await f.sync.start(); f.clock(20000); const recovering = f.sync.tick(); await turn();
  const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'arrived-during-rejoin' }); waiting.catch(() => {});
  release(); await recovering; await f.sync.settle(); assert.equal(f.counts().saveCount, 1);
  const lease = await waiting; assert.throws(() => f.gate.assertWritable(f.id), { code: 'reader-busy' }); lease.release(); await f.sync.tick(); await f.sync.settle();
});
test('old epoch pending prepare cannot ACK with successor credentials', async t => {
  let release; const saved = new Promise(resolve => { release = resolve; }); const f = fixture(t, { save: () => saved, rejoin: () => saved });
  await f.sync.start(); const oldClient = f.gate.snapshot().clients[0].clientId;
  const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'old-epoch' }); waiting.catch(() => {}); await f.sync.tick(); await turn();
  f.clock(20000); const recovering = f.sync.tick(); await turn(); release(); await recovering; await f.sync.settle();
  assert.ok(f.gate.snapshot().clients[0].clientId !== oldClient);
  assert.equal(f.requests.filter(r => r.route === '/readers/ack' && r.body.operationId === 'old-epoch' && r.body.clientId !== oldClient).length, 0);
});
test('old epoch delayed canonical response cannot overwrite a completed rejoin', async t => {
  let releaseOld, reads = 0; const f = fixture(t, { request: route => { if (route.startsWith('/paper?') && ++reads === 1) return new Promise(resolve => { releaseOld = resolve; }); } });
  await f.sync.start(); const waiting = f.gate.prepare({ paperIds: [f.id], operation: 'old-canonical' }); await f.sync.tick(); await f.sync.settle(); (await waiting).release();
  await f.sync.tick(); await turn(); f.clock(20000); f.canonical.name = 'Fresh'; await f.sync.tick();
  releaseOld({ ...f.canonical, name: 'Stale' }); await f.sync.settle(); assert.equal(f.applied.at(-1).name, 'Fresh');
});
test('default HTTP transport has bounded abort so lost ACK cannot block queued resume forever', async () => {
  let timeout, requestOptions;
  const sandbox = { URLSearchParams, AbortController, setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {}, fetch: (url, options) => {
    requestOptions = options; return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  } };
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), sandbox);
  const client = sandbox.DprReaderSync.createReaderSync({ paperId: randomUUID(), getInk: () => null, applyCanonical() {} });
  const starting = client.start(); await turn(); assert.ok(requestOptions.signal, 'HTTP request needs a deadline signal'); assert.equal(typeof timeout, 'function'); timeout(); await assert.rejects(starting, { name: 'AbortError' }); await client.stop();
});
test('late register completion after stop is unregistered without starting another poll', async () => {
  assert.equal(typeof api.createReaderSync, 'function'); let resolve; const requests = [];
  const sync = api.createReaderSync({ paperId: randomUUID(), request: async (route, body) => { requests.push(route); if (route.endsWith('/register')) return new Promise(done => { resolve = done; }); return {}; }, getInk: () => null, applyCanonical() {}, setTimer: () => { throw Error('stopped poll'); }, clearTimer() {} });
  const starting = sync.start(); await sync.stop(); resolve({ clientId: randomUUID(), token: 'a'.repeat(64) }); await starting;
  assert.deepEqual(requests, ['/readers/register', '/readers/unregister']);
});
