// Shared, synchronous path boundary for the catalog and LibraryService. No mkdir/move/copy.
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export const MAX_COLLECTION_DEPTH = 32;
export const MAX_RELATIVE_CHARS = 1024;
export class CatalogError extends Error {
    constructor(code, status) {
        const messages = { invalid: '文献库路径或数据无效', conflict: '文献库版本已变化或操作正在进行，请重新读取', 'not-ready': '文献目录尚未初始化', 'not-found': '指定文献或子库不存在', gone: '该文献已移入回收站', 'paper-ref-ambiguous': '旧文献名称存在多个历史归属，请使用文献ID重新定位', 'collection-ref-ambiguous': '旧文献库名称存在多个历史归属，请使用文献库ID重新定位', 'catalog-invalid': '文献索引异常，原文件已保留，请核对后恢复', 'path-collision': '存在大小写或规范化重名，请先人工核对', io: '文献库文件读写失败，请检查文件状态' };
        super(messages[code] || messages.invalid);
        this.name = 'CatalogError'; this.code = code;
        this.status = status ?? ({ conflict: 409, 'not-ready': 503, 'not-found': 404, gone: 410, 'paper-ref-ambiguous': 409, 'collection-ref-ambiguous': 409, 'catalog-invalid': 503, 'path-collision': 409, io: 500 }[code] || 400);
    }
}
// Lowercasing can create a new composition opportunity (for example Greek diaeresis).
export const foldName = (name) => name.normalize('NFC').toLowerCase().normalize('NFC');
// Existing filesystem names have a wider compatibility envelope than newly written
// targets. Retain their exact spelling; normalization is only for collision/claim keys.
function segmentBoundary(value) {
    if (typeof value !== 'string' || value.length === 0 || !value.isWellFormed()
        || value === '.' || value === '..' || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value)
        || /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) throw new CatalogError('invalid');
    return value;
}
export function validateLegacySegment(value) {
    segmentBoundary(value);
    if (value.length > 255) throw new CatalogError('invalid');
    return value;
}
export function validateSegment(value) {
    validateLegacySegment(value);
    if (value.length > 120 || value.startsWith('.') || value.includes('..')) throw new CatalogError('invalid');
    return value;
}
function segmentList(segments, allowEmpty, validator) {
    if (!Array.isArray(segments) || (!allowEmpty && !segments.length) || segments.length > MAX_COLLECTION_DEPTH) throw new CatalogError('invalid');
    for (const segment of segments) validator(segment);
    if (segments.join('/').length > MAX_RELATIVE_CHARS) throw new CatalogError('invalid');
    return [...segments];
}
export function validateSegments(segments, { allowEmpty = false } = {}) {
    return segmentList(segments, allowEmpty, validateSegment);
}
export function validateLegacySegments(segments, { allowEmpty = false } = {}) {
    return segmentList(segments, allowEmpty, validateLegacySegment);
}
export function claimKey(segments, name) {
    validateLegacySegments(segments); validateLegacySegment(name);
    return JSON.stringify([segments.map(foldName), foldName(name)]);
}
// Stored claim components are already folded; Unicode normalization/case conversion
// may expand them past physical-name budgets. Validate their canonical representation
// and boundaries, not a second physical 255/1024-unit limit. This is not a target API.
export function validateClaimKey(key) {
    if (typeof key !== 'string' || key.length > 4096) throw new CatalogError('invalid');
    let decoded;
    try { decoded = JSON.parse(key); } catch { throw new CatalogError('invalid'); }
    if (!Array.isArray(decoded) || decoded.length !== 2 || !Array.isArray(decoded[0])
        || !decoded[0].length || decoded[0].length > MAX_COLLECTION_DEPTH) throw new CatalogError('invalid');
    for (const part of [...decoded[0], decoded[1]]) {
        segmentBoundary(part);
        if (foldName(part) !== part) throw new CatalogError('invalid');
    }
    if (JSON.stringify(decoded) !== key) throw new CatalogError('invalid');
    return key;
}
export function collectionClaimKey(segments) {
    return JSON.stringify(validateLegacySegments(segments).map(foldName));
}
export function validateCollectionClaimKey(key) {
    if (typeof key !== 'string' || key.length > 4096) throw new CatalogError('invalid');
    let decoded;
    try { decoded = JSON.parse(key); } catch { throw new CatalogError('invalid'); }
    if (!Array.isArray(decoded) || !decoded.length || decoded.length > MAX_COLLECTION_DEPTH) throw new CatalogError('invalid');
    for (const part of decoded) {
        segmentBoundary(part);
        if (foldName(part) !== part) throw new CatalogError('invalid');
    }
    if (JSON.stringify(decoded) !== key) throw new CatalogError('invalid');
    return key;
}
export function canonicalRoot(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0')) throw new CatalogError('invalid');
    try {
        const absolute = resolve(dataDir), real = realpathSync(absolute), st = lstatSync(absolute);
        if (!st.isDirectory() || st.isSymbolicLink() || foldName(real) !== foldName(absolute)) throw new CatalogError('invalid');
        // Reject existing ancestor links/junctions. Ancestors must remain trusted during IO:
        // Node path-based APIs cannot pin them against a hostile local process's later swap.
        let current = absolute;
        while (dirname(current) !== current) {
            if (lstatSync(current).isSymbolicLink()) throw new CatalogError('invalid');
            current = dirname(current);
        }
        return real;
    } catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError(e.code === 'ENOENT' ? 'not-found' : 'io'); }
}
function inside(root, path) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (!foldName(path).startsWith(foldName(prefix))) throw new CatalogError('invalid');
}
function child(parent, name, directory, allowMissing) {
    const matches = readdirSync(parent).filter((entry) => foldName(entry) === foldName(name));
    if (matches.length > 1) throw new CatalogError('path-collision');
    if (matches.length === 0) {
        if (allowMissing) return { path: join(parent, name), missing: true };
        throw new CatalogError('not-found');
    }
    const path = join(parent, matches[0]), st = lstatSync(path);
    if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) throw new CatalogError('invalid');
    const real = realpathSync(path);
    if (foldName(real) !== foldName(path)) throw new CatalogError('invalid');
    return { path: real, missing: false };
}
export function resolveCollectionPath(dataDir, segments, { allowMissingLeaf = false } = {}) {
    segments = validateLegacySegments(segments);
    if (allowMissingLeaf) validateSegment(segments.at(-1));
    try {
        const root = canonicalRoot(dataDir);
        let current = root;
        for (let i = 0; i < segments.length; i++) {
            const hit = child(current, segments[i], true, allowMissingLeaf && i === segments.length - 1);
            inside(root, hit.path); current = hit.path;
        }
        return current;
    } catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError(e.code === 'ENOENT' ? 'not-found' : 'io'); }
}
export function resolvePdfPath(dataDir, segments, name, { allowMissingLeaf = false } = {}) {
    (allowMissingLeaf ? validateSegment : validateLegacySegment)(name);
    validateLegacySegment(name + '.pdf'); // The complete physical leaf also fits 255 UTF-16 units.
    if (/-(?:en|zh|dual)$/i.test(name)) throw new CatalogError('invalid');
    try {
        const root = canonicalRoot(dataDir), dir = resolveCollectionPath(root, segments);
        const hit = child(dir, name + '.pdf', false, allowMissingLeaf);
        inside(root, hit.path);
        return hit.path;
    } catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError(e.code === 'ENOENT' ? 'not-found' : 'io'); }
}
