// One root owner for HTTP and model tools. Proofs and reader credentials stay in memory.
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestPaperEnrichment } from './paper-enrichment.js';
import { createCatalog } from './paper-catalog.js';
import { initializeLibraryIdentity } from './library.js';
import { canonicalRoot, CatalogError } from './collection-paths.js';
import { createLibraryService } from './library-service.js';
import { createReaderGate } from './reader-gate.js';
import * as metadata from './paper-metadata.js';
import { sourceFingerprint } from './paper-health.js';
import { resolveTranslateEndpoint } from './translate-config.js';
import { extractLocal } from './transcribe.js';
import { zhStatus } from './translate.js';
import { sanitizeDetail } from './mineru.js';
const roots = new Map();
const busy = () => { throw new CatalogError('reader-busy', 409); };
const denied = () => { throw new CatalogError('authorization-required', 403); };
const PROOF_TTL = 10 * 60_000;
export function createPaperRuntime(dataDir, config = {}, adapters = {}) {
    const root = canonicalRoot(dataDir), catalog = createCatalog(root), gate = createReaderGate();
    const tools = new Map(), ui = new WeakMap(), tasks = new Map(), authorities = new Map(), mutationSignals = new Map(), proofContext = new AsyncLocalStorage(), ioContext = new AsyncLocalStorage();
    let closed = false, enrichment, observer, observerReady = false, runtime, stopping, sessionInspector, localIO = Promise.resolve();
    let translationRulesProvider = () => [];
    let translationGlobalProvider = () => ({ enabled: false, epoch: 0 });
    const open = () => { if (closed) throw new CatalogError('not-ready'); };
    const taskPending = id => gate.snapshot().operations.some(op => op.paperIds.includes(id));
    const taskActive = id => [...tasks.values()].some(task => task.paperId === id);
    function sweepProofs() { for (const [token, proof] of tools) if (proof.expiresAt < Date.now()) tools.delete(token); }
    function intentFrom(exec) {
        if (exec?.name !== 'library_manage' || typeof exec.token !== 'symbol' || !exec.arguments || typeof exec.arguments !== 'object') denied();
        return { ...structuredClone(exec.arguments), expiresAt: Date.now() + PROOF_TTL, exec };
    }
    function matches(proof, context, fromUi) {
        if (!proof || proof.expiresAt < Date.now() || proof.exec?.signal?.aborted) return false;
        if (proof.intent !== undefined || context.intent !== undefined) {
            if (!fromUi || proof.intent !== 'manual-summary' || context.intent !== proof.intent
                || !Object.hasOwn(proof, 'expectedRevision') || !Object.hasOwn(context, 'expectedRevision')
                || proof.expectedRevision !== context.expectedRevision
                || !(proof.expectedRevision === null || typeof proof.expectedRevision === 'string' && /^[0-9a-f]{64}$/.test(proof.expectedRevision))) return false;
        }
        const actions = { run: 'run_enrichment', retry: 'run_enrichment', 'set-automation': 'set_automation' };
        if (proof.action !== context.action && proof.action !== actions[context.action]) return false;
        if (proof.paperId !== undefined && proof.paperId !== context.paperId) return false;
        if (context.action === 'run') return typeof proof.planId === 'string' && proof.planId === context.planId && typeof proof.operationId === 'string' && proof.operationId === context.operationId;
        if (context.action === 'retry') return typeof proof.jobId === 'string' && proof.jobId === context.jobId && typeof proof.operationId === 'string' && proof.operationId === context.operationId;
        if (context.action === 'set-automation') {
            const expected = [...(proof.autoSummary === true ? ['summary'] : []), ...(proof.autoName === true ? ['name'] : [])].sort();
            return Array.isArray(context.features) && JSON.stringify([...context.features].sort()) === JSON.stringify(expected);
        }
        return false;
    }
    function authorize(proof, context) {
        if (closed) return false;
        // Automatic authority is private queue control flow, further constrained by its durable epoch/watermark.
        if (context?.action === 'automatic') return true;
        sweepProofs();
        const fromUi = Boolean(proof && typeof proof === 'object' && ui.has(proof));
        return matches(typeof proof === 'symbol' ? tools.get(proof) : fromUi ? ui.get(proof) : null, context || {}, fromUi);
    }
    async function taskRaw(paperId, fn) {
        open();
        const ref = catalog.resolvePaper({ paperId });
        if (taskPending(paperId) || taskActive(paperId)) busy();
        const key = Symbol('paper-task');
        let done;
        const completion = new Promise(r => { done = r; });
        tasks.set(key, { paperId, completion });
        try { return await fn(ref); }
        finally { tasks.delete(key); done(); }
    }
    async function writeRaw(paperId, fn) {
        open(); gate.assertWritable(paperId);
        if (ioContext.getStore() === runtime) throw new CatalogError('conflict');
        const work = localIO.then(() => ioContext.run(runtime, async () => {
            open(); gate.assertWritable(paperId);
            return service.withPaperWrite({ paperId }, async ref => {
                open(); gate.assertWritable(paperId);
                return fn(ref);
            });
        }));
        localIO = work.catch(() => {});
        return work;
    }
    async function prepareReaders(input) {
        open();
        // Recovery has already verified WAL/catalog identity; its source may be in owned trash.
        // Keep UUID/task/session/translation admission without requiring that old PDF to exist.
        const recovering = input.recovering === true;
        const checkTasks = () => {
            const snapshot = recovering ? catalog.snapshot() : null;
            for (const id of input.paperIds) {
                if (taskActive(id)) busy();
                let ref;
                if (recovering) {
                    const paper = snapshot.papers[id];
                    if (!paper || paper.status !== 'active') busy();
                    ref = { pdfPath: join(root, ...paper.segments, paper.name + '.pdf') };
                } else ref = catalog.resolvePaper({ paperId: id });
                if (zhStatus(ref).busy) busy();
            }
        };
        const inspectSessions = () => sessionInspector?.([...input.paperIds], { recovering });
        checkTasks();
        await inspectSessions();
        open(); checkTasks();
        const authority = authorities.get(input.operation.operationId);
        if (authority && !authority()) denied();
        const signal = mutationSignals.get(input.operation.operationId);
        const lease = await gate.prepare({ paperIds: input.paperIds, operation: input.operation, ...(signal ? { signal } : {}) });
        try {
            await inspectSessions();
            open(); checkTasks();
            if (authority && !authority()) denied();
            return lease;
        } catch (error) {
            try { lease.release(); } catch { /* Preserve the admission failure; uncertain readers stay frozen. */ }
            throw error;
        }
    }
    const service = createLibraryService(root, {
        catalog, prepareReaders,
        authorizeMutation: operation => !closed && (!authorities.has(operation.operationId) || authorities.get(operation.operationId)()),
        authorizeDiscovery: (proof, args) => observerReady ? observer.authorizeDiscovery(proof, args) : null,
        captureIngestPolicy: context => observerReady ? observer.captureIngestPolicy(context) : { observedPolicyEpoch: null, observedTranslation: null },
        onIngest: async event => {
            const eligibility = observerReady ? await observer.rememberImport(event) : null;
            return enrichment.admitNew({ ...event, observedPolicyEpoch: eligibility?.observedPolicyEpoch ?? null, observedTranslation: eligibility?.observedTranslation ?? null });
        },
    });
    runtime = {
        catalog, service, gate,
        get discovery() { return observer; },
        setTranslationRulesProvider(provider) { open(); if (typeof provider !== 'function') throw new CatalogError('invalid'); translationRulesProvider = provider; },
        setTranslationGlobalProvider(provider) { open(); if (typeof provider !== 'function') throw new CatalogError('invalid'); translationGlobalProvider = provider; },
        setSessionInspector(inspector) { open(); if (typeof inspector !== 'function') throw new CatalogError('invalid'); sessionInspector = inspector; },
        get enrichment() { return enrichment; },
        async endpointInfo() {
            const resolved = adapters.resolveEndpoint ? { endpoint: await adapters.resolveEndpoint(), source: 'profile' } : await resolveTranslateEndpoint(config.translate);
            return { model: sanitizeDetail(String(resolved.endpoint.model || ''), resolved.endpoint.apiKey).slice(0, 500), source: resolved.source, hasApiKey: Boolean(resolved.endpoint.apiKey) };
        },
        recordToolIntent(exec) { open(); sweepProofs(); tools.set(exec.token, intentFrom(exec)); return true; },
        hasToolIntent(exec) { sweepProofs(); const proof = tools.get(exec?.token); return !closed && !exec?.signal?.aborted && proof?.exec === exec && proof.expiresAt >= Date.now(); },
        revokeToolIntent(exec) { return tools.delete(exec?.token); },
        createUiAuthorization(action, args) {
            open(); const proof = Object.freeze({});
            ui.set(proof, { ...structuredClone(args), action, expiresAt: Date.now() + PROOF_TTL }); return proof;
        },
        async withPaperWrite(paperId, fn) { await runtime.ready; return writeRaw(paperId, fn); },
        async withPaperTask(paperId, fn) { await runtime.ready; return taskRaw(paperId, fn); },
        async applyToolRename(exec, args) {
            const input = structuredClone(args);
            await runtime.ready;
            const valid = () => {
                const proof = tools.get(exec?.token);
                return runtime.hasToolIntent(exec) && proof.action === 'update_collection' && typeof input.operationId === 'string'
                    && proof.operationId === input.operationId && proof.planId === input.planId && proof.collectionId === input.collectionId;
            };
            if (!valid()) denied();
            if (authorities.has(input.operationId)) throw new CatalogError('conflict');
            authorities.set(input.operationId, valid);
            if (exec.signal) mutationSignals.set(input.operationId, exec.signal);
            try { return await service.applyRename(input); }
            finally { authorities.delete(input.operationId); mutationSignals.delete(input.operationId); }
        },
        stop() {
            if (stopping) return stopping;
            closed = true; tools.clear(); gate.close();
            stopping = (async () => {
                await runtime.ready.catch(() => {});
                await enrichment?.stop();
                await observer?.stop();
                await Promise.all([...tasks.values()].map(task => task.completion));
                await localIO;
                proofContext.disable(); ioContext.disable();
                for (const [key, value] of roots) if (value === runtime) roots.delete(key);
            })();
            return stopping;
        },
    };
    runtime.ready = (async () => {
        await initializeLibraryIdentity(root); open();
        const factory = adapters.createEnrichmentService || (await import('./enrichment-queue.js')).createEnrichmentService;
        const queue = factory({
            storageDir: root,
            resolvePaper: locator => catalog.resolvePaper(locator),
            getIngestSeq: () => catalog.snapshot().ingestSeq,
            withPolicyFence: async fn => { if (!observerReady) throw new CatalogError('not-ready'); return observer.withPolicyFence(fn); },
            resolveEndpoint: adapters.resolveEndpoint || (async () => (await resolveTranslateEndpoint(config.translate)).endpoint),
            readText: adapters.readText || (ref => taskRaw(ref.paperId, async current => {
                const before = await sourceFingerprint(current);
                if (!before) throw new CatalogError('source-changed', 409);
                const { text } = await extractLocal(current.pdfPath);
                if (await sourceFingerprint(current) !== before) throw new CatalogError('source-changed', 409);
                return { text, sourceSignature: before };
            })),
            readMetadata: ref => metadata.readPaperMetadata(root, ref.paperId),
            writeCandidate: (ref, patch) => metadata.writePaperCandidate(root, ref.paperId, patch),
            applyCandidate: (ref, patch, authority = {}) => writeRaw(ref.paperId, async current => {
                if (authority.authorize && !authority.authorize()) denied();
                if (authority.sourceSignature && await sourceFingerprint(current) !== authority.sourceSignature) throw new CatalogError('source-changed', 409);
                const value = await metadata.readPaperMetadata(root, ref.paperId);
                const candidate = value.candidate;
                const manual = authority.intent === 'manual-summary' && typeof authority.authorize === 'function'
                    && Object.hasOwn(authority, 'expectedRevision') && authority.expectedRevision === candidate?.expectedRevision
                    && authority.expectedRevision === candidate?.baseRevision
                    && typeof authority.sourceSignature === 'string' && /^[0-9a-f]{64}$/.test(authority.sourceSignature)
                    && candidate?.sourceSignature === authority.sourceSignature;
                if (authority.intent === 'manual-summary' && !manual
                    || authority.sourceSignature && candidate?.sourceSignature !== authority.sourceSignature) throw new CatalogError('conflict');
                if (!(manual ? ['empty', 'api', 'manual', 'model'] : ['empty', 'api']).includes(value.summary.source)
                    || value.revision !== patch.revision || !candidate || candidate.operationId !== patch.operationId
                    || candidate.expectedRevision !== candidate.baseRevision) throw new CatalogError('conflict');
                if (authority.authorize && !authority.authorize()) denied();
                return metadata.applyPaperCandidate(root, ref.paperId, patch);
            }),
            renamePaper: async (ref, args) => {
                const current = catalog.resolvePaper({ paperId: ref.paperId });
                if (args.authorize && !args.authorize()) denied();
                if (args.sourceSignature && await sourceFingerprint(current) !== args.sourceSignature) throw new CatalogError('source-changed', 409);
                const plan = await service.planRename({ paperId: current.paperId, name: args.name, expectedLocationRevision: args.expectedLocationRevision });
                if (authorities.has(args.operationId)) throw new CatalogError('conflict');
                authorities.set(args.operationId, args.authorize || (() => false));
                try { if (!authorities.get(args.operationId)()) denied(); return await service.applyRename({ planId: plan.planId, operationId: args.operationId }); }
                finally { authorities.delete(args.operationId); }
            },
            authorize,
            request: args => {
                const proof = proofContext.getStore(), caller = typeof proof === 'symbol' ? tools.get(proof)?.exec?.signal : null;
                const signal = caller ? AbortSignal.any([args.signal, caller]) : args.signal;
                return (adapters.request || requestPaperEnrichment)({ ...args, signal });
            },
        });
        enrichment = { ...queue,
            run: (input, proof) => proofContext.run(proof, () => queue.run(input, proof)),
            retry: (input, proof) => proofContext.run(proof, () => queue.retry(input, proof)),
        };
        await enrichment.initialize();
        const observerFactory = adapters.createLibraryObserver || (await import('./library-observer.js')).createLibraryObserver;
        observer = observerFactory({ dataDir: root, catalog,
            registerExisting: (args, proof) => service.registerExisting(args, proof),
            getPolicy: () => enrichment.getAutomation ? enrichment.getAutomation() : { epoch: 0, autoSummary: false, autoName: false },
            getTranslationRules: () => translationRulesProvider(),
            getGlobalTranslationRule: () => translationGlobalProvider(),
        });
        // A damaged qualification ledger closes automatic authority, while local library work stays available.
        try { await observer.initialize(); observerReady = true; } catch { observerReady = false; }
        await service.initialize();
        open(); return runtime;
    })();
    // Callers await the same promise; prevent unobserved initialization rejections at plugin registration.
    runtime.ready.catch(() => {});
    return runtime;
}
export function getPaperRuntime(dataDir, config = {}) {
    const root = canonicalRoot(resolve(dataDir)), key = process.platform === 'win32' ? root.toLowerCase() : root;
    if (!roots.has(key)) roots.set(key, createPaperRuntime(root, config));
    return roots.get(key);
}
