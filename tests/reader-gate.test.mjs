import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';

const module = await import('../dist/reader-gate.js').catch(() => ({}));
const { createReaderGate } = module;
const busy = { code: 'reader-busy', status: 409 };
const invalid = { code: 'invalid', status: 400 };
const auth = { code: 'reader-auth', status: 403 };
const closed = { code: 'closed', status: 503 };
const paper = () => randomUUID();
const operation = () => ({ operationId: randomUUID(), type: 'rename' });
function fixture(t, options) { const gate = createReaderGate(options); t.after(() => gate.close()); return gate; }
const beat = (gate, client, extra = {}) => gate.heartbeat({ clientId: client.clientId, token: client.token, ...extra });
const acknowledge = (gate, client, command, ok = true, extra = {}) => gate.ack({ clientId: client.clientId,
    token: client.token, operationId: command.operationId, nonce: command.nonce, ok, ...extra });
function observe(promise) {
    const state = { status: 'pending' };
    promise.then(value => { state.status = 'fulfilled'; state.value = value; }, error => { state.status = 'rejected'; state.error = error; });
    return state;
}

test('exports reader gate factory', () => assert.equal(typeof createReaderGate, 'function'));

test('no live readers admits a lease immediately and blocks writes until idempotent release', async t => {
    const gate = fixture(t), id = paper();
    const lease = await gate.prepare({ paperIds: [id], operation: operation() });
    assert.throws(() => gate.assertWritable(id), busy);
    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.equal(lease.dispose(), false);
    assert.doesNotThrow(() => gate.assertWritable(id));
});

test('all affected readers must ACK actual save regardless of dirty heartbeat; others are ignored', async t => {
    const gate = fixture(t), id = paper(), other = paper(), op = operation();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id }), ignored = gate.register({ paperId: other });
    beat(gate, a, { dirty: false }); beat(gate, b, { dirty: true });
    const pending = gate.prepare({ paperIds: [id], operation: op }), state = observe(pending);
    assert.doesNotThrow(() => gate.assertWritable(id)); // Save/flush must run during waiting.
    const ca = beat(gate, a).command, cb = beat(gate, b).command;
    assert.deepEqual(Object.keys(ca).sort(), ['nonce', 'operationId', 'type']);
    assert.equal(ca.type, 'prepare'); assert.equal(ca.operationId, op.operationId);
    assert.notEqual(ca.nonce, cb.nonce);
    assert.equal(beat(gate, ignored).command, undefined);
    acknowledge(gate, a, ca);
    await nextTurn(); assert.equal(state.status, 'pending');
    assert.doesNotThrow(() => gate.assertWritable(id));
    acknowledge(gate, b, cb);
    assert.throws(() => gate.assertWritable(id), busy); // State is held before promise continuation.
    const lease = await pending;
    const result = { entities: [{ paperId: id, name: 'renamed' }] };
    lease.release(result); result.entities[0].name = 'mutated';
    const resume = beat(gate, a).command;
    assert.equal(resume.type, 'resume'); assert.equal(resume.operationId, op.operationId);
    assert.equal(resume.result.entities[0].name, 'renamed');
    resume.result.entities[0].name = 'external change';
    assert.equal(beat(gate, a).command.result.entities[0].name, 'renamed');
    assert.equal(beat(gate, b).command.type, 'resume');
});

test('random tokens/nonces and detached diagnostic/heartbeat snapshots expose no credentials', async t => {
    const gate = fixture(t), id = paper();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id });
    assert.match(a.clientId, /^[a-f0-9-]{36}$/); assert.match(a.token, /^[a-f0-9]{64}$/);
    assert.notEqual(a.token, b.token);
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    const ca = beat(gate, a).command;
    assert.match(ca.nonce, /^[a-f0-9]{64}$/);
    const before = JSON.stringify(gate.snapshot());
    for (const secret of [a.token, b.token, ca.nonce]) assert.ok(!before.includes(secret));
    assert.ok(!before.includes('"token"')); assert.ok(!before.includes('"nonce"'));
    const view = gate.snapshot(); view.clients.length = 0; view.operations.length = 0;
    assert.equal(gate.snapshot().clients.length, 2);
    ca.nonce = 'f'.repeat(64);
    assert.notEqual(beat(gate, a).command.nonce, ca.nonce);
    gate.close(); await assert.rejects(waiting, busy);
});

