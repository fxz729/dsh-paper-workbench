// Pure in-memory reader save/freeze handshake. The Host authenticates same-origin callers
// and readers ACK only after their real ink snapshot + flush + local freeze completed.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET = /^[a-f0-9]{64}$/;
const MAX_CLIENTS = 1024, MAX_PAPERS = 512;
const MAX_RESULT_BYTES = 60 * 1024, MAX_COMMAND_BYTES = 64 * 1024;
const own = (v, k) => Object.hasOwn(v, k);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v)
    && [Object.prototype, null].includes(Object.getPrototypeOf(v));
export class ReaderGateError extends Error {
    constructor(code) {
        super({ invalid: '阅读器同步请求无效', 'reader-auth': '阅读器凭证无效或已过期',
            'reader-busy': '阅读器尚未完成保存与冻结，请稍后重试', closed: '阅读器同步服务已关闭' }[code]);
        this.name = 'ReaderGateError'; this.code = code;
        this.status = { invalid: 400, 'reader-auth': 403, 'reader-busy': 409, closed: 503 }[code];
    }
}
const fail = (code = 'invalid') => { throw new ReaderGateError(code); };
function record(v, allowed, required = []) {
    if (!plain(v) || Object.getOwnPropertySymbols(v).length) fail();
    const descriptors = Object.getOwnPropertyDescriptors(v), result = Object.create(null);
    if (Object.keys(descriptors).some(k => !allowed.includes(k)) || required.some(k => !own(descriptors, k))) fail();
    for (const [key, d] of Object.entries(descriptors)) {
        if (!d.enumerable || !own(d, 'value')) fail();
        result[key] = d.value;
    }
    return result;
}
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail(); return value.toLowerCase(); }
function identifier(value) { if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(); return value; }
function boundedText(value, max) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail();
}
function operation(value) {
    if (typeof value === 'string') return { operationId: identifier(value) };
    const r = record(value, ['operationId', 'type'], ['operationId']);
    r.operationId = identifier(r.operationId);
    if (own(r, 'type')) boundedText(r.type, 64);
    return r;
}
// Resume result is trusted local canonical data, still bounded and detached. Never serialize
// arbitrary accessors/toJSON, signal objects, cycles or caller-controlled prototypes.
function copy(value, seen = new Set(), depth = 0, budget = { nodes: 0, bytes: 0 }) {
    if (++budget.nodes > 2048 || depth > 8) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        if (value.length > MAX_RESULT_BYTES || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail();
        budget.bytes += Buffer.byteLength(value);
        if (budget.bytes > MAX_RESULT_BYTES) fail();
        return value;
    }
    const array = Array.isArray(value);
    if ((!array && !plain(value)) || seen.has(value) || Object.getOwnPropertySymbols(value).length) fail();
    if (array && Object.getPrototypeOf(value) !== Array.prototype) fail();
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = array ? [] : {};
    if (Object.keys(descriptors).length > 1025) fail();
    if (array && (value.length > 1024 || Object.keys(descriptors).length !== value.length + 1)) fail();
    for (const [key, d] of Object.entries(descriptors)) {
        if (array && key === 'length') continue;
        if (!d.enumerable || !own(d, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) fail();
        budget.bytes += Buffer.byteLength(key);
        if (key.length > 256 || budget.bytes > MAX_RESULT_BYTES) fail();
        result[key] = copy(d.value, seen, depth + 1, budget);
    }
    seen.delete(value);
    return result;
}
function guardedPromise(executor) {
    const promise = new Promise(executor);
    // Mark the original as handled without changing what awaiting callers receive.
    promise.catch(() => {});
    return promise;
}

/**
 * Waiting allows ink writes needed by the commanded flush. After every participant's
 * authenticated ACK, admission synchronously becomes prepared and assertWritable refuses
 * writes until explicit release. New registrations for any reserved paper are refused.
 * Expiry/unregister during waiting aborts, never substitutes for a successful ACK.
 * Expiry/unregister after admission never releases the owner's filesystem lease.
 */
export function createReaderGate(options = {}) {
    const config = record(options, ['now', 'timeoutMs', 'ttlMs']);
    const now = config.now ?? Date.now, timeoutMs = config.timeoutMs ?? 10000, ttlMs = config.ttlMs ?? 60000;
    if (typeof now !== 'function' || ![timeoutMs, ttlMs].every(v => Number.isInteger(v) && v > 0 && v <= 2147483647)) fail();
    const clients = new Map(), operations = new Map(), papers = new Map();
    let closed = false, lastNow = 0;
    function clock() {
        let value;
        try { value = now(); } catch { fail(); }
        if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - ttlMs) fail();
        lastNow = Math.max(lastNow, value);
        return lastNow;
    }
    function ensureOpen() { if (closed) fail('closed'); }
    function stopWaiting(op) {
        clearTimeout(op.timer);
        if (op.signal) op.signal.removeEventListener('abort', op.onAbort);
        op.signal = undefined; op.onAbort = undefined;
    }
    function finish(op, result) {
        if (op.state === 'released') return false;
        const wasWaiting = op.state === 'waiting';
        op.state = 'released'; stopWaiting(op);
        operations.delete(op.operationId);
        for (const id of op.paperIds) if (papers.get(id) === op) papers.delete(id);
        for (const [id] of op.participants) {
            const c = clients.get(id);
            // A clientId can be reused after expiry; never send the old command to its successor.
            if (!c || c.operation !== op) continue;
            c.operation = null;
            const preparation = c.commands.find(entry => entry.operation === op);
            c.commands = c.commands.filter(entry => entry.operation !== op);
            // Never overwrite an earlier undelivered resume. If this prepare was still
            // behind it, it could not have frozen the reader and needs no extra resume.
            if (preparation?.delivered || !c.commands.length) c.commands.push({
                operation: null, delivered: false,
                message: { type: 'resume', operationId: op.operationId, nonce: randomBytes(32).toString('hex'),
                    ...(result === undefined ? {} : { result }) },
            });
        }
        if (wasWaiting) op.reject(new ReaderGateError('reader-busy'));
        return true;
    }
    function expireClient(client) {
        clearTimeout(client.timer);
        clients.delete(client.clientId);
        if (client.operation?.state === 'waiting') finish(client.operation);
    }
    function sweep() {
        const time = clock();
        for (const c of clients.values()) if (time >= c.expiresAt) expireClient(c);
        // Reject late ACKs synchronously even if an event-loop delay postponed the timer.
        for (const op of operations.values()) if (op.state === 'waiting' && time >= op.deadline) finish(op);
    }
    function schedule(client) {
        clearTimeout(client.timer);
        if (closed) return;
        client.timer = setTimeout(() => {
            try { sweep(); if (clients.get(client.clientId) === client) schedule(client); }
            catch { close(); }
        }, Math.max(1, client.expiresAt - clock()));
        client.timer.unref?.();
    }
    function touch(client) { client.expiresAt = clock() + ttlMs; schedule(client); }
    function authenticate(request) {
        sweep();
        const id = uuid(request.clientId), client = clients.get(id);
        if (!client || typeof request.token !== 'string' || !SECRET.test(request.token)
            || !timingSafeEqual(Buffer.from(request.token, 'hex'), Buffer.from(client.token, 'hex'))) fail('reader-auth');
        return client;
    }
    // Internal commands contain only generated primitives and an already bounded result.
    // Clone without reapplying the result-only budget to its additional command wrapper.
    function response(client) {
        const entry = client.commands[0];
        if (!entry) return {};
        entry.delivered = true;
        return { command: structuredClone(entry.message) };
    }
    function admit(op) {
        if (op.state !== 'waiting') return;
        op.state = 'prepared'; stopWaiting(op);
        const lease = Object.freeze({
            release(result) {
                if (op.state === 'released') return false;
                let detached;
                try {
                    if (result !== undefined) {
                        detached = copy(result); // Result depth <=8; final command depth <=9 (<12).
                        // Validate the exact final command size, including JSON escaping and
                        // fixed-size nonce. The actual generated nonce has the same byte length.
                        const command = { type: 'resume', operationId: op.operationId, nonce: '0'.repeat(64), result: detached };
                        if (Buffer.byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) fail();
                    }
                } catch (e) { finish(op); throw e; }
                return finish(op, detached);
            },
            dispose() { return finish(op); },
        });
        op.resolve(lease);
    }
    function register(input) {
        ensureOpen();
        const r = record(input, ['paperId', 'clientId'], ['paperId']), paperId = uuid(r.paperId);
        const clientId = own(r, 'clientId') ? uuid(r.clientId) : randomUUID();
        sweep();
        if (papers.has(paperId) || clients.has(clientId) || clients.size >= MAX_CLIENTS) fail('reader-busy');
        const client = { clientId, paperId, token: randomBytes(32).toString('hex'), dirty: false,
            expiresAt: 0, commands: [], lastAcks: { prepare: null, resume: null }, operation: null, timer: undefined };
        clients.set(clientId, client); touch(client);
        return { clientId, token: client.token };
    }
    function heartbeat(input) {
        const r = record(input, ['clientId', 'token', 'dirty'], ['clientId', 'token']);
        if (own(r, 'dirty') && typeof r.dirty !== 'boolean') fail();
        const client = authenticate(r);
        // After close, existing credentials can drain a final resume until their old TTL;
        // no new liveness extension or timers are installed.
        if (!closed) touch(client);
        if (own(r, 'dirty')) client.dirty = r.dirty;
        return response(client);
    }
    function ack(input) {
        const r = record(input, ['clientId', 'token', 'operationId', 'nonce', 'ok', 'error'],
            ['clientId', 'token', 'operationId', 'nonce', 'ok']);
        if (typeof r.ok !== 'boolean') fail();
        if (own(r, 'error')) boundedText(r.error, 1024); // Not stored, logged or reflected.
        identifier(r.operationId);
        const client = authenticate(r), op = client.operation;
        if (typeof r.nonce !== 'string' || !SECRET.test(r.nonce)) fail('reader-auth');
        const matchingNonce = value => timingSafeEqual(Buffer.from(r.nonce, 'hex'), Buffer.from(value, 'hex'));
        // One bounded receipt per command type makes network retries idempotent without
        // consuming a later command, including a resume after a successful prepare ACK.
        for (const receipt of Object.values(client.lastAcks)) {
            if (receipt?.operationId !== r.operationId || !matchingNonce(receipt.nonce)) continue;
            if (receipt.ok !== r.ok) fail('reader-busy');
            if (!closed) touch(client);
            return { accepted: true };
        }
        const entry = client.commands[0], message = entry?.message;
        if (!message || message.operationId !== r.operationId) fail('reader-busy');
        if (!matchingNonce(message.nonce)) fail('reader-auth');
        if (message.type === 'resume') {
            if (!closed) touch(client);
            if (!r.ok) { if (op?.state === 'waiting') finish(op); return { accepted: true }; }
            client.lastAcks.resume = { operationId: r.operationId, nonce: r.nonce, ok: true };
            client.commands.shift();
            return { accepted: true };
        }
        ensureOpen();
        if (!op || entry.operation !== op || op.state !== 'waiting') fail('reader-busy');
        touch(client); entry.delivered = true;
        client.lastAcks.prepare = { operationId: r.operationId, nonce: r.nonce, ok: r.ok };
        if (!r.ok) { finish(op); return { accepted: true }; }
        op.participants.get(client.clientId).acked = true;
        if ([...op.participants.values()].every(p => p.acked)) admit(op);
        return { accepted: true };
    }
    function unregister(input) {
        const r = record(input, ['clientId', 'token'], ['clientId', 'token']);
        const client = authenticate(r); expireClient(client); return true;
    }
    function prepare(input) {
        try {
            ensureOpen();
            const r = record(input, ['paperIds', 'operation', 'signal'], ['paperIds', 'operation']);
            const ids = copy(r.paperIds);
            if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PAPERS) fail();
            const paperIds = [...new Set(ids.map(uuid))], action = operation(r.operation), signal = r.signal;
            if (signal !== undefined && !(signal instanceof AbortSignal)) fail();
            if (signal?.aborted) fail('reader-busy');
            sweep();
            if (operations.has(action.operationId) || paperIds.some(id => papers.has(id))) fail('reader-busy');
            const op = { ...action, paperIds, state: 'waiting', participants: new Map(), signal, deadline: clock() + timeoutMs,
                onAbort: undefined, timer: undefined, resolve: undefined, reject: undefined };
            const promise = guardedPromise((resolve, reject) => { op.resolve = resolve; op.reject = reject; });
            operations.set(op.operationId, op);
            for (const id of paperIds) papers.set(id, op);
            for (const client of clients.values()) {
                if (!paperIds.includes(client.paperId)) continue;
                const nonce = randomBytes(32).toString('hex');
                op.participants.set(client.clientId, { nonce, acked: false });
                client.operation = op;
                client.commands.push({ operation: op, delivered: false, message: { type: 'prepare', operationId: op.operationId, nonce } });
            }
            op.onAbort = () => finish(op);
            signal?.addEventListener('abort', op.onAbort, { once: true });
            op.timer = setTimeout(() => finish(op), timeoutMs);
            if (!op.participants.size) admit(op);
            return promise;
        } catch (e) {
            const error = e instanceof ReaderGateError ? e : new ReaderGateError('invalid');
            return guardedPromise((resolve, reject) => reject(error));
        }
    }
    function assertWritable(paperId) {
        ensureOpen();
        const id = uuid(paperId); sweep();
        if (papers.get(id)?.state === 'prepared') fail('reader-busy');
        return true;
    }
    function snapshot() {
        sweep();
        return {
            closed,
            clients: [...clients.values()].map(c => ({ clientId: c.clientId, paperId: c.paperId,
                dirty: c.dirty, expiresAt: c.expiresAt, state: c.operation?.state ?? 'active',
                command: c.commands[0]?.message.type ?? null, queuedCommands: c.commands.length })),
            operations: [...operations.values()].map(op => ({ operationId: op.operationId,
                ...(op.type === undefined ? {} : { type: op.type }), paperIds: [...op.paperIds], state: op.state,
                participants: op.participants.size, acknowledged: [...op.participants.values()].filter(p => p.acked).length })),
        };
    }
    function close() {
        if (closed) return false;
        closed = true;
        for (const op of [...operations.values()]) finish(op);
        for (const c of clients.values()) clearTimeout(c.timer);
        return true;
    }
    return Object.freeze({ register, heartbeat, ack, unregister, prepare, assertWritable, snapshot, close });
}
