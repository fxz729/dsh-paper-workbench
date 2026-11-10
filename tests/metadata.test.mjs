import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const require = createRequire(import.meta.url);

const moduleUrl = new URL('../dist/paper-metadata.js', import.meta.url);
// Dynamic import makes RED an assertion about the missing public contract.
const metadata = await import(moduleUrl).catch(() => ({}));
const { readCollectionMetadata: readC, writeCollectionMetadata: writeC,
    readPaperMetadata: readP, writePaperMetadata: writeP,
    writePaperCandidate: candidate, applyPaperCandidate: apply } = metadata;
const id = randomUUID();
const invalid = { code: 'invalid', status: 400 };
const conflict = { code: 'conflict', status: 409 };
const metaPath = (root, kind = 'paper') => join(root, '.dpr-paper-meta', kind, `${id}.json`);
async function fixture(t) {
    const root = await fs.mkdtemp(join(tmpdir(), 'dpr-meta-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
const request = (extra = {}) => ({ expectedRevision: null, summaryText: 'API text',
    bibliography: { firstAuthor: 'Ada Lovelace', hasMoreAuthors: true, year: '2026', originalTitle: 'Title' },
    sourceSignature: 'sha256:test', model: 'test-model', operationId: 'op-one', ...extra });

test('exports the six frozen async functions', () => {
    for (const name of ['readCollectionMetadata', 'writeCollectionMetadata', 'readPaperMetadata',
        'writePaperMetadata', 'writePaperCandidate', 'applyPaperCandidate']) assert.equal(typeof metadata[name], 'function', name);
});

test('UUID collection note CAS, detached reads and text URLs', async t => {
    const root = await fixture(t);
    assert.deepEqual(await readC(root, id), { revision: null, note: '', updatedAt: null });
    const saved = await writeC(root, id, { revision: null, note: '说明 https://example.test <b>text</b>' });
    assert.match(saved.revision, /^[a-f0-9]{64}$/);
    assert.ok(saved.updatedAt);
    assert.equal(saved.note, '说明 https://example.test <b>text</b>');
    assert.equal(saved.revision, createHash('sha256').update(await fs.readFile(metaPath(root, 'collection'))).digest('hex'));
    saved.note = 'caller mutation';
    assert.equal((await readC(root, id)).note, '说明 https://example.test <b>text</b>');
    await assert.rejects(writeC(root, id, { revision: null, note: 'stale' }), conflict);
    const next = await writeC(root, id, { revision: saved.revision, note: '' }, 'model');
    assert.equal(next.note, '');
});

test('paper defaults and trusted manual/model source; bibliography-only preserves summary', async t => {
    const root = await fixture(t);
    assert.deepEqual(await readP(root, id), { revision: null, summary: { text: '', source: 'empty', updatedAt: null }, bibliography: {}, candidate: null });
    const manual = await writeP(root, id, { revision: null, summaryText: 'hand written' });
    assert.equal(manual.summary.source, 'manual');
    const model = await writeP(root, id, { revision: manual.revision, summaryText: 'model text' }, 'model');
    assert.equal(model.summary.source, 'model');
    const bib = await writeP(root, id, { revision: model.revision, bibliography: { year: '2026' } });
    assert.deepEqual(bib.summary, model.summary);
    assert.deepEqual(bib.bibliography, { year: '2026' });
    await assert.rejects(writeP(root, id, { revision: bib.revision, source: 'api', summaryText: 'forged' }), invalid);
    await assert.rejects(writeP(root, id, { revision: bib.revision, summaryText: 'api' }, 'api'), invalid);
});

test('API candidates protect manual/model even at matching revision and late revision; apply once explicitly', async t => {
    const root = await fixture(t);
    const start = await writeP(root, id, { revision: null, summaryText: 'manual' });
    let saved = await candidate(root, id, request({ expectedRevision: start.revision }));
    assert.equal(saved.summary.text, 'manual');
    assert.equal(saved.candidate.summaryText, 'API text');
    const model = await writeP(root, id, { revision: saved.revision, summaryText: 'model edit' }, 'model');
    saved = await candidate(root, id, request({ expectedRevision: start.revision, operationId: 'late' }));
    assert.equal(saved.summary.text, 'model edit');
    assert.equal(saved.summary.source, 'model');
    assert.equal(saved.candidate.operationId, 'late');
    await assert.rejects(apply(root, id, { revision: model.revision, operationId: 'late' }), conflict);
    const adopted = await apply(root, id, { revision: saved.revision, operationId: 'late' });
    assert.equal(adopted.summary.text, 'API text');
    assert.equal(adopted.summary.source, 'api');
    assert.equal(adopted.summary.sourceSignature, 'sha256:test');
    assert.equal(adopted.candidate, null);
    await assert.rejects(apply(root, id, { revision: adopted.revision, operationId: 'late' }), conflict);
});

test('API is candidate-only even on empty; repeated operation preserves later manual content', async t => {
    const root = await fixture(t);
    const first = await candidate(root, id, request());
    assert.equal(first.summary.source, 'empty');
    assert.deepEqual(first.bibliography, {});
    assert.equal(first.candidate.summaryText, 'API text');
    const second = await writeP(root, id, { revision: first.revision, summaryText: '' });
    const replay = await candidate(root, id, request());
    assert.equal(replay.revision, second.revision);
    assert.equal(replay.summary.source, 'manual');
    assert.equal(replay.summary.text, '');
    await assert.rejects(candidate(root, id, request({ summaryText: 'different payload' })), conflict);
});

test('candidate baseRevision is captured internally and detects bibliography-only late results', async t => {
    const root = await fixture(t);
    const first = await candidate(root, id, request());
    assert.equal(first.candidate.baseRevision, null);
    // An empty/api summary alone is insufficient for automatic adoption after any edit.
    const formal = await apply(root, id, { revision: first.revision, operationId: 'op-one' });
    const planRevision = formal.revision;
    const edited = await writeP(root, id, { revision: planRevision, bibliography: { year: '2024' } });
    const late = await candidate(root, id, request({ expectedRevision: planRevision, operationId: 'late-bibliography' }));
    assert.equal(late.summary.source, 'api');
    assert.deepEqual(late.summary, formal.summary);
    assert.deepEqual(late.bibliography, { year: '2024' });
    assert.equal(late.candidate.expectedRevision, planRevision);
    assert.equal(late.candidate.baseRevision, edited.revision);
    assert.notEqual(late.candidate.baseRevision, late.candidate.expectedRevision);
    assert.equal((await readP(root, id)).candidate.baseRevision, edited.revision);
    await assert.rejects(candidate(root, id, request({ baseRevision: late.revision, operationId: 'forged-base' })), invalid);
});

test('snapshots nested input before first await', async t => {
    const root = await fixture(t);
    const input = { revision: null, summaryText: 'original', bibliography: { year: '2026' } };
    const pending = writeP(root, id, input);
    input.summaryText = 'mutated'; input.bibliography.year = '1999';
    const saved = await pending;
    assert.equal(saved.summary.text, 'original');
    assert.equal(saved.bibliography.year, '2026');
    const req = request({ expectedRevision: saved.revision });
    const candidatePending = candidate(root, id, req);
    req.bibliography.firstAuthor = 'changed';
    assert.equal((await candidatePending).candidate.bibliography.firstAuthor, 'Ada Lovelace');
});

test('rejects invalid UUID, unknown fields, cyclic/accessor/non-JSON input and malformed Unicode', async t => {
    const root = await fixture(t);
    for (const bad of ['../a', '', 'a'.repeat(36), `${id}/x`, '{' + id + '}']) await assert.rejects(readP(root, bad), invalid);
    const cycle = {}; cycle.self = cycle;
    const getter = { revision: null }; Object.defineProperty(getter, 'summaryText', { enumerable: true, get() { throw Error('must not execute'); } });
    for (const patch of [cycle, getter, { revision: null, x: 1 }, { revision: null, summaryText: undefined },
        { revision: null, summaryText: '\ud800' }, { revision: null, summaryText: '\u0000' },
        { revision: null, bibliography: { year: 2026 } }, { revision: null, bibliography: { year: '26' } },
        { revision: null, bibliography: { apiKey: 'secret' } }, { revision: null, bibliography: new Date() },
        { revision: null, [Symbol('hidden')]: true }, { revision: null, bibliography: { firstAuthor: 'a'.repeat(1025) } }])
        await assert.rejects(writeP(root, id, patch), invalid);
    await assert.rejects(candidate(root, id, request({ provider: 'secret' })), invalid);
    await assert.rejects(candidate(root, id, request({ bibliography: { source: 'api' } })), invalid);
    await assert.rejects(writeC(root, id, { revision: null, note: 'x'.repeat(16385) }), invalid);
    await assert.rejects(writeP(root, id, { revision: null, summaryText: 'x'.repeat(65537) }), invalid);
    await assert.rejects(readP(root, id.toUpperCase() + ' '), invalid);
    assert.equal((await readP(root, id)).revision, null);
});

test('bad JSON, schema, UTF-8, oversized files remain byte-identical on read/write failure', async t => {
    const root = await fixture(t);
    await fs.mkdir(join(root, '.dpr-paper-meta', 'paper'), { recursive: true });
    for (const bytes of [Buffer.from('{bad'), Buffer.from('{"version":1,"unknown":true}'),
        Buffer.from([0xff, 0xfe, 0x00]), Buffer.alloc(256 * 1024 + 1, 32)]) {
        await fs.writeFile(metaPath(root), bytes);
        await assert.rejects(readP(root, id), invalid);
        await assert.rejects(writeP(root, id, { revision: null, summaryText: 'overwrite' }), invalid);
        assert.deepEqual(await fs.readFile(metaPath(root)), bytes);
    }
});

test('whole envelope quota includes summary plus candidate and leaves previous revision intact', async t => {
    const root = await fixture(t);
    const saved = await writeP(root, id, { revision: null, summaryText: '中'.repeat(64000) });
    await assert.rejects(candidate(root, id, request({ expectedRevision: saved.revision, summaryText: '中'.repeat(64000) })), invalid);
    assert.deepEqual(await readP(root, id), saved);
});

test('bibliography ABA advances revision even after original content is restored', async t => {
    const root = await fixture(t);
    const a = await writeP(root, id, { revision: null, bibliography: { year: '2024' } });
    const b = await writeP(root, id, { revision: a.revision, bibliography: { year: '2025' } });
    const restored = await writeP(root, id, { revision: b.revision, bibliography: { year: '2024' } });
    assert.notEqual(restored.revision, a.revision);
    const bytes = await fs.readFile(metaPath(root));
    await assert.rejects(writeP(root, id, { revision: a.revision, bibliography: { year: '1999' } }), conflict);
    assert.deepEqual(await fs.readFile(metaPath(root)), bytes);
});

for (const kind of ['collection', 'summary']) test(`${kind} ABA remains conflicting under a fixed millisecond clock`, async t => {
    const root = await fixture(t), RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : ['2026-11-09T00:00:00.000Z'])); }
        static now() { return 1794182400000; }
    };
    try {
        const write = kind === 'collection' ? writeC : writeP;
        const field = kind === 'collection' ? 'note' : 'summaryText';
        const a = await write(root, id, { revision: null, [field]: 'A' });
        const b = await write(root, id, { revision: a.revision, [field]: 'B' });
        const restored = await write(root, id, { revision: b.revision, [field]: 'A' });
        assert.notEqual(restored.revision, a.revision);
        const path = metaPath(root, kind === 'collection' ? 'collection' : 'paper');
        const bytes = await fs.readFile(path);
        await assert.rejects(write(root, id, { revision: a.revision, [field]: 'stale' }), conflict);
        assert.deepEqual(await fs.readFile(path), bytes);
    } finally { globalThis.Date = RealDate; }
});