test('forged/wrong credentials and nonce never satisfy a pending prepare', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }), state = observe(waiting);
    const command = beat(gate, a).command;
    assert.throws(() => beat(gate, { ...a, token: 'f'.repeat(64) }), auth);
    assert.throws(() => acknowledge(gate, { ...a, token: 'f'.repeat(64) }, command), auth);
    assert.throws(() => acknowledge(gate, a, { ...command, nonce: 'f'.repeat(64) }), auth);
    assert.throws(() => acknowledge(gate, a, { ...command, operationId: randomUUID() }), busy);
    await nextTurn(); assert.equal(state.status, 'pending');
    acknowledge(gate, a, command);
    (await waiting).release();
});

test('same-paper prepare and new registrations conflict; disjoint papers proceed independently', async t => {
    const gate = fixture(t), one = paper(), two = paper(), a = gate.register({ paperId: one });
    const waiting = gate.prepare({ paperIds: [one], operation: operation() }); observe(waiting);
    await assert.rejects(gate.prepare({ paperIds: [one, two], operation: operation() }), busy);
    assert.throws(() => gate.register({ paperId: one }), busy);
    const independent = await gate.prepare({ paperIds: [two], operation: operation() });
    assert.throws(() => gate.register({ paperId: two }), busy);
    assert.doesNotThrow(() => gate.assertWritable(one)); assert.throws(() => gate.assertWritable(two), busy);
    acknowledge(gate, a, beat(gate, a).command); const lease = await waiting;
    assert.throws(() => gate.register({ paperId: one }), busy);
    independent.release(); lease.release();
    assert.ok(gate.register({ paperId: one }).token);
});

test('one failed save refuses operation and resumes every affected reader including non-ACKed ones', async t => {
    const gate = fixture(t), id = paper();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    const ca = beat(gate, a).command, cb = beat(gate, b).command;
    acknowledge(gate, a, ca);
    acknowledge(gate, b, cb, false, { error: 'disk secret detail must not appear in diagnostics' });
    await assert.rejects(waiting, busy);
    for (const c of [a, b]) assert.equal(beat(gate, c).command.type, 'resume');
    assert.ok(!JSON.stringify(gate.snapshot()).includes('disk secret'));
    assert.doesNotThrow(() => gate.assertWritable(id));
    const resume = beat(gate, a).command;
    assert.deepEqual(acknowledge(gate, a, ca), { accepted: true });
    assert.deepEqual(beat(gate, a).command, resume);
});

test('real timeout releases pending papers and resumes ACKed and pending clients', async t => {
    const gate = fixture(t, { timeoutMs: 20 }), id = paper();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    const ca = beat(gate, a).command;
    acknowledge(gate, a, ca);
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, a).command.type, 'resume'); assert.equal(beat(gate, b).command.type, 'resume');
    const resume = beat(gate, a).command;
    assert.deepEqual(acknowledge(gate, a, ca), { accepted: true });
    assert.deepEqual(beat(gate, a).command, resume);
    assert.doesNotThrow(() => gate.assertWritable(id));
});

test('abort during waiting and preaborted signals fail closed; post-admission abort cannot unlock moving FS', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id }), controller = new AbortController();
    const waiting = gate.prepare({ paperIds: [id], operation: operation(), signal: controller.signal }); observe(waiting);
    controller.abort(new Error('private reason'));
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, a).command.type, 'resume');
    acknowledge(gate, a, beat(gate, a).command);
    await assert.rejects(gate.prepare({ paperIds: [id], operation: operation(), signal: controller.signal }), busy);
    const next = new AbortController(), admitted = gate.prepare({ paperIds: [id], operation: operation(), signal: next.signal });
    acknowledge(gate, a, beat(gate, a).command); const lease = await admitted;
    next.abort(); assert.throws(() => gate.assertWritable(id), busy);
    lease.release(); assert.doesNotThrow(() => gate.assertWritable(id));
});

test('an ACK at the timeout deadline is rejected even before the event-loop timer runs', async t => {
    let clock = 0;
    const gate = fixture(t, { now: () => clock, timeoutMs: 10, ttlMs: 1000 }), id = paper();
    const a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: 'op-rename-1' }); observe(waiting);
    const command = beat(gate, a).command;
    clock = 10;
    assert.throws(() => acknowledge(gate, a, command), auth); // Expired prepare nonce cannot consume its replacement resume.
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, a).command.type, 'resume');
    assert.doesNotThrow(() => gate.assertWritable(id));
});

