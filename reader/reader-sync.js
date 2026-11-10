// Browser-only ReaderGate transport. Credentials remain in this closure, never storage/URLs.
(function (root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SECRET = /^[a-f0-9]{64}$/, OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const validId = value => typeof value === 'string' && UUID.test(value);
  function reference(ref) {
    if (ref?.paperId !== undefined) {
      if (!validId(ref.paperId)) throw Error('文献身份无效');
      return { paperId: ref.paperId };
    }
    if (!ref || ref.topic !== undefined && typeof ref.topic !== 'string' || typeof ref.name !== 'string' || !ref.name) throw Error('文献引用无效');
    return { ...(ref.topic === undefined ? {} : { topic: ref.topic }), name: ref.name };
  }
  function canonicalRef(value, expectedId) {
    if (!value || !validId(value.paperId) || value.paperId !== expectedId || !validId(value.collectionId)
      || typeof value.topic !== 'string' || typeof value.name !== 'string' || !value.name
      || !Number.isSafeInteger(value.locationRevision) || value.locationRevision < 0
      || [value.topic, value.name].some(s => /^[A-Za-z]:[\\/]|^[\\/]|[\x00-\x1f]/.test(s))) throw Error('规范文献身份不匹配');
    return { paperId: value.paperId, collectionId: value.collectionId, topic: value.topic, name: value.name, locationRevision: value.locationRevision };
  }
  function acceptDetailsMessage(event, expected) {
    return event?.origin === expected.origin && event.source === expected.source && event.data?.paperId === expected.paperId
      && ['dpr:paper-details-close', 'dpr:paper-details-updated'].includes(event.data?.type);
  }
  async function transport(path, body, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch('/paper-reader/api' + path, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', keepalive: options.keepalive === true, signal: controller.signal });
      const value = await response.json();
      if (!response.ok) throw Object.assign(Error('阅读器同步暂未完成，请保留当前页面后重试'), { status: response.status });
      return value;
    } finally { clearTimeout(timeout); }
  }
  function createReaderSync({ paperId, request = transport, getInk, applyCanonical, onError = () => {}, intervalMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    if (!validId(paperId) || typeof getInk !== 'function' || typeof applyCanonical !== 'function') throw Error('阅读器同步参数无效');
    let credentials = null, stopped = false, starting = null, polling = null, reconnecting = null, blocked = true, rejoinDraining = false, everRegistered = false, timer = null, work = Promise.resolve();
    const queued = new Set(), receipts = new Map();let problemReported=false;
    const report = () => {if(problemReported)return;problemReported=true;onError(Error('阅读器保存同步未完成，编辑保护保持；请保留页面并核对本地状态'));};
    const schedule = () => { if (!stopped) { if (timer !== null) clearTimer(timer); timer = setTimer(() => { timer = null; void tick(); }, intervalMs); } };
    const unregister = async () => {
      if (!credentials) return;
      const held = credentials; credentials = null;
      // Cleanup belongs to the discarded epoch. Expiry is normal after a hidden tab;
      // failure here must not announce a save failure after the new epoch recovered.
      try { await request('/readers/unregister', held, { keepalive: true }); } catch { /* Gate TTL retains stale participants until expiry. */ }
    };
    const suspend = () => {
      blocked = true;
      try { getInk()?.suspendSync?.(); } catch { report(); }
    };
    async function registerFresh() {
      const value = await request('/readers/register', { paperId });
      if (!validId(value?.clientId) || typeof value.token !== 'string' || !SECRET.test(value.token)) throw Error('阅读器注册返回无效');
      credentials = { clientId: value.clientId, token: value.token }; everRegistered = true;
      // Old HTTP continuations are epoch-guarded; a new FIFO must not await a lost old response.
      // The actual SDK save still completes through rejoinSync before editing is restored.
      work = Promise.resolve(); queued.clear(); receipts.clear();
      if (stopped) await unregister();
    }
    function validEpoch(held) { return !stopped && credentials === held && (!blocked || rejoinDraining); }
    async function settleCommands() { let tail; do { tail = work; await tail; } while (tail !== work); }
    function rejoin() {
      if (reconnecting) return reconnecting;
      suspend();
      reconnecting = (async () => {
        let renewalTimer = null, renewalFlight = null, renewalError = null;
        const pendingCommands = new Map();
        await unregister();
        if (stopped) return;
        try {
          await registerFresh();
          if (stopped) return;
          const held = credentials;
          const beat = () => {
            if (!renewalFlight) renewalFlight = request('/readers/heartbeat', { ...held }).then(value => {
              if (!stopped && credentials === held && value?.command) {
                const command = value.command;
                if (rejoinDraining) enqueue(command);
                else if (pendingCommands.size < 8) pendingCommands.set([command.type, command.operationId, command.nonce].join(':'), command);
              }
              return value;
            }).finally(() => { renewalFlight = null; });
            return renewalFlight;
          };
          const renew = () => { renewalTimer = setTimer(async () => {
            renewalTimer = null;
            if (stopped || credentials !== held || renewalError) return;
            try { await beat(); } catch (error) { renewalError = error; suspend(); }
            finally { if (!stopped && credentials === held && !renewalError) renew(); }
          }, intervalMs); };
          renew(); // Independent of the awaited SDK/local save; one heartbeat request at a time.
          const value = await request('/paper?paperId=' + encodeURIComponent(paperId));
          if (stopped || credentials !== held) return;
          const ref = canonicalRef(value, paperId);
          await applyCanonical(ref);
          if (stopped || credentials !== held) return;
          const ink = getInk();
          if (ink && (typeof ink.rejoinSync !== 'function' || typeof ink.resumeSync !== 'function')) throw Error('墨迹同步组件尚未就绪');
          await ink?.rejoinSync?.();
          if (stopped || credentials !== held) return;
          if (renewalError) throw renewalError;
          // Keep the public connection lock while draining authenticated commands.
          // resumeSync clears the local suspension only; bridge.syncBlocked still guards editing.
          rejoinDraining = true; ink?.resumeSync?.();
          for (const command of pendingCommands.values()) enqueue(command);
          pendingCommands.clear(); await settleCommands();
          if (renewalFlight) await renewalFlight;
          if (renewalError) throw renewalError;
          await beat(); // A fresh Gate check AFTER the actual save, not just an unchanged token object.
          await settleCommands();
          if (renewalError) throw renewalError;
          if (stopped || credentials !== held) return;
          blocked = false; rejoinDraining = false; problemReported=false; ink?.resumeSync?.();
        } catch { suspend(); await unregister(); report(); }
        finally { rejoinDraining = false; if (renewalTimer !== null) clearTimer(renewalTimer); }
      })().finally(() => { reconnecting = null; });
      return reconnecting;
    }
    function enqueue(command) {
      if (!command || !['prepare', 'resume'].includes(command.type) || !OP.test(command.operationId || '') || !SECRET.test(command.nonce || '')) { report(); return; }
      const held = credentials;
      if (!held || !validEpoch(held)) return;
      const key = [held.clientId, command.type, command.operationId, command.nonce].join(':');
      if (queued.has(key)) return;
      queued.add(key);
      work = work.catch(() => {}).then(async () => {
        if (!validEpoch(held)) return;
        let receipt = receipts.get(key);
        if (!receipt) {
          let ok = true;
          try {
            if (command.type === 'prepare') {
              const ink = getInk();
              if (typeof ink?.prepareMutation !== 'function') throw Error('墨迹组件尚未就绪');
              await ink.prepareMutation(command.operationId);
            } else {
              // result is informational; only this local authenticated lookup owns canonical paths.
              const value = await request('/paper?paperId=' + encodeURIComponent(paperId));
              const ref = canonicalRef(value, paperId);
              if (!validEpoch(held)) return;
              await applyCanonical(ref);
              if (!validEpoch(held)) return;
              await getInk()?.resumeMutation?.(command.operationId, ref);
            }
          } catch { ok = false; report(); }
          if (!validEpoch(held)) return;
          receipt = { operationId: command.operationId, nonce: command.nonce, ok, ...(ok ? {} : { error: command.type === 'prepare' ? 'ink-save-failed' : 'canonical-resume-failed' }) };
          // A transient resume failure must reconcile again; it never replays a paid/API operation.
          if (ok || command.type === 'prepare') {
            receipts.set(key, receipt);
            while (receipts.size > 8) receipts.delete(receipts.keys().next().value);
          }
        }
        if (validEpoch(held)) {await request('/readers/ack', { ...held, ...receipt });if(receipt.ok)problemReported=false;}
      }).catch(report).finally(() => queued.delete(key));
    }
    function tick() {
      if (stopped) return Promise.resolve();
      if (starting) return starting.catch(() => {});
      if (polling) return polling;
      // A command queue may be saving while heartbeats renew liveness independently.
      const held = credentials;
      polling = Promise.resolve().then(async () => {
        if (blocked || !credentials) { await rejoin(); return; }
        const value = await request('/readers/heartbeat', { ...held });
        if (!stopped && credentials === held && value?.command) enqueue(value.command);
      }).catch(async () => { if (!stopped) { suspend(); await rejoin(); } }).finally(() => { polling = null; schedule(); });
      return polling;
    }
    function start() {
      if (starting) return starting;
      if (stopped || credentials && !blocked) return Promise.resolve();
      if (everRegistered) return rejoin().finally(schedule);
      starting = Promise.resolve().then(registerFresh).then(() => {
        if (!stopped) { blocked = false; problemReported=false; getInk()?.resumeSync?.(); schedule(); }
      }).catch(error => { suspend(); schedule(); throw error; }).finally(() => { starting = null; });
      return starting;
    }
    async function stop() { stopped = true; if (timer !== null) clearTimer(timer); timer = null; await unregister(); }
    return { paperId, get blocked() { return blocked; }, start, tick, settle: () => work, stop };
  }
  root.DprReaderSync = Object.freeze({ createReaderSync, reference, canonicalRef, acceptDetailsMessage, validId });
})(globalThis);
