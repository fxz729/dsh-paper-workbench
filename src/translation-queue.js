// A server-owned, single-document scheduler. Persist references, never endpoint credentials.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLegacySegments, validateLegacySegment } from './collection-paths.js';
const states = new Set(['queued', 'running', 'done', 'failed', 'skipped']);
function validRef(ref) {
    const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
    if (!ref || typeof ref.topic !== 'string') throw new Error('文献引用无效');
    validateLegacySegments(ref.topic.split('/')); validateLegacySegment(ref.name); validateLegacySegment(ref.name + '.pdf');
    if (ref.paperId !== undefined && !uuid(ref.paperId) || ref.collectionId !== undefined && !uuid(ref.collectionId)) throw new Error('文献引用无效');
    return { topic: ref.topic, name: ref.name, ...(ref.paperId === undefined ? {} : { paperId: ref.paperId }), ...(ref.collectionId === undefined ? {} : { collectionId: ref.collectionId }) };
}
export class TranslationQueue {
    constructor(file, execute) {
        this.file = file;
        this.execute = execute;
        this.stopped = false;
        this.active = null;
        this.running = null;
        this.state = { version: 1, paused: false, items: [] };
        if (existsSync(file)) {
            const saved = JSON.parse(readFileSync(file, 'utf8'));
            if (saved.version !== 1 || typeof saved.paused !== 'boolean' || !Array.isArray(saved.items) || saved.items.length > 5000) throw new Error('翻译队列文件无效；已保留原文件');
            const ids = new Set();
            this.state = { version: 1, paused: saved.paused, items: saved.items.map((i) => {
                const ref = validRef(i);
                if (typeof i.id !== 'string' || ids.has(i.id) || !states.has(i.status)) throw new Error('翻译队列文件无效');
                ids.add(i.id);
                // An interrupted document restarts through the engine's cache and output check.
                return { ...ref, id: i.id, ...(i.automatic === true ? { automatic: true, ...(/^[a-f0-9]{64}$/.test(i.sourceSignature || '') ? { sourceSignature: i.sourceSignature } : {}) } : {}), status: i.status === 'running' ? 'queued' : i.status, force: i.status !== 'running' && i.force === true, createdAt: i.createdAt, ...(i.status === 'failed' ? { error: typeof i.error === 'string' && i.error.startsWith('上游翻译服务连续返回 5xx') ? '上游翻译服务连续返回 5xx（如 502），队列已暂停；请确认服务恢复后手动继续' : '翻译未完成，请检查文件和端点后重试' } : {}) };
            }) };
        }
        this.lockFile = file + '.lock';
        this.owner = { version: 1, pid: process.pid, token: randomUUID() };
        mkdirSync(dirname(file), { recursive: true });
        try {
            writeFileSync(this.lockFile, JSON.stringify(this.owner), { flag: 'wx', mode: 0o600 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            let old;
            try { old = JSON.parse(readFileSync(this.lockFile, 'utf8')); } catch { throw new Error('队列 owner 文件异常，原文件已保留'); }
            if (old.version !== 1 || !Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.token !== 'string') throw new Error('队列 owner 文件异常');
            let alive = true;
            try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
            if (alive) throw new Error('翻译队列已被另一个 owner 占用');
            // Remove only a verified, dead owner's lock, never a queue/data file.
            if (JSON.parse(readFileSync(this.lockFile, 'utf8')).token !== old.token) throw new Error('队列 owner 已改变');
            unlinkSync(this.lockFile);
            writeFileSync(this.lockFile, JSON.stringify(this.owner), { flag: 'wx', mode: 0o600 });
        }
        this.ownsLock = true;
        this.releaseLock = () => {
            if (!this.ownsLock) return;
            try { if (JSON.parse(readFileSync(this.lockFile, 'utf8')).token === this.owner.token) unlinkSync(this.lockFile); } catch { /* Retain uncertain ownership. */ }
            this.ownsLock = false;
        };
        process.once('exit', this.releaseLock);
    }
    persist() {
        if (!this.ownsLock) throw new Error('队列 owner 已释放');
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        writeFileSync(tmp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, this.file);
    }
    snapshot() { return structuredClone(this.state); }
    enqueue(refs, { force = false, automatic = false } = {}) {
        if (this.stopped) throw new Error('翻译队列正在停止');
        if (!Array.isArray(refs) || !refs.length || refs.length > 500) throw new Error('每次请选择 1–500 篇文献');
        const normalized = refs.map(ref => ({ ...validRef(ref), ...(automatic && /^[a-f0-9]{64}$/.test(ref.sourceSignature || '') ? { sourceSignature: ref.sourceSignature } : {}) }));
        const previous = this.snapshot();
        const added = [];
        for (const ref of normalized) {
            const old = this.state.items.find(i => (ref.paperId && i.paperId ? i.paperId === ref.paperId : !ref.paperId && !i.paperId && i.topic === ref.topic && i.name === ref.name) && ['queued', 'running'].includes(i.status));
            if (old) continue;
            const item = { ...ref, id: randomUUID(), status: 'queued', force, ...(automatic ? { automatic: true } : {}), createdAt: new Date().toISOString() };
            this.state.items.push(item); added.push(item.id);
        }
        if (this.state.items.length > 5000) { this.state = previous; throw new Error('队列已满，请先清理完成记录'); }
        try { this.persist(); } catch (error) { this.state = previous; throw error; }
        this.kick();
        return { added, ...this.snapshot() };
    }
    pause() { this.state.paused = true; this.persist(); }
    resume() { if (this.stopped) return; this.state.paused = false; this.persist(); this.kick(); }
    retry(id) {
        const item = this.state.items.find(i => i.id === id);
        if (!item || item.status !== 'failed') throw new Error('只能重试失败任务');
        item.status = 'queued'; delete item.error; this.persist(); this.kick();
    }
    clearFinished(verifiedIds = []) {
        this.removeVerifiedFinished(verifiedIds);
    }
    removeVerifiedFinished(ids) {
        const selected = new Set(ids);
        const previous = this.state.items;
        this.state.items = previous.filter(i => !selected.has(i.id) || !['done', 'skipped'].includes(i.status));
        if (this.state.items.length === previous.length) return;
        try { this.persist(); } catch (error) { this.state.items = previous; throw error; }
    }
    kick() {
        if (this.running || this.stopped || this.state.paused) return;
        this.running = Promise.resolve().then(() => this.drain()).finally(() => { this.running = null; });
        // Keep a failed disk write visible, but never launch another unpersisted job.
        this.running.catch(() => { this.state.paused = true; });
    }
    async drain() {
        while (!this.stopped && !this.state.paused) {
            const item = this.state.items.find(i => i.status === 'queued');
            if (!item) break;
            item.status = 'running'; this.persist();
            const abort = new AbortController(); this.active = abort;
            try {
                const result = await this.execute(structuredClone(item), abort.signal);
                const status = typeof result === 'object' && result ? result.status : result;
                item.status = this.stopped ? 'queued' : status === 'skipped' ? 'skipped' : 'done';
                // Only the host's post-write PDF validation can authorize automatic removal.
                if (!this.stopped && result?.verified === true && ['done', 'skipped'].includes(status)) {
                    this.state.items = this.state.items.filter(i => i.id !== item.id);
                }
            } catch (error) {
                item.status = this.stopped ? 'queued' : 'failed';
                if (!this.stopped && error?.code === 'upstream-unavailable') {
                    item.error = '上游翻译服务连续返回 5xx（如 502），队列已暂停；请确认服务恢复后手动继续';
                    this.state.paused = true;
                } else if (!this.stopped) item.error = '翻译未完成，请检查文件和端点后重试';
            } finally {
                this.active = null;
                this.persist();
            }
        }
    }
    async stop() {
        if (!this.ownsLock) return;
        this.stopped = true;
        this.active?.abort();
        try {
            if (this.running) await this.running;
            this.persist();
        } finally {
            process.removeListener('exit', this.releaseLock);
            this.releaseLock();
        }
    }
}
