// Session associations are append-only catalog data; host session logs and cwd stay untouched.
import { setTimeout as delay } from 'node:timers/promises';
import { CatalogError, validateLegacySegments, validateLegacySegment } from './collection-paths.js';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ordinal = value => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000;
export function newPaperSessionId(paperId, n) {
    if (!uuid(paperId) || !ordinal(n)) throw new CatalogError('invalid');
    return `dpr-v2-${paperId}-${n}`;
}
export function parsePaperSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length > 8192) return null;
    const stable = /^dpr-v2-([0-9a-f-]{36})-([1-9][0-9]*)$/.exec(sessionId);
    if (stable) return uuid(stable[1]) && ordinal(Number(stable[2])) ? { paperId: stable[1], n: Number(stable[2]) } : null;
    if (!sessionId.startsWith('dpr-')) return null;
    const body = sessionId.slice(4), found = [];
    const decode = (encoded, n) => {
        try {
            if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !ordinal(n)) return;
            const bytes = Buffer.from(encoded, 'base64url');
            if (bytes.toString('base64url') !== encoded) return;
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes), split = decoded.lastIndexOf('/');
            if (split <= 0 || split === decoded.length - 1) return;
            const topic = decoded.slice(0, split), name = decoded.slice(split + 1);
            validateLegacySegments(topic.split('/')); validateLegacySegment(name);
            found.push({ topic, name, n });
        } catch { /* Unrecognized legacy format has no authority to claim a paper. */ }
    };
    decode(body, 1);
    const suffix = /^(.*)-([1-9][0-9]*)$/.exec(body);
    if (suffix) decode(suffix[1], Number(suffix[2]));
    return found.length === 1 ? found[0] : null;
}
export async function bindPaperSessions(catalog, rows) {
    if (!Array.isArray(rows) || rows.length > 100_000) throw new CatalogError('invalid');
    for (let attempt = 0; attempt < 12; attempt++) {
        const snapshot = catalog.snapshot(), changes = {}, needsReview = [];
        for (const row of rows) {
            const sid = row?.sessionId;
            if (typeof sid !== 'string' || Object.hasOwn(snapshot.sessionBindings, sid)) continue;
            const decoded = parsePaperSessionId(sid);
            if (!decoded) continue;
            try { changes[sid] = catalog.resolvePaper(decoded).paperId; }
            catch (e) {
                if (e.code === 'paper-ref-ambiguous') needsReview.push(sid);
                else if (!['not-found', 'gone'].includes(e.code)) throw e;
            }
        }
        const bound = Object.keys(changes);
        if (!bound.length) return { bound, needsReview };
        try {
            await catalog.transact(snapshot.revision, draft => {
                for (const [sid, id] of Object.entries(changes)) {
                    if (Object.hasOwn(draft.sessionBindings, sid) && draft.sessionBindings[sid] !== id) throw new CatalogError('conflict');
                    draft.sessionBindings[sid] = id;
                }
            });
            return { bound, needsReview };
        } catch (e) {
            if (e.code !== 'conflict' || attempt === 11) throw e;
            await delay(5 * (attempt + 1));
        }
    }
}
export function listBoundPaperSessions(catalog, rows, paperId) {
    if (!uuid(paperId) || !Array.isArray(rows)) throw new CatalogError('invalid');
    const { sessionBindings } = catalog.snapshot(), unique = new Map();
    for (const row of rows) {
        if (sessionBindings[row?.sessionId] !== paperId || unique.has(row.sessionId)) continue;
        const parsed = parsePaperSessionId(row.sessionId);
        unique.set(row.sessionId, { sessionId: row.sessionId, n: parsed?.n ?? 1,
            running: row.running === true, blank: row.blank === true,
            ...(typeof row.updatedAt === 'string' || typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}) });
    }
    const out = [...unique.values()].sort((a, b) => a.n - b.n || a.sessionId.localeCompare(b.sessionId));
    const occupied = new Set(out.map(row => row.n));
    let next = Math.max(0, ...occupied) + 1;
    const used = new Set();
    for (const row of out) {
        if (used.has(row.n)) { while (occupied.has(next)) next++; row.n = next++; }
        used.add(row.n);
    }
    return out.sort((a, b) => a.n - b.n);
}