test('operation strings and bounded receipt identifiers are accepted without UUID coercion', async t => {
    const gate = fixture(t);
    const lease = await gate.prepare({ paperIds: [paper()], operation: 'op-rename-1' }); lease.release();
    const lease2 = await gate.prepare({ paperIds: [paper()], operation: { operationId: 'model:rename.2', type: 'rename-paper' } }); lease2.dispose();
    for (const operationId of ['', '../escape', 'x'.repeat(129), 'control\n'])
        await assert.rejects(gate.prepare({ paperIds: [paper()], operation: operationId }), invalid);
});

test('FIFO retains canonical resume until explicit ACK before exposing the next prepare', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const first = gate.prepare({ paperIds: [id], operation: 'rename-A' });
    const prepareA = beat(gate, a).command; acknowledge(gate, a, prepareA);
    (await first).release({ name: 'canonical-A' });
    const second = gate.prepare({ paperIds: [id], operation: 'rename-B' }), state = observe(second);
    const resumeA = beat(gate, a).command;
    assert.equal(resumeA.type, 'resume'); assert.equal(resumeA.operationId, 'rename-A');
    assert.equal(resumeA.result.name, 'canonical-A'); assert.match(resumeA.nonce, /^[a-f0-9]{64}$/);
    assert.notEqual(resumeA.nonce, prepareA.nonce);
    assert.deepEqual(beat(gate, a).command, resumeA); // Poll response loss preserves delivery.
    acknowledge(gate, a, prepareA); // Retried prepare ACK must not consume the resume.
    assert.deepEqual(beat(gate, a).command, resumeA);
    assert.throws(() => acknowledge(gate, a, { ...resumeA, nonce: 'f'.repeat(64) }), auth);
    acknowledge(gate, a, resumeA);
    const prepareB = beat(gate, a).command;
    assert.equal(prepareB.type, 'prepare'); assert.equal(prepareB.operationId, 'rename-B');
    acknowledge(gate, a, resumeA); // Retried resume ACK must not consume the next prepare.
    assert.deepEqual(beat(gate, a).command, prepareB);
    await nextTurn(); assert.equal(state.status, 'pending');
    acknowledge(gate, a, prepareB); (await second).release({ name: 'canonical-B' });
    const resumeB = beat(gate, a).command; assert.equal(resumeB.result.name, 'canonical-B');
    acknowledge(gate, a, resumeB); assert.deepEqual(beat(gate, a), {});
});

test('timeout of a prepare behind an old resume preserves that resume and does not queue undelivered cleanup', async t => {
    let clock = 0;
    const gate = fixture(t, { now: () => clock, timeoutMs: 10, ttlMs: 1000 }), id = paper();
    const a = gate.register({ paperId: id });
    const first = gate.prepare({ paperIds: [id], operation: 'rename-A' });
    acknowledge(gate, a, beat(gate, a).command); (await first).release({ name: 'canonical-A' });
    const originalResume = beat(gate, a).command;
    const waiting = gate.prepare({ paperIds: [id], operation: 'rename-B' }); observe(waiting);
    clock = 10; gate.snapshot(); await assert.rejects(waiting, busy);
    assert.deepEqual(beat(gate, a).command, originalResume);
    acknowledge(gate, a, originalResume); assert.deepEqual(beat(gate, a), {});
    assert.doesNotThrow(() => gate.assertWritable(id));
});

test('release boundary results remain deliverable after command wrapping', async t => {
    let nested = 'leaf';
    for (let i = 0; i < 8; i++) nested = { child: nested };
    for (const result of ['x'.repeat(60 * 1024), nested]) {
        const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
        const waiting = gate.prepare({ paperIds: [id], operation: operation() });
        acknowledge(gate, a, beat(gate, a).command); const lease = await waiting;
        assert.equal(lease.release(result), true);
        assert.deepEqual(beat(gate, a).command.result, result);
        assert.deepEqual(beat(gate, a).command.result, result);
    }
});

