// Local-only PDF checks. Never start OCR, translation, or any network fallback.
import { lstat, open, realpath, mkdir, rename, unlink, link } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, parse, join, extname, dirname, basename } from 'node:path';
const cache = new Map();
const healthLocks = new Map();
const MAX_BYTES = 256 * 1024 * 1024;
const signature = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
async function safeNode(file) {
    const absolute = resolve(file);
    const root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        const st = await lstat(current, { bigint: true });
        if (st.isSymbolicLink()) throw Object.assign(new Error('Linked PDF rejected'), { code: 'LINK' });
    }
    const st = await lstat(absolute, { bigint: true });
    // Catch junction/reparse redirection as well as explicit symbolic links.
    if (resolve(await realpath(absolute)).toLowerCase() !== absolute.toLowerCase()) throw Object.assign(new Error('Redirected PDF rejected'), { code: 'LINK' });
    return st;
}
async function safeStat(file) {
    const st = await safeNode(file);
    if (!st.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'LINK' });
    return st;
}
async function safeDirectory(dir) {
    if (!(await safeNode(dir)).isDirectory()) throw new Error('Not a safe directory');
}
// Fresh streaming hash for financial authority checks; no exists-only or stat-only shortcut.
export async function sourceFingerprint(ref) {
    if (typeof ref?.pdfPath !== 'string') return null;
    let handle;
    try {
        const before = await safeStat(ref.pdfPath);
        if (before.size > BigInt(MAX_BYTES)) return null;
        const key = signature(before);
        handle = await open(ref.pdfPath, 'r');
        if (signature(await handle.stat({bigint:true})) !== key) return null;
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({autoClose:false})) hash.update(chunk);
        if (signature(await handle.stat({bigint:true})) !== key || signature(await safeStat(ref.pdfPath)) !== key) return null;
        return hash.digest('hex');
    } catch { return null; }
    finally { await handle?.close().catch(() => {}); }
}
function relationPath(ref) {
    const stem = basename(ref.pdfPath, extname(ref.pdfPath));
    const dir = join(dirname(resolve(ref.pdfPath)), '.dpr-health');
    return { dir, file:join(dir, createHash('sha256').update(stem).digest('hex') + '.json') };
}
async function readRelationship(ref) {
    const location = relationPath(ref);
    try { await safeDirectory(location.dir); }
    catch (e) { if (e.code === 'ENOENT') return {...location, old:null}; throw e; }
    let handle;
    try {
        let st;
        try { st = await safeStat(location.file); }
        catch (e) { if (e.code === 'ENOENT') return {...location, old:null}; throw e; }
        if (st.size > 65536n) throw new Error('Invalid health metadata');
        handle = await open(location.file,'r');
        if (signature(await handle.stat({bigint:true})) !== signature(st)) throw new Error('Changed health metadata');
        const old = JSON.parse(await handle.readFile('utf8'));
        if (signature(await safeStat(location.file)) !== signature(st)) throw new Error('Changed health metadata');
        const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
        if (old.version !== 1 || !hash(old.source) || !Array.isArray(old.outputs) || old.outputs.length !== 2 || !old.outputs.every(v => hash(v) || ['missing','invalid','unknown'].includes(v))) throw new Error('Invalid health metadata');
        return {...location, old};
    } finally { await handle?.close().catch(() => {}); }
}
async function saveRelationship(location, relationship, {exclusive = false} = {}) {
    let tmp, handle;
    try {
        await safeDirectory(dirname(location.dir));
        try { await mkdir(location.dir, {mode:0o700}); } catch (e) { if(e.code !== 'EEXIST') throw e; }
        await safeDirectory(location.dir);
        try { await safeStat(location.file); } catch(e) { if(e.code !== 'ENOENT') throw e; }
        tmp = join(location.dir, '.' + randomUUID() + '.tmp');
        handle = await open(tmp,'wx',0o600);
        await handle.writeFile(JSON.stringify({version:1,...relationship}),'utf8');
        await handle.sync(); await handle.close(); handle = null;
        await safeDirectory(location.dir);
        try { await safeStat(location.file); } catch(e) { if(e.code !== 'ENOENT') throw e; }
        if (exclusive) {
            // Atomic no-clobber publication: unlike rename, link cannot replace an existing target.
            await link(tmp,location.file); await unlink(tmp); tmp = null;
        } else { await rename(tmp,location.file); tmp = null; }
    } finally {
        await handle?.close().catch(() => {});
        if(tmp) { try { await safeDirectory(location.dir); await unlink(tmp); } catch {} }
    }
}
// Called by host before same-topic PDF rename. Keep the old record as a conservative recovery trail.
export async function preserveTranslationHealth(ref, newName) {
    if (typeof ref?.pdfPath !== 'string' || typeof newName !== 'string' || !newName || newName.length > 240 || newName !== newName.trim() || newName.startsWith('.') || newName.includes('..') || /[\\/\x00-\x1f\x7f]/.test(newName)) throw new Error('文献名称无效');
    const key = resolve(ref.pdfPath);
    const previous = healthLocks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        await safeStat(ref.pdfPath);
        const old = await readRelationship(ref);
        if (!old.old) return;
        const target = relationPath({pdfPath:join(dirname(key),newName + extname(key))});
        if (target.file === old.file) return;
        await saveRelationship(target,old.old,{exclusive:true});
    }).catch(() => { throw new Error('无法保留译本健康记录，请检查元数据或目标名称冲突'); });
    healthLocks.set(key,task);
    try { await task; }
    finally { if (healthLocks.get(key) === task) healthLocks.delete(key); }
}
async function localPDF(file) {
    let before;
    try { before = await safeStat(file); }
    catch (e) { return { state: e.code === 'ENOENT' ? 'missing' : e.code === 'LINK' ? 'invalid' : 'unknown' }; }
    const key = signature(before);
    const old = cache.get(file);
    if (old?.key === key) return old.value;
    let value;
    if (before.size < 8n) value = { state: 'invalid' };
    else if (before.size > BigInt(MAX_BYTES)) value = { state: 'unknown' };
    else {
        let handle, task;
        try {
            handle = await open(file, 'r');
            if (signature(await handle.stat({ bigint: true })) !== key) return { state: 'unknown' };
            const data = new Uint8Array(await handle.readFile());
            const fingerprint = createHash('sha256').update(data).digest('hex');
            if (!Buffer.from(data.subarray(0, 1024)).includes(Buffer.from('%PDF-'))) value = { state: 'invalid' };
            else {
                let engine;
                try { engine = await import('pdfjs-dist/legacy/build/pdf.mjs'); }
                catch { return { state: 'unknown' }; }
                task = engine.getDocument({ data, disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
                const doc = await task.promise;
                if (!Number.isInteger(doc.numPages) || doc.numPages < 1) throw new Error('No pages');
                const texts = [];
                // Endpoints validate actual page content; first three pages provide conservative language evidence.
                for (const n of new Set([1, Math.min(2, doc.numPages), Math.min(3, doc.numPages), doc.numPages])) {
                    const page = await doc.getPage(n);
                    await page.getOperatorList();
                    const content = await page.getTextContent();
                    texts.push(content.items.map(i => typeof i.str === 'string' ? i.str : '').join(' '));
                    page.cleanup();
                }
                value = { state: 'valid', text: texts.join('\n'), fingerprint };
            }
        } catch (e) {
            value = { state: ['InvalidPDFException', 'FormatError'].includes(e?.name) || /No pages/.test(e?.message || '') ? 'invalid' : 'unknown' };
        } finally {
            await task?.destroy().catch(() => {});
            await handle?.close().catch(() => {});
        }
    }
    try { if (signature(await safeStat(file)) !== key) return { state: 'unknown' }; }
    catch { return { state: 'unknown' }; }
    value.statSignature = key;
    cache.set(file, { key, value });
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return value;
}
export async function translationHealth(ref, {expectedSourceSignature} = {}) {
    if (typeof ref?.pdfPath !== 'string') return {state:'unknown',zh:false,dual:false};
    const key = resolve(ref.pdfPath);
    const previous = healthLocks.get(key) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => inspectTranslation(ref, expectedSourceSignature));
    healthLocks.set(key,task);
    try { return await task; }
    finally { if (healthLocks.get(key) === task) healthLocks.delete(key); }
}
async function inspectTranslation(ref, expectedSourceSignature) {
    const result = { state: 'unknown', zh: false, dual: false };
    if (typeof ref?.pdfPath !== 'string' || (expectedSourceSignature !== undefined && !/^[a-f0-9]{64}$/.test(expectedSourceSignature))) return result;
    const original = await localPDF(ref.pdfPath);
    if (original.state !== 'valid') return result;
    const source = original.fingerprint;
    // Listing polls reuse the parsed SHA256 only while full stat identity is unchanged.
    // Fresh byte hashing remains mandatory at watcher/queue financial authority gates.
    const stableSource = async () => {
        try { return signature(await safeStat(ref.pdfPath)) === original.statSignature; }
        catch { return false; }
    };
    let location;
    try { location = await readRelationship(ref); } catch { return result; }
    const stem = ref.pdfPath.slice(0, -extname(ref.pdfPath).length);
    const [zh, dual] = await Promise.all([localPDF(stem + '-zh.pdf'), localPDF(stem + '-dual.pdf')]);
    result.zh = zh.state === 'valid'; result.dual = dual.state === 'valid';
    if (result.zh || result.dual) {
        const old = location.old;
        const outputs = [zh.fingerprint || zh.state, dual.fingerprint || dual.state];
        // Source byte changes are conservative (including annotations), but mtime-only touches are not.
        // A genuinely rebuilt readable output establishes a fresh relationship.
        const rebuilt = old && outputs.some((value, i) => value !== old.outputs[i] && [zh, dual][i].state === 'valid');
        const relationshipSource = expectedSourceSignature || source;
        result.state = expectedSourceSignature ? (expectedSourceSignature === source ? 'translated' : 'stale') : old && old.source !== source && !rebuilt ? 'stale' : 'translated';
        if (!await stableSource()) return {state:'unknown',zh:false,dual:false};
        if ((result.state === 'translated' || expectedSourceSignature) && (!old || old.source !== relationshipSource || outputs.some((v,i) => old.outputs[i] !== v))) {
            try { await saveRelationship(location, {source:relationshipSource,outputs}); }
            catch { return {state:'unknown',zh:result.zh,dual:result.dual}; }
        }
        if (!await stableSource()) return {state:'unknown',zh:false,dual:false};
    } else result.state = [zh.state, dual.state].includes('unknown') ? 'unknown' : [zh.state, dual.state].includes('invalid') ? 'invalid' : 'missing';
    return result;
}
export async function detectPaperLanguage(ref) {
    if (typeof ref?.pdfPath !== 'string') return 'unknown';
    const pdf = await localPDF(ref.pdfPath);
    if (pdf.state !== 'valid') return 'unknown';
    const text = pdf.text.normalize('NFKC');
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 300) return 'unknown';
    const ascii = letters.filter(c => /[a-z]/i.test(c)).length / letters.length;
    if (ascii < 0.7) return 'other';
    const words = text.toLowerCase().match(/[a-z]+/g) || [];
    const common = new Set('the of and to in is for that with as are this we be by an on from which these have has was were not can our it its a at or their using'.split(' '));
    const hits = words.filter(w => common.has(w));
    if (ascii >= 0.97 && words.length >= 60 && hits.length / words.length >= 0.12 && new Set(hits).size >= 9) return 'english';
    return 'unknown';
}
