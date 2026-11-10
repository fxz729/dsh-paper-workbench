// Independent, bounded tldraw document snapshots. Never open the PDF for writing.
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_INK_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 20000;
const SHAPES = new Set(['draw', 'highlight', 'geo', 'line', 'arrow', 'text']);
const URL = /(?:\b(?:https?|ftp|file|data|javascript|vbscript|blob):|\b[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)\/\/[^\s/])/i;

export class InkError extends Error {
    constructor(code) {
        super({ invalid: '墨迹数据或文件路径无效，原文件已保留', conflict: '墨迹版本已变化或正在保存，请重新读取后重试', io: '墨迹文件读写失败，请检查文件状态后重试' }[code]);
        this.name = 'InkError';
        this.code = code;
        this.status = { invalid: 400, conflict: 409, io: 500 }[code];
    }
}
const invalid = () => { throw new InkError('invalid'); };
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e9;
function keys(value, allowed) {
    if (!plain(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

// SDK 5.6 strokes store one float32 point followed by float16 deltas, as base64.
function encodedPath(path, dim = 3) {
    if (typeof path !== 'string' || ![2, 3].includes(dim) || path.length > 262144) invalid();
    if (path === '') return;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(path)) invalid();
    const bytes = Buffer.from(path, 'base64');
    if (bytes.toString('base64') !== path || bytes.length < dim * 4 || (bytes.length - dim * 4) % (dim * 2)) invalid();
    const coords = [];
    for (let i = 0; i < dim; i++) {
        coords[i] = bytes.readFloatLE(i * 4);
        if (!finite(coords[i])) invalid();
    }
    for (let offset = dim * 4; offset < bytes.length; offset += dim * 2) {
        for (let i = 0; i < dim; i++) {
            const bits = bytes.readUInt16LE(offset + i * 2);
            const exponent = (bits >> 10) & 31, fraction = bits & 1023;
            if (exponent === 31) invalid();
            const delta = (bits & 32768 ? -1 : 1) * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
            coords[i] += delta;
            if (!finite(coords[i])) invalid();
        }
    }
}

// Validate before stringify: JSON.stringify would silently erase undefined and turn NaN into null.
function boundedJson(value) {
    const seen = new Set();
    const trail = [];
    let nodes = 0, bytes = 0;
    function visit(v, depth, safeLiteral = false) {
        if (++nodes > 300000 || depth > 32) invalid();
        if (v === null || typeof v === 'boolean') return;
        if (typeof v === 'number') { if (!finite(v)) invalid(); return; }
        if (typeof v === 'string') {
            bytes += Buffer.byteLength(v, 'utf8');
            if (v.length > 262144 || bytes > MAX_INK_BYTES || (!safeLiteral && URL.test(v))) invalid();
            return;
        }
        if ((!Array.isArray(v) && !plain(v)) || seen.has(v)) invalid();
        seen.add(v);
        if (Array.isArray(v)) {
            if (v.length > 100000 || Object.getPrototypeOf(v) !== Array.prototype || Object.getOwnPropertySymbols(v).length) invalid();
            const descriptors = Object.getOwnPropertyDescriptors(v);
            if (Object.keys(descriptors).length !== v.length + 1) invalid();
            for (let i = 0; i < v.length; i++) {
                const d = descriptors[i];
                if (!d || !('value' in d) || !d.enumerable) invalid();
                trail.push(i);
                visit(d.value, depth + 1);
                trail.pop();
            }
        }
        else {
            const descriptors = Object.getOwnPropertyDescriptors(v);
            const names = Object.keys(descriptors);
            if (names.length > MAX_RECORDS || Object.getOwnPropertySymbols(v).length) invalid();
            for (const key of names) {
                const d = descriptors[key];
                bytes += Buffer.byteLength(key, 'utf8');
                if (key.length > 256 || bytes > MAX_INK_BYTES || ['__proto__', 'constructor', 'prototype'].includes(key) || !('value' in d) || !d.enumerable) invalid();
                // Empty SDK URL defaults are fine; actual links, assets and bindings are outside v1.
                if (/^(?:url|href|src)$/i.test(key) && d.value !== '' && d.value !== null) invalid();
                if (/^(?:assetId|boundShapeId|bindings?)$/i.test(key) || (key === 'type' && d.value === 'binding')) invalid();
                const isPath = key === 'path' && ['free', 'straight'].includes(descriptors.type?.value);
                if (isPath) encodedPath(d.value, descriptors.dim?.value);
                // Only literal text at an actual shape.props.richText content leaf is exempt.
                // Resource fields/attrs and metadata lookalikes retain the URL prohibition;
                // richText() below separately rejects link marks and unsupported nodes.
                const isText = key === 'text' && descriptors.type?.value === 'text' && !descriptors.attrs
                    && trail.length >= 9 && trail[0] === 'pages' && trail[2] === 'snapshot'
                    && trail[3] === 'store' && /^shape:/.test(trail[4]) && trail[5] === 'props'
                    && trail[6] === 'richText' && (trail.length - 7) % 2 === 0
                    && trail.slice(7).every((part, i) => i % 2 === 0 ? part === 'content' : Number.isInteger(part));
                trail.push(key);
                visit(d.value, depth + 1, isPath || isText);
                trail.pop();
            }
        }
        seen.delete(v);
    }
    visit(value, 0);
}
function indexKey(value) {
    if (typeof value !== 'string' || !/^[A-Za-z][0-9A-Za-z]+$/.test(value) || value.length > 256) return false;
    const head = value.charCodeAt(0), integerLength = head >= 97 ? head - 97 + 2 : 90 - head + 2;
    return value.length >= integerLength && value !== 'A' + '0'.repeat(26) && (value.length === integerLength || !value.endsWith('0'));
}
function richText(value) {
    keys(value, ['type', 'content', 'attrs']);
    if (value.type !== 'doc' || !Array.isArray(value.content)) invalid();
    const nodes = new Set(['paragraph', 'text', 'hardBreak', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'horizontalRule']);
    const marks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'textStyle']);
    function node(v) {
        keys(v, ['type', 'content', 'attrs', 'text', 'marks']);
        if (!nodes.has(v.type) || (v.type === 'text' && typeof v.text !== 'string') || ('text' in v && typeof v.text !== 'string')) invalid();
        if ('marks' in v) {
            if (!Array.isArray(v.marks)) invalid();
            for (const mark of v.marks) { keys(mark, ['type', 'attrs']); if (!marks.has(mark.type)) invalid(); }
        }
        if ('content' in v) { if (!Array.isArray(v.content)) invalid(); for (const child of v.content) node(child); }
    }
    for (const child of value.content) node(child);
}
function shapeProps(type, props) {
    // This v1 subset is pinned to the approved SDK 5.6 default shapes; no runtime SDK dependency.
    const colors = ['black', 'grey', 'light-violet', 'violet', 'blue', 'light-blue', 'yellow', 'orange', 'green', 'light-green', 'light-red', 'red', 'white'];
    const common = { color: colors, size: ['s', 'm', 'l', 'xl'], scale: 'nonzero' };
    const dash = ['draw', 'solid', 'dashed', 'dotted', 'none'], fill = ['none', 'semi', 'solid', 'pattern', 'fill', 'lined-fill'];
    const font = ['draw', 'sans', 'serif', 'mono'], align = ['start', 'middle', 'end'];
    const label = { labelColor: colors, fill, font, richText };
    const heads = ['arrow', 'triangle', 'square', 'dot', 'pipe', 'diamond', 'inverted', 'bar', 'none'];
    function point(v) { keys(v, ['x', 'y', 'z']); if (!finite(v.x) || !finite(v.y) || ('z' in v && !finite(v.z))) invalid(); }
    function segments(v) {
        if (!Array.isArray(v) || v.length > 10000) invalid();
        for (const segment of v) { keys(segment, ['type', 'path', 'dim']); if (!['free', 'straight'].includes(segment.type)) invalid(); encodedPath(segment.path, segment.dim); }
    }
    function points(v) {
        if (!plain(v) || Object.keys(v).length < 2 || Object.keys(v).length > 10000) invalid();
        for (const [id, p] of Object.entries(v)) { keys(p, ['id', 'index', 'x', 'y']); if (p.id !== id || !indexKey(p.index) || !finite(p.x) || !finite(p.y)) invalid(); }
    }
    const schemas = {
        draw: { ...common, fill, dash, segments, isComplete: 'boolean', isClosed: 'boolean', isPen: 'boolean', scaleX: 'nonzero', scaleY: 'nonzero' },
        highlight: { ...common, segments, isComplete: 'boolean', isPen: 'boolean', scaleX: 'nonzero', scaleY: 'nonzero' },
        geo: { ...common, ...label, dash, url: [''], w: 'nonzero', h: 'nonzero', growY: 'nonnegative', flipX: 'boolean', flipY: 'boolean', geo: ['cloud', 'rectangle', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'octagon', 'star', 'rhombus', 'rhombus-2', 'oval', 'trapezoid', 'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'x-box', 'check-box', 'heart'], align: [...align, 'start-legacy', 'middle-legacy', 'end-legacy'], verticalAlign: align },
        line: { ...common, dash, spline: ['cubic', 'line'], points },
        arrow: { ...common, ...label, dash, kind: ['arc', 'elbow'], arrowheadStart: heads, arrowheadEnd: heads, start: point, end: point, bend: 'number', labelPosition: 'number', elbowMidPoint: 'number' },
        text: { ...common, font, textAlign: align, w: 'nonzero', richText, autoSize: 'boolean' },
    };
    const schema = schemas[type];
    keys(props, Object.keys(schema));
    for (const [key, validator] of Object.entries(schema)) {
        const value = props[key];
        if (typeof validator === 'function') validator(value);
        else if (Array.isArray(validator)) { if (!validator.includes(value)) invalid(); }
        else if (validator === 'boolean') { if (typeof value !== 'boolean') invalid(); }
        else if (!finite(value) || (validator === 'nonzero' && value === 0) || (validator === 'nonnegative' && value < 0)) invalid();
    }
}
function validateDocument(document) {
    boundedJson(document);
    keys(document, ['pages']);
    if (!plain(document.pages)) invalid();
    const pages = Object.entries(document.pages);
    if (pages.length > 2000) invalid();
    let records = 0;
    for (const [number, page] of pages) {
        if (!/^[1-9]\d{0,4}$/.test(number) || Number(number) > 10000) invalid();
        keys(page, ['width', 'height', 'rotation', 'snapshot']);
        if (!finite(page.width) || page.width <= 0 || page.width > 100000 || !finite(page.height) || page.height <= 0 || page.height > 100000 || ![0, 90, 180, 270].includes(page.rotation)) invalid();
        keys(page.snapshot, ['store', 'schema']);
        const { store, schema } = page.snapshot;
        if (!plain(store)) invalid();
        keys(schema, ['schemaVersion', 'sequences']);
        if (schema.schemaVersion !== 2 || !plain(schema.sequences) || Object.keys(schema.sequences).length > 256) invalid();
        for (const version of Object.values(schema.sequences)) if (!Number.isSafeInteger(version) || version < 0) invalid();
        let documents = 0, pageCount = 0;
        for (const [id, record] of Object.entries(store)) {
            if (++records > MAX_RECORDS || !plain(record) || record.id !== id || !plain(record.meta)) invalid();
            if (record.typeName === 'document') {
                if (id !== 'document:document' || typeof record.name !== 'string' || !finite(record.gridSize) || record.gridSize <= 0) invalid();
                documents++;
            }
            else if (record.typeName === 'page') {
                if (!/^page:[\w-]+$/.test(id) || typeof record.name !== 'string' || !indexKey(record.index)) invalid();
                pageCount++;
            }
            else if (record.typeName === 'shape') {
                if (!/^shape:[\w-]+$/.test(id) || !SHAPES.has(record.type) || !plain(record.props) || !finite(record.x) || !finite(record.y) || !finite(record.rotation) || !indexKey(record.index) || typeof record.isLocked !== 'boolean' || !finite(record.opacity) || record.opacity < 0 || record.opacity > 1) invalid();
                if (typeof record.parentId !== 'string' || store[record.parentId]?.typeName !== 'page') invalid();
                shapeProps(record.type, record.props);
            }
            else invalid();
        }
        if (documents !== 1 || pageCount < 1 || pageCount > 100) invalid();
    }
    const text = JSON.stringify({ version: 1, document });
    if (Buffer.byteLength(text, 'utf8') > MAX_INK_BYTES) invalid();
    return text;
}

async function checkedPdf(ref) {
    const path = ref?.pdfPath;
    if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || extname(path).toLowerCase() !== '.pdf') invalid();
    const absolute = resolve(path);
    // The host supplies the library boundary; ancestors must stay trusted during IO.
    // Reject existing links/junctions. Node path-based IO cannot pin parents against
    // a hostile local process swapping an ancestor after this check.
    let current = absolute;
    for (;;) {
        const st = await lstat(current);
        if (st.isSymbolicLink() || (current === absolute ? !st.isFile() : !st.isDirectory())) invalid();
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return absolute;
}
async function regular(path, optional = false) {
    try {
        const st = await lstat(path);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) invalid();
        return st;
    }
    catch (e) {
        if (optional && e.code === 'ENOENT') return null;
        throw e;
    }
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const revisionOf = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function load(path) {
    const before = await regular(path, true);
    if (!before) return { revision: null, document: { pages: {} } };
    if (before.size > MAX_INK_BYTES) invalid();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const st = await handle.stat();
        if (!sameFile(before, st) || !st.isFile() || st.nlink !== 1 || st.size > MAX_INK_BYTES) invalid();
        // Bounded read even if an outside process grows/replaces the file during the read.
        const bytes = Buffer.alloc(st.size + 1);
        let count = 0;
        while (count < bytes.length) {
            const result = await handle.read(bytes, count, bytes.length - count, count);
            if (result.bytesRead === 0) break;
            count += result.bytesRead;
        }
        const after = await handle.stat();
        if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new InkError('conflict');
        const raw = bytes.subarray(0, count);
        let envelope;
        try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
        catch { invalid(); }
        keys(envelope, ['version', 'document']);
        if (envelope.version !== 1) invalid();
        validateDocument(envelope.document);
        return { revision: revisionOf(raw), document: envelope.document };
    }
    finally { await handle.close(); }
}
function safeError(error) {
    return error instanceof InkError ? error : new InkError(error?.code === 'ELOOP' ? 'invalid' : 'io');
}

export async function readInk(ref) {
    try { return await load(`${await checkedPdf(ref)}.dpr-ink.json`); }
    catch (error) { throw safeError(error); }
}

export async function writeInk(ref, request) {
    let lock, lockIdentity, temporary, tempIdentity;
    let lockPath;
    try {
        if (!plain(request) || !(request.revision === null || (typeof request.revision === 'string' && /^[a-f0-9]{64}$/.test(request.revision)))) invalid();
        const revision = request.revision;
        const pdfRef = { pdfPath: ref?.pdfPath };
        const text = validateDocument(request.document);
        // Keep a detached, validated payload before the first await (callers can mutate their input).
        const document = JSON.parse(text).document;
        const path = `${await checkedPdf(pdfRef)}.dpr-ink.json`;
        lockPath = `${path}.lock`;
        try { lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
        catch (e) {
            if (e.code === 'EEXIST') {
                // The owner may finish/unlink after EEXIST. Missing still means
                // this writer lost contention; surviving unsafe locks remain invalid.
                await regular(lockPath, true);
                throw new InkError('conflict');
            }
            throw e;
        }
        lockIdentity = await lock.stat();
        const current = await load(path);
        if (current.revision !== revision) throw new InkError('conflict');
        temporary = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
            tempIdentity = await handle.stat();
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        }
        finally { await handle.close(); }
        // Recheck immediately before replacement; bad/symlink files are never overwritten.
        await checkedPdf(pdfRef);
        const latest = await load(path);
        if (latest.revision !== current.revision) throw new InkError('conflict');
        const temp = await regular(temporary);
        if (!sameFile(temp, tempIdentity)) invalid();
        await rename(temporary, path);
        temporary = undefined;
        return { revision: revisionOf(text), document };
    }
    catch (error) { throw safeError(error); }
    finally {
        // Only remove files created by this write; never steal or age out another process's lock.
        if (temporary && tempIdentity) {
            try { const st = await lstat(temporary); if (!st.isSymbolicLink() && sameFile(st, tempIdentity)) await unlink(temporary); }
            catch { /* Leave recovery evidence if cleanup is blocked. */ }
        }
        if (lock) {
            try { await lock.close(); } catch { /* Retain the primary result. */ }
            if (lockIdentity) {
                try { const st = await lstat(lockPath); if (!st.isSymbolicLink() && sameFile(st, lockIdentity)) await unlink(lockPath); }
                catch { /* A failed cleanup becomes a visible conflict on the next save. */ }
            }
        }
    }
}