test('oversized raw or JSON-escaped resume results fail at release and still deliver cleanup', async t => {
    for (const result of ['x'.repeat(60 * 1024 + 1), '"'.repeat(40 * 1024)]) {
        const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
        const waiting = gate.prepare({ paperIds: [id], operation: operation() });
        acknowledge(gate, a, beat(gate, a).command); const lease = await waiting;
        assert.throws(() => lease.release(result), invalid);
        assert.doesNotThrow(() => gate.assertWritable(id));
        const resume = beat(gate, a).command;
        assert.equal(resume.type, 'resume'); assert.equal(Object.hasOwn(resume, 'result'), false);
        acknowledge(gate, a, resume); assert.deepEqual(beat(gate, a), {});
    }
});

test('invalid cyclic release results still unfreeze every client and release the filesystem lease', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() });
    acknowledge(gate, a, beat(gate, a).command); const lease = await waiting;
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => lease.release(cycle), invalid);
    assert.equal(lease.release(), false);
    assert.doesNotThrow(() => gate.assertWritable(id));
    assert.equal(beat(gate, a).command.type, 'resume');
});

test('old ACK/release cannot affect a new prepare even when operationId is reused', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id }), op = operation();
    const first = gate.prepare({ paperIds: [id], operation: op });
    const old = beat(gate, a).command; acknowledge(gate, a, old);
    const oldLease = await first; oldLease.release();
    acknowledge(gate, a, beat(gate, a).command);
    const second = gate.prepare({ paperIds: [id], operation: op }), state = observe(second);
    const fresh = beat(gate, a).command;
    assert.notEqual(old.nonce, fresh.nonce);
    assert.deepEqual(acknowledge(gate, a, old), { accepted: true });
    assert.equal(oldLease.release(), false);
    await nextTurn(); assert.equal(state.status, 'pending');
    acknowledge(gate, a, fresh); (await second).release();
});

test('unregister while waiting fails that operation, but prepared unregister keeps FS lease held', async t => {
    const gate = fixture(t), id = paper();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    acknowledge(gate, a, beat(gate, a).command);
    assert.equal(gate.unregister(a), true);
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, b).command.type, 'resume');
    acknowledge(gate, b, beat(gate, b).command);
    assert.throws(() => beat(gate, a), auth);
    const prepared = gate.prepare({ paperIds: [id], operation: operation() });
    acknowledge(gate, b, beat(gate, b).command); const lease = await prepared;
    gate.unregister(b); assert.throws(() => gate.assertWritable(id), busy);
    lease.release(); assert.doesNotThrow(() => gate.assertWritable(id));
});

test('TTL expiry removes authentication and cancels waiting rather than counting disappearance as ACK', async t => {
    let clock = 1000;
    const gate = fixture(t, { now: () => clock, ttlMs: 50 }), id = paper();
    const a = gate.register({ paperId: id }), b = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    clock += 30; beat(gate, b); clock += 20;
    assert.throws(() => beat(gate, a), auth);
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, b).command.type, 'resume');
    assert.equal(gate.snapshot().clients.length, 1);
    acknowledge(gate, b, beat(gate, b).command);
    const allowed = gate.prepare({ paperIds: [id], operation: operation() });
    acknowledge(gate, b, beat(gate, b).command); const lease = await allowed;
    clock += 60; gate.snapshot();
    assert.throws(() => gate.assertWritable(id), busy);
    lease.release();
});

test('expired unassociated readers are inactive; a reused clientId gets a new unforgeable token', async t => {
    let clock = 0;
    const gate = fixture(t, { now: () => clock, ttlMs: 10 }), id = paper(), clientId = randomUUID();
    const old = gate.register({ paperId: id, clientId });
    clock = 10;
    const lease = await gate.prepare({ paperIds: [id], operation: operation() }); lease.release();
    const fresh = gate.register({ paperId: id, clientId });
    assert.notEqual(old.token, fresh.token); assert.throws(() => beat(gate, old), auth);
    assert.deepEqual(beat(gate, fresh), {});
});