test('exclusive same-process CAS accepts exactly one writer and releases own lock', async t => {
    const root = await fixture(t);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => writeC(root, id, { revision: null, note: String(i) })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    for (const r of results.filter(r => r.status === 'rejected')) assert.equal(r.reason.code, 'conflict');
    const current = await readC(root, id);
    await writeC(root, id, { revision: current.revision, note: 'after contention' });
    assert.deepEqual((await fs.readdir(join(root, '.dpr-paper-meta', 'collection'))).sort(), [`${id}.json`]);
});

function child(code) {
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = ''; p.stdout.on('data', b => out += b); p.stderr.on('data', b => err += b);
        p.on('error', reject); p.on('close', status => status === 0 ? resolve(out.trim()) : reject(Error(err)));
    });
}
test('cross-process lock enforces CAS and retains a preexisting owner lock', async t => {
    const root = await fixture(t);
    await writeC(root, id, { revision: null, note: 'initial' });
    const before = await readC(root, id);
    const code = `import {writeCollectionMetadata as w} from ${JSON.stringify(moduleUrl.href)};try {await w(${JSON.stringify(root)},${JSON.stringify(id)},${JSON.stringify({ revision: before.revision, note: 'child' })}); console.log('ok')}catch(e){if(e.code !== 'conflict')throw e; console.log(e.code)}`;
    const results = await Promise.all([child(code), child(code), child(code)]);
    assert.equal(results.filter(x => x === 'ok').length, 1);
    const path = metaPath(root, 'collection'); await fs.writeFile(path + '.lock', 'other-process');
    await assert.rejects(writeC(root, id, { revision: (await readC(root, id)).revision, note: 'blocked' }), conflict);
    assert.equal(await fs.readFile(path + '.lock', 'utf8'), 'other-process');
});

