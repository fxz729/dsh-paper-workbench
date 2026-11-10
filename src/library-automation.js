// Explicit opt-in polling. The host supplies safe refs and a receipt-returning enqueue adapter.
import { lstat, realpath, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { resolvePdfPath, validateLegacySegment, validateLegacySegments, foldName } from './collection-paths.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signaturePattern = /^[a-f0-9]{64}$/;
const migrationReason = '旧监听引用存在歧义或已失效，已关闭对应规则并保留原记录，请按文献库 ID 手动确认';
const validName = s => typeof s === 'string' && s.length > 0 && s.length <= 240 && !s.startsWith('.') && !/[\\/\x00-\x1f]/.test(s) && !s.includes('..');
const statKey = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
const statuses = new Set(['baseline', 'enqueued', 'skipped', 'intent', 'failed', 'unknown', 'invalid', 'stale', 'other', 'duplicate']);
const quiet = new Set(['baseline', 'enqueued', 'skipped', 'other']);
const legacyId = r => createHash('sha256').update(JSON.stringify(['legacy',foldName(r.topic),r.name === undefined ? null : foldName(r.name),r.signature ?? null,r.status ?? null])).digest('hex');
const reasons = { duplicate: '与其他文献内容相同，请确认目标文献及译本后手动处理', intent: '入队结果尚未确认，请检查队列后手动处理', failed: '入队未完成，请检查队列后手动处理', unknown: '无法确定原文语言或文件状态，请手动确认', invalid: '已有译本损坏，请检查后手动处理，不会自动覆盖', stale: '原文已变化，请确认已有译本，不会自动覆盖' };
export class LibraryAutomation {
    constructor({ dataDir, list, inspect, language, enqueue, catalog, discovery, intervalMs = 5000, stableMs = 10000 }) {
        if (![list, inspect, language, enqueue].every(f => typeof f === 'function')) throw new TypeError('自动监听需要本地检查和入队回调');
        if ((catalog !== undefined || discovery !== undefined) && (!catalog || !discovery || ![catalog.resolvePaper, catalog.resolveCollection, catalog.snapshot].every(f => typeof f === 'function') || ![discovery.scan, discovery.getEligibility, discovery.withPolicyFence].every(f => typeof f === 'function'))) throw new TypeError('稳定身份监听需要 catalog 和 discovery 回调');
        this.catalog = catalog; this.discovery = discovery;
        this.dataDir = resolve(dataDir); this.file = join(this.dataDir, '.dpr-library-automation.json');
        this.list = list; this.inspect = inspect; this.language = language; this.enqueue = enqueue;
        this.intervalMs = Math.max(10, intervalMs); this.stableMs = Math.max(0, stableMs);
        this.state = catalog ? { version: 2, rules: [], records: [], legacyReview: [] } : { version: 1, enabledTopics: [], records: [] };
        this.disabledCollections = new Set();
        this.globalDisabled = false;
        this.samples = new Map(); this.disabledTopics = new Set(); this.tail = Promise.resolve(); this.timer = null;
        this.stopped = false; this.initialized = false; this.error = null; this.corrupt = false;
    }
    exclusive(fn) {
        const task = this.tail.then(fn);
        this.tail = task.catch(() => {});
        return task;
    }
    async initialize() {
        return this.exclusive(async () => {
            if (this.initialized) return this.snapshot();
            try {
                const st = await lstat(this.file);
                if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe state');
                const saved = JSON.parse(await readFile(this.file, 'utf8'));
                if (this.catalog && saved.version === 2) this.state = this.readIdentityState(saved);
                else {
                    if (saved.version !== 1 || !Array.isArray(saved.enabledTopics) || !saved.enabledTopics.every(validName) || !Array.isArray(saved.records) || saved.records.length > 100000 || !saved.records.every(r => validName(r.topic) && validName(r.name) && signaturePattern.test(r.signature) && statuses.has(r.status))) throw new Error('Invalid state');
                    const legacy = { version: 1, enabledTopics: [...new Set(saved.enabledTopics)], records: saved.records.map(r => ({ topic:r.topic, name:r.name, signature:r.signature, status:r.status, ...(reasons[r.status] ? { reason:reasons[r.status] } : {}) })) };
                    if (this.catalog) await this.discovery.withPolicyFence(async () => { this.state = this.migrateLegacy(legacy); await this.persist(); });
                    else this.state = legacy;
                }
            } catch (e) {
                if (e.code !== 'ENOENT') { this.corrupt = true; this.error = '自动监听状态文件异常，已关闭监听并保留原文件'; }
            }
            this.initialized = true;
            return this.snapshot();
        });
    }
    readIdentityState(saved) {
        if (!Array.isArray(saved.rules) || saved.rules.length > 100000 || !Array.isArray(saved.records) || saved.records.length > 100000 || !Array.isArray(saved.legacyReview) || saved.legacyReview.length > 100000) throw new Error('Invalid state');
        const ids = new Set();
        const rules = saved.rules.map(r => {
            if (!r || !UUID.test(r.collectionId) || typeof r.enabled !== 'boolean' || !Number.isSafeInteger(r.epoch) || r.epoch < 0 || ids.has(r.collectionId.toLowerCase())) throw new Error('Invalid rule');
            ids.add(r.collectionId.toLowerCase()); return { collectionId:r.collectionId.toLowerCase(), enabled:r.enabled, epoch:r.epoch };
        });
        const records = saved.records.map(r => {
            if (!r || !UUID.test(r.paperId) || !UUID.test(r.collectionId) || !signaturePattern.test(r.signature) || !statuses.has(r.status)) throw new Error('Invalid record');
            validateLegacySegments(r.topic.split('/')); validateLegacySegment(r.name);
            return { paperId:r.paperId.toLowerCase(), collectionId:r.collectionId.toLowerCase(), topic:r.topic, name:r.name, signature:r.signature, status:r.status };
        });
        const legacyReview = saved.legacyReview.map(r => {
            if (!r || !validName(r.topic) || (r.name !== undefined && !validName(r.name)) || (r.signature !== undefined && !signaturePattern.test(r.signature))) throw new Error('Invalid legacy evidence');
            return { topic:r.topic, ...(r.name !== undefined ? { name:r.name } : {}), ...(r.signature !== undefined ? { signature:r.signature, status:r.status } : {}) };
        });
        let dismissedLegacy;
        if (Object.hasOwn(saved,'dismissedLegacy')) {
            const known = new Set(legacyReview.map(legacyId));
            if (!Array.isArray(saved.dismissedLegacy) || saved.dismissedLegacy.length > 100000 || new Set(saved.dismissedLegacy).size !== saved.dismissedLegacy.length || saved.dismissedLegacy.some(id=>typeof id!=='string'||!signaturePattern.test(id)||!known.has(id))) throw new Error('Invalid legacy dismissal');
            dismissedLegacy = [...saved.dismissedLegacy];
        }
        let global;
        if (Object.hasOwn(saved,'global')) {
            const g = saved.global;
            if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).some(k=>!['enabled','epoch'].includes(k)) || typeof g.enabled !== 'boolean' || !Number.isSafeInteger(g.epoch) || g.epoch < 0 || (g.enabled && g.epoch === 0) || (g.epoch > 0 && rules.some(r=>r.epoch===g.epoch))) throw new Error('Invalid global rule');
            global = {enabled:g.enabled,epoch:g.epoch};
        }
        return { version:2, rules, records, legacyReview, ...(global ? {global} : {}), ...(dismissedLegacy ? {dismissedLegacy} : {}), ...(saved.legacyEvidence ? { legacyEvidence:saved.legacyEvidence } : {}) };
    }
    migrateLegacy(legacy) {
        const state = { version:2, rules:[], records:[], legacyReview:[], legacyEvidence:legacy };
        for (const topic of legacy.enabledTopics) {
            try { const c = this.catalog.resolveCollection({topic}); if (!state.rules.some(r=>r.collectionId===c.collectionId)) state.rules.push({collectionId:c.collectionId, enabled:true, epoch:1}); }
            catch { state.legacyReview.push({topic}); }
        }
        for (const r of legacy.records) {
            try {
                const ref = this.catalog.resolvePaper({topic:r.topic, name:r.name});
                const existing = state.records.find(row => row.paperId === ref.paperId && row.signature === r.signature);
                if (!existing) state.records.push({...r, paperId:ref.paperId, collectionId:ref.collectionId, topic:ref.topic, name:ref.name});
                else if (!quiet.has(r.status) && (quiet.has(existing.status) || r.status === 'intent')) { existing.status = r.status; delete existing.reason; }
            } catch {
                state.legacyReview.push({...r});
                try { const c = this.catalog.resolveCollection({topic:r.topic}); const rule = state.rules.find(row => row.collectionId === c.collectionId); if (rule) rule.enabled = false; } catch { /* an ambiguous collection already remains off */ }
            }
        }
        return state;
    }
    getGlobalRule() {
        const rule = this.state.global;
        return {enabled:!!(this.catalog && rule?.enabled && this.initialized && !this.stopped && !this.corrupt && !this.globalDisabled),epoch:rule?.epoch ?? 0};
    }
    nextRuleEpoch() {
        let epoch = this.state.global?.epoch ?? 0;
        for (const rule of this.state.rules) epoch = Math.max(epoch,rule.epoch);
        if (!Number.isSafeInteger(epoch + 1)) throw new Error('自动监听规则版本无效');
        return epoch + 1;
    }
    getRules() {
        if (!this.catalog) return [];
        let collections;
        try { collections = this.catalog.snapshot().collections; } catch { collections = {}; }
        if (this.state.global?.enabled) {
            const global = this.getGlobalRule();
            return Object.values(collections).filter(c=>c.status!=='trashed').map(c=>({collectionId:c.collectionId,enabled:global.enabled,epoch:global.epoch}));
        }
        return this.state.rules.map(r => ({...r, enabled:r.enabled && this.initialized && !this.stopped && !this.corrupt && !this.disabledCollections.has(r.collectionId) && !!collections[r.collectionId] && collections[r.collectionId].status !== 'trashed'}));
    }
    ruleFor(ref) { return this.getRules().find(r => r.collectionId === ref.collectionId && r.enabled); }
    samePaper(record, ref) { return this.catalog ? record.paperId === ref.paperId : record.topic === ref.topic && record.name === ref.name; }
    recordFor(ref, signature, status) { return { topic:ref.topic, name:ref.name, signature, status, ...(this.catalog ? {paperId:ref.paperId, collectionId:ref.collectionId} : {}) }; }
    ruleEnabled(ref) { return this.catalog ? !!this.ruleFor(ref) : this.state.enabledTopics.includes(ref.topic) && !this.disabledTopics.has(ref.topic); }
    observation(ref, signature) {
        try { return this.discovery.getEligibility({paperId:ref.paperId, sourceSignature:signature}); } catch { return null; }
    }
    authorized(ref, signature, epoch) {
        if (this.stopped || this.corrupt || !this.initialized || !this.ruleEnabled(ref)) return false;
        if (!this.catalog) return true;
        try {
            const current = this.catalog.resolvePaper({paperId:ref.paperId}), observed = this.observation(current, signature)?.observedTranslation;
            const rule = this.ruleFor(current);
            return current.collectionId === ref.collectionId && !!rule && rule.epoch === epoch && observed?.collectionId === current.collectionId && observed.epoch === epoch;
        } catch { return false; }
    }
    async setCollection(collectionId, enabled) {
        if (!this.catalog || !UUID.test(collectionId) || typeof enabled !== 'boolean') throw new Error('自动监听设置无效');
        collectionId = collectionId.toLowerCase();
        if (!enabled) this.disabledCollections.add(collectionId);
        return this.exclusive(async () => {
            if (!this.initialized || this.stopped || this.corrupt) throw new Error('自动监听当前不可用');
            return this.discovery.withPolicyFence(async () => {
                if (enabled) this.catalog.resolveCollection({collectionId}); // enabling requires a live, physically valid collection
                const previous = this.state.rules.find(r => r.collectionId === collectionId);
                if (!!previous?.enabled === enabled) return this.snapshot();
                const baseline = [];
                if (enabled && !this.state.global?.enabled) for (const item of (await this.refs()).filter(i => i.ref.collectionId === collectionId)) {
                    const signature = await this.fingerprint(item);
                    if (!signature) throw new Error('专题文件正在变化，请稍后开启');
                    if (!this.state.records.some(r => this.samePaper(r,item.ref) && r.signature === signature)) baseline.push(this.recordFor(item.ref,signature,'baseline'));
                }
                const epoch = this.nextRuleEpoch();
                if (!Number.isSafeInteger(epoch)) throw new Error('自动监听规则版本无效');
                this.state.records.push(...baseline);
                if (previous) Object.assign(previous,{enabled,epoch}); else this.state.rules.push({collectionId,enabled,epoch});
                this.samples.clear(); await this.persist();
                if (enabled) this.disabledCollections.delete(collectionId);
                return this.snapshot();
            });
        });
    }
    async setGlobal(enabled) {
        if (!this.catalog || typeof enabled !== 'boolean') throw new Error('全局自动翻译设置无效');
        if (!enabled) this.globalDisabled = true; // Revoke before an in-flight scan or policy fence can yield.
        return this.exclusive(async () => {
            if (!this.initialized || this.stopped || this.corrupt) throw new Error('自动监听当前不可用');
            return this.discovery.withPolicyFence(async () => {
                if (!!this.state.global?.enabled === enabled && (!enabled || !this.globalDisabled)) return this.snapshot();
                const baseline = [];
                if (enabled) for (const item of await this.refs()) {
                    const signature = await this.fingerprint(item);
                    if (!signature) throw new Error('文献文件正在变化，请稍后开启全局翻译');
                    if (!this.state.records.some(r=>this.samePaper(r,item.ref) && r.signature===signature)) baseline.push(this.recordFor(item.ref,signature,'baseline'));
                }
                const epoch = this.nextRuleEpoch();
                this.state.records.push(...baseline);this.state.global = {enabled,epoch};
                this.samples.clear();await this.persist();
                if (enabled) this.globalDisabled = false;
                return this.snapshot();
            });
        });
    }
    async dismissLegacy(args = {}) {
        if (!this.catalog || !args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).some(k=>k!=='id') || (args.id!==undefined && (typeof args.id!=='string'||!signaturePattern.test(args.id)))) throw new Error('历史提示标识无效');
        const id = args.id;
        return this.exclusive(async () => {
            if (!this.initialized || this.stopped || this.corrupt) throw new Error('自动监听当前不可用');
            const known = new Set(this.state.legacyReview.map(legacyId)), dismissed = new Set(this.state.dismissedLegacy ?? []);
            if (id!==undefined && !known.has(id)) throw new Error('历史提示已变化，请刷新后重试');
            const targets = id===undefined ? [...known].filter(value=>!dismissed.has(value)) : dismissed.has(id) ? [] : [id];
            if (!targets.length) return this.snapshot();
            for (const value of targets) dismissed.add(value);
            this.state.dismissedLegacy = [...dismissed];await this.persist();return this.snapshot();
        });
    }
    async persist() {
        if (this.corrupt) throw new Error('自动监听状态文件需要人工检查');
        let tmp;
        try {
            try { const st = await lstat(this.file); if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe state'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            tmp = this.file + '.' + randomUUID() + '.tmp';
            await writeFile(tmp, JSON.stringify(this.state), { flag: 'wx', mode: 0o600 });
            await rename(tmp, this.file);
        } catch {
            this.error = '无法保存自动监听状态，已停止自动入队';
            this.corrupt = true;
            throw new Error(this.error);
        } finally { if (tmp) await unlink(tmp).catch(() => {}); }
    }
    async safeRef(ref) {
        if (this.catalog) {
            try {
                if (!ref || !UUID.test(ref.paperId)) return null;
                const current = this.catalog.resolvePaper({paperId:ref.paperId});
                const expected = resolvePdfPath(this.dataDir,current.segments,current.name);
                if (!UUID.test(current.collectionId) || foldName(resolve(current.pdfPath)) !== foldName(expected)) return null;
                const st = await lstat(expected,{bigint:true});
                if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n) return null;
                return {ref:{...current,topic:current.segments.join('/'),pdfPath:expected},stat:statKey(st)};
            } catch { return null; }
        }
        if (!validName(ref?.topic) || !validName(ref?.name) || /-(?:en|zh|dual)$/i.test(ref.name) || typeof ref.pdfPath !== 'string') return null;
        const expected = join(this.dataDir, ref.topic, ref.name + '.pdf');
        if (resolve(ref.pdfPath).toLowerCase() !== expected.toLowerCase()) return null;
        try {
            const root = await realpath(this.dataDir);
            const dir = dirname(expected);
            const topic = await lstat(dir);
            if (!topic.isDirectory() || topic.isSymbolicLink() || resolve(await realpath(dir)).toLowerCase() !== join(root,ref.topic).toLowerCase()) return null;
            const st = await lstat(expected, { bigint: true });
            if (!st.isFile() || st.isSymbolicLink() || resolve(await realpath(expected)).toLowerCase() !== join(root,ref.topic,ref.name+'.pdf').toLowerCase()) return null;
            return { ref: { topic:ref.topic, name:ref.name, pdfPath:expected }, stat: statKey(st) };
        } catch { return null; }
    }
    async fingerprint(item) {
        let handle;
        try {
            handle = await open(item.ref.pdfPath, 'r');
            if (statKey(await handle.stat({ bigint: true })) !== item.stat) return null;
            const hash = createHash('sha256');
            for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
            const again = await this.safeRef(item.ref);
            return again?.stat === item.stat ? hash.digest('hex') : null;
        } finally { await handle?.close(); }
    }
    async refs() {
        const refs = await this.list();
        if (!Array.isArray(refs)) throw new Error('Invalid library list');
        const safe = [];
        for (const ref of refs) { const item = await this.safeRef(ref); if (item) safe.push(item); }
        return safe;
    }
    async setTopic(topic, enabled) {
        if (this.catalog) return this.setCollection(this.catalog.resolveCollection({topic}).collectionId,enabled);
        if (!validName(topic) || typeof enabled !== 'boolean') throw new Error('自动监听设置无效');
        if (!enabled) this.disabledTopics.add(topic); // Revoke immediately, even while a scan is awaiting local parsing.
        return this.exclusive(async () => {
            if (!this.initialized || this.stopped || this.corrupt) throw new Error('自动监听当前不可用');
            if (this.state.enabledTopics.includes(topic) === enabled) return this.snapshot();
            if (enabled) {
                // Baseline and opt-in are one durable transaction. Existing files never trigger catch-up charges.
                const baseline = [];
                for (const item of (await this.refs()).filter(i => i.ref.topic === topic)) {
                    const signature = await this.fingerprint(item);
                    if (!signature) throw new Error('专题文件正在变化，请稍后开启');
                    if (!this.state.records.some(r => r.signature === signature && r.topic === topic && r.name === item.ref.name)) baseline.push({ topic, name:item.ref.name, signature, status:'baseline' });
                }
                this.state.records.push(...baseline); this.state.enabledTopics.push(topic);
            } else this.state.enabledTopics = this.state.enabledTopics.filter(t => t !== topic);
            this.samples.clear();
            await this.persist();
            if (enabled) this.disabledTopics.delete(topic);
            return this.snapshot();
        });
    }
    snapshot() {
        if (this.catalog) {
            let collections;
            try { collections = this.catalog.snapshot().collections; } catch { collections = {}; }
            const enabledTopics = this.getRules().filter(r=>r.enabled).map(r=>collections[r.collectionId].segments.join('/'));
            const collectionEnabledTopics = this.state.rules.filter(r=>r.enabled && collections[r.collectionId] && collections[r.collectionId].status!=='trashed').map(r=>collections[r.collectionId].segments.join('/'));
            const globalEnabled = this.getGlobalRule().enabled;
            const pending = this.state.records.filter(r=>!quiet.has(r.status)).map(r=>{
                let current = r; try { current = this.catalog.resolvePaper({paperId:r.paperId}); } catch { /* retain historical display evidence */ }
                return {paperId:r.paperId,collectionId:r.collectionId,sourceSignature:r.signature,topic:current.topic,name:current.name,state:r.status==='intent'?'unknown':r.status,reason:reasons[r.status]||reasons.unknown};
            });
            const dismissed = new Set(this.state.dismissedLegacy ?? []);
            pending.push(...this.state.legacyReview.filter(r=>!dismissed.has(legacyId(r))).map(r=>({kind:'legacy',id:legacyId(r),topic:r.topic,name:r.name||'(专题)',state:'unknown',reason:migrationReason})));
            return {enabledTopics,collectionEnabledTopics,globalEnabled,pending,watching:Boolean(this.timer)&&!this.stopped&&!this.corrupt&&(globalEnabled||enabledTopics.length>0),...(this.error?{error:this.error}:{})};
        }
        return { enabledTopics: [...this.state.enabledTopics], pending: this.state.records.filter(r => !quiet.has(r.status)).map(r => ({ topic:r.topic, name:r.name, state:r.status === 'intent' ? 'unknown' : r.status, reason:reasons[r.status] || reasons.unknown })), watching: Boolean(this.timer) && !this.stopped && !this.corrupt && this.state.enabledTopics.length > 0, ...(this.error ? { error:this.error } : {}) };
    }
    start() {
        if (this.stopped || this.timer || (this.corrupt && !this.discovery)) return;
        this.timer = setInterval(() => { this.scan().catch(() => {}); }, this.intervalMs);
        this.timer.unref?.();
    }
    async scan() {
        // Coalesce timer ticks; never build an unbounded backlog while local PDF parsing is slow.
        if (this.scanning) return this.scanning;
        const task = this.exclusive(async () => {
            if (!this.initialized || this.stopped) return;
            try {
                if (this.discovery) await this.discovery.scan(); // the existing timer also drives local discovery while translation is off
                if (this.stopped || this.corrupt || (!(this.catalog ? this.getRules().some(r=>r.enabled) : this.state.enabledTopics.length) && !this.state.records.some(r=>!quiet.has(r.status)))) return;
                const seen = new Set();
                for (const item of await this.refs()) {
                    if (this.stopped) break;
                    const { ref } = item;
                    const pending = this.state.records.filter(r => this.samePaper(r,ref) && !quiet.has(r.status));
                    if (!pending.length && !this.ruleEnabled(ref)) continue;
                    const key = this.catalog ? ref.paperId : JSON.stringify([ref.topic,ref.name]); seen.add(key);
                    const old = this.samples.get(key);
                    if (!old || old.stat !== item.stat) { this.samples.set(key, {stat:item.stat,since:Date.now()}); continue; }
                    if (Date.now() - old.since < this.stableMs) continue;
                    const signature = old.signature || await this.fingerprint(item);
                    if (signature) old.signature = signature; // Cache only while the sampled stat identity is unchanged.
                    if (!signature) continue;
                    if (pending.length) {
                        // A manual repair may resolve pending locally. Never classify or enqueue this path.
                        let repaired;
                        try { repaired = await this.inspect(ref); } catch { repaired = {state:'unknown'}; }
                        if (this.stopped) break;
                        if (repaired?.state === 'translated') {
                            const current = await this.safeRef(ref);
                            if (!current || current.stat !== item.stat || await this.fingerprint(current) !== signature) { this.samples.delete(key); continue; }
                            if (this.stopped) break;
                            for (const record of pending) { record.status = 'skipped'; delete record.reason; }
                            if (!this.state.records.some(r => this.samePaper(r,ref) && r.signature === signature)) this.state.records.push(this.recordFor(ref,signature,'skipped'));
                            await this.persist();
                        }
                        continue;
                    }
                    if (this.state.records.some(r => r.signature === signature && this.samePaper(r,ref))) continue;
                    const epoch = this.catalog ? this.ruleFor(ref)?.epoch : null;
                    if (this.catalog && !this.authorized(ref,signature,epoch)) {
                        this.state.records.push(this.recordFor(ref,signature,this.observation(ref,signature) ? 'baseline' : 'unknown'));
                        await this.persist(); continue;
                    }
                    if (this.state.records.some(r => r.signature === signature) || (this.catalog && this.state.legacyReview.some(r => r.signature === signature))) {
                        this.state.records.push(this.recordFor(ref,signature,'duplicate'));
                        await this.persist(); continue;
                    }
                    const record = this.recordFor(ref,signature,'unknown');
                    let health;
                    try { health = await this.inspect(ref); } catch { health = {state:'unknown'}; }
                    if (this.stopped || !this.ruleEnabled(ref)) break;
                    if (health?.state === 'translated') {
                        record.status = this.state.records.some(r=>this.samePaper(r,ref) && r.signature!==signature) ? 'stale' : 'skipped';
                    } else if (health?.state !== 'missing') record.status = ['invalid','stale'].includes(health?.state) ? health.state : 'unknown';
                    else {
                        let language;
                        try { language = await this.language(ref); } catch { language = 'unknown'; }
                        if (this.stopped || !this.ruleEnabled(ref)) break;
                        if (language === 'other') record.status = 'other';
                        else if (language === 'english') {
                            // Revalidate after parsing and immediately before handing authority to host.
                            const fresh = await this.safeRef(ref);
                            if (!fresh || fresh.stat !== item.stat) continue;
                            try { health = await this.inspect(ref); } catch { health = {state:'unknown'}; }
                            if (this.stopped || !this.ruleEnabled(ref)) break;
                            if (health?.state === 'missing') {
                                const unchanged = async () => {
                                    const current = await this.safeRef(ref);
                                    return Boolean(current && current.stat === item.stat && await this.fingerprint(current) === signature);
                                };
                                if (!await unchanged()) { this.samples.delete(key); continue; }
                                record.status = 'intent'; this.state.records.push(record);
                                await this.persist(); // A crash after this point must not silently charge again.
                                if (this.stopped || !this.ruleEnabled(ref)) break;
                                if (!await unchanged()) {
                                    record.status = 'unknown'; this.samples.delete(key);
                                    await this.persist(); continue;
                                }
                                const authorize = () => this.authorized(ref,signature,epoch);
                                if (!authorize()) break;
                                try {
                                    const receipt = await this.enqueue([{...ref,sourceSignature:signature}], {authorize});
                                    const matches = r => this.catalog ? r?.paperId === ref.paperId && r?.sourceSignature === signature : r?.topic === ref.topic && r?.name === ref.name;
                                    if (Array.isArray(receipt?.enqueued) && receipt.enqueued.some(matches)) record.status = 'enqueued';
                                    else {
                                        const skip = Array.isArray(receipt?.skipped) && receipt.skipped.find(matches);
                                        record.status = skip && ['translated','active','already-translated','active-task'].includes(skip.reason) ? 'skipped' : 'unknown';
                                    }
                                } catch { record.status = 'failed'; }
                                await this.persist(); continue;
                            }
                            record.status = health?.state === 'translated' ? 'skipped' : ['invalid','stale'].includes(health?.state) ? health.state : 'unknown';
                        }
                    }
                    this.state.records.push(record); await this.persist();
                }
                for (const key of this.samples.keys()) if (!seen.has(key)) this.samples.delete(key);
            } catch {
                this.error ||= '本地目录扫描未完成，请检查文献库后手动确认';
            }
        });
        this.scanning = task;
        try { await task; } finally { this.scanning = null; }
    }
    async stop() {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.tail;
    }
}