test('close settles waiters, restores commands, blocks future admission and keeps release idempotent', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() }); observe(waiting);
    assert.equal(gate.close(), true); assert.equal(gate.close(), false);
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, a).command.type, 'resume');
    const resume = beat(gate, a).command;
    acknowledge(gate, a, resume); acknowledge(gate, a, resume);
    assert.deepEqual(beat(gate, a), {});
    assert.throws(() => gate.register({ paperId: paper() }), closed);
    assert.throws(() => gate.assertWritable(id), closed);
    await assert.rejects(gate.prepare({ paperIds: [id], operation: operation() }), closed);
    assert.equal(gate.snapshot().closed, true);
    const other = createReaderGate(); t.after(() => other.close());
    const held = await other.prepare({ paperIds: [paper()], operation: operation() });
    other.close(); assert.equal(held.release(), false);
});

test('strict request validation does not execute accessors or accept caller-selected secrets', async t => {
    const gate = fixture(t), id = paper();
    const accessor = { paperId: id }; Object.defineProperty(accessor, 'clientId', { enumerable: true, get() { throw Error('never execute'); } });
    for (const req of [{ paperId: '../escape' }, { paperId: id, token: 'caller-chosen' }, accessor,
        { paperId: id, [Symbol('hidden')]: true }]) assert.throws(() => gate.register(req), invalid);
    const a = gate.register({ paperId: id });
    assert.throws(() => gate.register({ paperId: id, clientId: a.clientId }), busy);
    assert.throws(() => beat(gate, a, { dirty: 'false' }), invalid);
    await assert.rejects(gate.prepare({ paperIds: [], operation: operation() }), invalid);
    await assert.rejects(gate.prepare({ paperIds: [id], operation: { operationId: randomUUID(), token: 'injected' } }), invalid);
    await assert.rejects(gate.prepare({ paperIds: [id], operation: operation(), signal: {} }), invalid);
});

test('prepare snapshots paperIds and operation before caller mutation', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const paperIds = [id], op = operation(), operationId = op.operationId;
    const waiting = gate.prepare({ paperIds, operation: op });
    paperIds[0] = paper(); op.operationId = randomUUID();
    const command = beat(gate, a).command;
    assert.equal(command.operationId, operationId);
    acknowledge(gate, a, command); const lease = await waiting;
    assert.throws(() => gate.assertWritable(id), busy); lease.release();
});

test('multi-paper handshake commits admission atomically and rejects cross-client nonce/token reuse', async t => {
    const gate = fixture(t), one = paper(), two = paper();
    const a = gate.register({ paperId: one }), b = gate.register({ paperId: two });
    const waiting = gate.prepare({ paperIds: [one, two, one.toUpperCase()], operation: operation() });
    const ca = beat(gate, a).command, cb = beat(gate, b).command;
    assert.throws(() => acknowledge(gate, { ...b, token: a.token }, cb), auth);
    assert.throws(() => acknowledge(gate, b, { ...cb, nonce: ca.nonce }), auth);
    acknowledge(gate, a, ca);
    assert.doesNotThrow(() => gate.assertWritable(one)); assert.doesNotThrow(() => gate.assertWritable(two));
    acknowledge(gate, b, cb);
    assert.throws(() => gate.assertWritable(one), busy); assert.throws(() => gate.assertWritable(two), busy);
    const lease = await waiting;
    assert.equal(gate.snapshot().operations[0].paperIds.length, 2);
    assert.deepEqual(acknowledge(gate, a, ca), { accepted: true }); // Idempotent network retry.
    assert.throws(() => acknowledge(gate, a, ca, false), busy);
    assert.throws(() => gate.assertWritable(one), busy);
    lease.dispose();
    assert.doesNotThrow(() => gate.assertWritable(one)); assert.doesNotThrow(() => gate.assertWritable(two));
});

test('real TTL timer fails waiting preparation without a heartbeat or diagnostic sweep', async t => {
    const gate = fixture(t, { ttlMs: 20, timeoutMs: 1000 }), id = paper();
    const a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() });
    await assert.rejects(waiting, busy);
    assert.equal(gate.snapshot().clients.length, 0);
    assert.throws(() => beat(gate, a), auth);
    assert.doesNotThrow(() => gate.assertWritable(id));
});

test('delayed consumption of failed prepare has no internal unhandled rejection', async t => {
    const gate = fixture(t), id = paper(), a = gate.register({ paperId: id });
    const waiting = gate.prepare({ paperIds: [id], operation: operation() });
    gate.close();
    await nextTurn(); await nextTurn();
    await assert.rejects(waiting, busy);
    assert.equal(beat(gate, a).command.type, 'resume');
});