test('rejects links/junctions at every descendant level and metadata/lock hardlinks', async t => {
    const root = await fixture(t); const outside = await fixture(t);
    const base = join(root, '.dpr-paper-meta');
    for (const target of [base, join(base, 'paper')]) {
        if (target !== base) await fs.mkdir(base, { recursive: true });
        await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(readP(root, id), invalid);
        await assert.rejects(writeP(root, id, { revision: null, summaryText: 'escape' }), invalid);
        await fs.unlink(target);
    }
    await fs.mkdir(join(base, 'paper'), { recursive: true });
    const external = join(outside, 'external'); await fs.writeFile(external, '{}');
    await fs.link(external, metaPath(root));
    await assert.rejects(readP(root, id), invalid);
    await assert.rejects(writeP(root, id, { revision: null, summaryText: 'escape' }), invalid);
    await fs.unlink(metaPath(root));
    await fs.link(external, metaPath(root) + '.lock');
    await assert.rejects(writeP(root, id, { revision: null, summaryText: 'escape' }), invalid);
    assert.equal(await fs.readFile(external, 'utf8'), '{}');
    assert.deepEqual(await fs.readdir(outside), ['external']);
});

test('operation receipts prevent old candidate replay after newer completion/adoption', async t => {
    const root = await fixture(t);
    const a = await candidate(root, id, request());
    const b = await candidate(root, id, request({ operationId: 'op-two', expectedRevision: a.revision }));
    const current = await apply(root, id, { revision: b.revision, operationId: 'op-two' });
    const manual = await writeP(root, id, { revision: current.revision, summaryText: 'latest manual' });
    const replay = await candidate(root, id, request());
    assert.equal(replay.revision, manual.revision);
    assert.equal(replay.candidate, null);
    await assert.rejects(apply(root, id, { revision: replay.revision, operationId: 'op-one' }), conflict);
});

test('candidate replay treats reordered bibliography keys as the same payload', async t => {
    const root = await fixture(t);
    const c = await candidate(root, id, request());
    const same = request({ bibliography: { originalTitle: 'Title', year: '2026', hasMoreAuthors: true, firstAuthor: 'Ada Lovelace' } });
    assert.equal((await candidate(root, id, same)).revision, c.revision);
});

test('disk-full write, sync and rename failures preserve original bytes and clean owned artifacts', async t => {
    const root = await fixture(t);
    const saved = await writeP(root, id, { revision: null, summaryText: 'old' });
    const original = await fs.readFile(metaPath(root));
    // Unavoidable fault injection: a local temp directory cannot force a physical ENOSPC.
    // Keep real filesystem handles and inject only the failing syscall, restoring per stage.
    const mutable = require('node:fs/promises');
    const realOpen = mutable.open, realRename = mutable.rename;
    for (const stage of ['writeFile', 'sync', 'rename']) {
        mutable.open = async (...args) => {
            const handle = await realOpen(...args);
            if (String(args[0]).includes('.tmp-') && stage !== 'rename')
                handle[stage] = async () => { const e = Error('sensitive disk info'); e.code = 'ENOSPC'; throw e; };
            return handle;
        };
        mutable.rename = stage === 'rename' ? async () => { const e = Error('sensitive rename info'); e.code = 'EIO'; throw e; } : realRename;
        syncBuiltinESMExports();
        try {
            await assert.rejects(writeP(root, id, { revision: saved.revision, summaryText: 'new' }), e => {
                assert.equal(e.code, 'io'); assert.equal(e.status, 500); assert.ok(!e.message.includes('sensitive')); return true;
            });
        } finally { mutable.open = realOpen; mutable.rename = realRename; syncBuiltinESMExports(); }
        assert.deepEqual(await fs.readFile(metaPath(root)), original);
        assert.deepEqual(await fs.readdir(join(root, '.dpr-paper-meta', 'paper')), [`${id}.json`]);
    }
});

test('prepublish recheck preserves a corrupt or stale external target and cleans only own temp', async t => {
    const root = await fixture(t);
    const mutable = require('node:fs/promises');
    const realOpen = mutable.open;
    for (const corrupt of [true, false]) {
        const initial = await writeP(root, randomUUID(), { revision: null, summaryText: 'independent' });
        assert.ok(initial.revision);
        let before = await readP(root, id);
        before = await writeP(root, id, { revision: before.revision, summaryText: 'before external change' });
        const old = await fs.readFile(metaPath(root));
        const external = corrupt ? Buffer.from('{corrupt') : Buffer.from(old.toString().replace('before external change', 'outside process edit'));
        mutable.open = async (...args) => {
            const handle = await realOpen(...args);
            if (String(args[0]).includes('.tmp-')) {
                const realSync = handle.sync.bind(handle);
                handle.sync = async () => {
                    await realSync();
                    const target = await realOpen(metaPath(root), 'w');
                    try { await target.writeFile(external); } finally { await target.close(); }
                };
            }
            return handle;
        };
        syncBuiltinESMExports();
        try { await assert.rejects(writeP(root, id, { revision: before.revision, summaryText: 'must not publish' }), corrupt ? invalid : conflict); }
        finally { mutable.open = realOpen; syncBuiltinESMExports(); }
        assert.deepEqual(await fs.readFile(metaPath(root)), external);
        assert.ok((await fs.readdir(join(root, '.dpr-paper-meta', 'paper'))).every(name => name.endsWith('.json')));
        // Restore only this test-owned target to prepare the next scenario.
        await fs.writeFile(metaPath(root), old);
    }
});

test('file and lock symbolic links are rejected when the platform permits creating them', async t => {
    const root = await fixture(t); const outside = await fixture(t);
    const target = join(outside, 'target'); await fs.writeFile(target, '{}');
    await fs.mkdir(join(root, '.dpr-paper-meta', 'paper'), { recursive: true });
    for (const path of [metaPath(root), metaPath(root) + '.lock']) {
        try { await fs.symlink(target, path, 'file'); }
        catch (e) { if (e.code === 'EPERM') { t.skip('file symlink creation requires Windows privilege; junction and hardlink checks run separately'); return; } throw e; }
        if (path === metaPath(root)) await assert.rejects(readP(root, id), invalid);
        await assert.rejects(writeP(root, id, { revision: null, summaryText: 'do not follow' }), invalid);
        assert.equal(await fs.readFile(target, 'utf8'), '{}');
        await fs.unlink(path);
    }
});

test('uppercase UUID resolves the same record and read paths create no metadata directories', async t => {
    const root = await fixture(t);
    await readP(root, id); await readC(root, id);
    assert.deepEqual(await fs.readdir(root), []);
    const saved = await writeC(root, id.toUpperCase(), { revision: null, note: 'canonical id' });
    assert.deepEqual(await readC(root, id), saved);
    assert.deepEqual(await fs.readdir(join(root, '.dpr-paper-meta', 'collection')), [`${id}.json`]);
});

test('disk mkdir failure returns safe io error, preserving existing files', async t => {
    const root = await fixture(t);
    await fs.writeFile(join(root, '.dpr-paper-meta'), 'block directory creation');
    await assert.rejects(writeC(root, id, { revision: null, note: 'test' }), e => {
        assert.ok(['io', 'invalid'].includes(e.code)); assert.ok(!e.message.includes(root)); return true;
    });
    assert.equal(await fs.readFile(join(root, '.dpr-paper-meta'), 'utf8'), 'block directory creation');
});
