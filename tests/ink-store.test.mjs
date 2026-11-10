import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, lstat, link, truncate } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { matchArtifactName, renamePaper, deletePaper } from '../dist/library-manage.js';

const moduleUrl = new URL('../dist/ink-store.js', import.meta.url).href;
async function api() {
    const mod = await import(moduleUrl).catch((e) => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e));
    assert.equal(typeof mod.readInk, 'function', 'readInk export exists');
    assert.equal(typeof mod.writeInk, 'function', 'writeInk export exists');
    return mod;
}
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'dpr-ink-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const topic = join(root, 'Topic');
    await mkdir(topic);
    const pdfPath = join(topic, 'Paper.pdf');
    await writeFile(pdfPath, '%PDF-1.7\nlegacy annotation /Annots []\n%%EOF');
    return { root, topic, ref: { pdfPath }, sidecar: `${pdfPath}.dpr-ink.json` };
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function shapeProps(type) {
    const common = { color: 'black', size: 'm', scale: 1 };
    const richText = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'local ink' }] }] };
    if (type === 'draw' || type === 'highlight') {
        const props = { ...common, segments: [{ type: 'free', path: Buffer.alloc(12).toString('base64'), dim: 3 }], isComplete: true, isPen: false, scaleX: 1, scaleY: 1 };
        return type === 'draw' ? { ...props, fill: 'none', dash: 'draw', isClosed: false } : props;
    }
    if (type === 'geo') return { ...common, geo: 'rectangle', dash: 'draw', url: '', w: 100, h: 100, growY: 0, flipX: false, flipY: false, labelColor: 'black', fill: 'none', font: 'draw', align: 'middle', verticalAlign: 'middle', richText };
    if (type === 'line') return { ...common, dash: 'draw', spline: 'line', points: { a1: { id: 'a1', index: 'a1', x: 0, y: 0 }, a2: { id: 'a2', index: 'a2', x: 20, y: 30 } } };
    if (type === 'arrow') return { ...common, kind: 'arc', elbowMidPoint: 0.5, dash: 'draw', fill: 'none', labelColor: 'black', bend: 0, start: { x: 0, y: 0 }, end: { x: 20, y: 30 }, arrowheadStart: 'none', arrowheadEnd: 'arrow', font: 'draw', richText, labelPosition: 0.5 };
    return { ...common, font: 'draw', textAlign: 'start', w: 100, richText, autoSize: true };
}
function document(shapeType = 'draw') {
    return { pages: { '1': { width: 612, height: 792, rotation: 0, snapshot: {
        store: {
            'document:document': { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
            'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
            'shape:ink': { id: 'shape:ink', typeName: 'shape', type: shapeType, x: 20, y: 30, rotation: 0, parentId: 'page:page', index: 'a1', isLocked: false, opacity: 1, props: shapeProps(shapeType), meta: {} },
        },
        schema: { schemaVersion: 2, sequences: { 'com.tldraw.store': 5, 'com.tldraw.shape.draw': 2 } },
    } } } };
}
const rejectCode = (code, root = '') => (e) => {
    assert.equal(e.code, code);
    assert.equal(e.message.includes(root || '\u0000'), false, 'error excludes absolute filesystem path');
    assert.equal(e.cause, undefined, 'raw IO cause stays private');
    return true;
};

test('read missing ink returns empty document; write roundtrips SDK schema and never changes PDF', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, sidecar, topic } = await fixture(t);
    const before = hash(await readFile(ref.pdfPath));
    assert.deepEqual(await readInk(ref), { revision: null, document: { pages: {} } });
    const doc = document();
    doc.pages['2'] = { ...structuredClone(doc.pages['1']), width: 792, height: 612, rotation: 90 };
    const result = await writeInk(ref, { revision: null, document: doc });
    assert.match(result.revision, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.document, doc);
    assert.equal(result.revision, hash(await readFile(sidecar)));
    assert.deepEqual(await readInk(ref), result);
    assert.equal(hash(await readFile(ref.pdfPath)), before);
    assert.deepEqual((await readdir(topic)).sort(), ['Paper.pdf', 'Paper.pdf.dpr-ink.json']);
    // Legacy PDF rewrites do not invalidate independent ink.
    await writeFile(ref.pdfPath, '%PDF-1.7\nlegacy annotation updated\n%%EOF');
    assert.deepEqual(await readInk(ref), result);
});

test('variant sidecars are isolated from original and one another', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref } = await fixture(t);
    for (const variant of ['-en', '-zh', '-dual']) {
        const variantRef = { pdfPath: ref.pdfPath.replace('.pdf', `${variant}.pdf`) };
        await writeFile(variantRef.pdfPath, '%PDF-1.7 variant');
        await writeInk(variantRef, { revision: null, document: document() });
        assert.deepEqual(await readInk(ref), { revision: null, document: { pages: {} } });
        assert.notEqual((await readInk(variantRef)).revision, null);
    }
});

test('CAS rejects stale, absent, malformed and omitted revisions without modifying saved bytes', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, sidecar, root } = await fixture(t);
    const first = await writeInk(ref, { revision: null, document: document() });
    const next = await writeInk(ref, { revision: first.revision, document: { pages: {} } });
    const bytes = await readFile(sidecar, 'utf8');
    for (const revision of [null, first.revision]) {
        await assert.rejects(writeInk(ref, { revision, document: document() }), rejectCode('conflict', root));
    }
    for (const revision of [undefined, '', '../wrong', 123]) {
        await assert.rejects(writeInk(ref, { revision, document: document() }), rejectCode('invalid', root));
    }
    assert.equal(await readFile(sidecar, 'utf8'), bytes);
    assert.deepEqual(await readInk(ref), next);
});

test('malformed or unknown sidecar data is rejected and preserved verbatim', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, sidecar, root } = await fixture(t);
    for (const text of ['{broken', '{"pages":{}}', JSON.stringify({ version: 999, document: document() })]) {
        await writeFile(sidecar, text);
        await assert.rejects(readInk(ref), rejectCode('invalid', root));
        await assert.rejects(writeInk(ref, { revision: hash(text), document: document() }), rejectCode('invalid', root));
        assert.equal(await readFile(sidecar, 'utf8'), text);
    }
});

test('validation rejects unsafe snapshots, numbers, geometry, records, URLs and oversized documents', async (t) => {
    const { writeInk } = await api();
    const { ref, topic, root } = await fixture(t);
    const mutate = (fn) => { const doc = document(); fn(doc, doc.pages['1'].snapshot); return doc; };
    const bad = [
        null, [], { pages: [] }, { pages: { '0': document().pages['1'] } }, { pages: { '01': document().pages['1'] } },
        mutate((d) => { d.pages['1'].width = NaN; }), mutate((d) => { d.pages['1'].height = Infinity; }),
        mutate((d) => { d.pages['1'].width = -1; }), mutate((d) => { d.pages['1'].rotation = 45; }),
        mutate((d, s) => { s.store['shape:ink'].x = Infinity; }),
        mutate((d, s) => { s.store['shape:ink'].type = 'image'; }),
        mutate((d, s) => { s.store['asset:bad'] = { id: 'asset:bad', typeName: 'asset', type: 'image', props: {} }; }),
        mutate((d, s) => { s.store['binding:bad'] = { id: 'binding:bad', typeName: 'binding', type: 'arrow' }; }),
        mutate((d, s) => { s.store['camera:bad'] = { id: 'camera:bad', typeName: 'camera', x: 0, y: 0, z: 1 }; }),
        mutate((d, s) => { s.store['shape:ink'].props.url = 'https://example.org/private'; }),
        mutate((d, s) => { s.store['shape:ink'].props.text = 'Visit javascript:alert(1)'; }),
        mutate((d, s) => { s.store['shape:ink'].props.href = '/relative-resource'; }),
        mutate((d, s) => { s.store['shape:ink'].meta.payload = 'data:image/png;base64,QQ=='; }),
        mutate((d, s) => { s.store['shape:ink'].meta.payload = '//example.org/image'; }),
        mutate((d, s) => { s.store['shape:ink'].props.assetId = 'asset:missing'; }),
        mutate((d, s) => { s.store['shape:ink'].parentId = 'page:missing'; }),
        mutate((d, s) => { s.store['shape:ink'].id = 'shape:mismatch'; }),
        mutate((d, s) => { delete s.schema; }),
        mutate((d, s) => { s.schema.schemaVersion = Infinity; }),
        mutate((d, s) => { s.store['shape:ink'].props.text = 'a'.repeat(9 * 1024 * 1024); }),
        mutate((d, s) => { s.store['shape:ink'].meta.bad = undefined; }),
        mutate((d, s) => { s.store['shape:ink'].meta.self = s; }),
        mutate((d, s) => { s.store['shape:ink'].meta = JSON.parse('{"__proto__":{"polluted":true}}'); }),
    ];
    for (let i = 0; i < bad.length; i++) {
        await assert.rejects(writeInk(ref, { revision: null, document: bad[i] }), rejectCode('invalid', root), `case ${i}`);
    }
    assert.deepEqual(await readdir(topic), ['Paper.pdf']);
});

test('v1 supports draw/highlight/geo/line/arrow/text snapshots with SDK schema', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref } = await fixture(t);
    let revision = null;
    for (const type of ['draw', 'highlight', 'geo', 'line', 'arrow', 'text']) {
        const doc = document(type);
        const result = await writeInk(ref, { revision, document: doc });
        revision = result.revision;
        assert.deepEqual((await readInk(ref)).document, doc);
    }
});

test('richText plain text safely preserves literal reference URLs in text and shape labels', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref } = await fixture(t);
    let revision = null;
    const text = '参考 https://example.org/paper?a=1&b=2；字面量 javascript:alert(1)、data:text/plain,hello 和 //example.org';
    for (const type of ['text', 'geo', 'arrow']) {
        const doc = document(type);
        const richText = doc.pages['1'].snapshot.store['shape:ink'].props.richText;
        richText.content[0].content[0].text = text;
        // Nested local content and formatting marks remain plain text, without link attrs.
        richText.content.push({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '文献 https://example.org/next', marks: [{ type: 'bold' }] }] }] }] });
        const saved = await writeInk(ref, { revision, document: doc });
        revision = saved.revision;
        assert.deepEqual((await readInk(ref)).document, doc);
    }
});

test('richText literal URL exception never permits link marks, attrs, resource URLs or metadata lookalikes', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, root } = await fixture(t);
    const saved = await writeInk(ref, { revision: null, document: document('text') });
    const mutations = [
        (s) => { s.props.richText.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'https://example.org' } }]; },
        (s) => { s.props.richText.content[0].content[0].marks = [{ type: 'link' }]; },
        (s) => { s.props.richText.content[0].content[0].attrs = { href: '/local-resource' }; },
        (s) => { s.props.richText.attrs = { source: 'https://example.org' }; },
        (s) => { s.props.richText.content[0].attrs = { url: 'https://example.org' }; },
        (s) => { s.props.richText.content[0].content[0].attrs = { label: 'https://example.org' }; },
        (s) => { s.props.url = 'https://example.org'; },
        (s) => { s.props.href = 'https://example.org'; },
        (s) => { s.props.src = 'https://example.org'; },
        (s) => { s.meta = { type: 'text', text: 'https://example.org' }; },
        (s) => { s.meta = { richText: { type: 'doc', content: [{ type: 'text', text: 'https://example.org' }] } }; },
    ];
    for (const mutation of mutations) {
        const doc = document('text'); mutation(doc.pages['1'].snapshot.store['shape:ink']);
        await assert.rejects(writeInk(ref, { revision: saved.revision, document: doc }), rejectCode('invalid', root));
    }
    assert.deepEqual(await readInk(ref), saved);
});

test('invalid shape props and indices cannot replace a previously usable snapshot', async (t) => {
    const { writeInk, readInk } = await api();
    const { ref, root } = await fixture(t);
    const saved = await writeInk(ref, { revision: null, document: document() });
    const mutations = [
        (s) => { s.store['shape:ink'].props = {}; },
        (s) => { s.store['shape:ink'].props.scale = 0; },
        (s) => { s.store['shape:ink'].props.segments = [{}]; },
        (s) => { s.store['shape:ink'].props.size = 'nonsense'; },
        (s) => { s.store['shape:ink'].index = ''; },
        (s) => { s.store['page:page'].index = 'invalid index'; },
        (s) => { s.store['shape:ink'].props.richText = { type: 'doc', content: [{ type: 'image', attrs: { src: '/local' } }] }; },
    ];
    for (const mutation of mutations) {
        const doc = document(); mutation(doc.pages['1'].snapshot);
        await assert.rejects(writeInk(ref, { revision: saved.revision, document: doc }), rejectCode('invalid', root));
    }
    for (const type of ['highlight', 'geo', 'line', 'arrow', 'text']) {
        const doc = document(type); doc.pages['1'].snapshot.store['shape:ink'].props = {};
        await assert.rejects(writeInk(ref, { revision: saved.revision, document: doc }), rejectCode('invalid', root));
    }
    assert.deepEqual(await readInk(ref), saved);
});

test('SDK 5.6 base64 draw paths accept finite coordinates and reject encoded NaN/Infinity', async (t) => {
    const { writeInk } = await api();
    const { ref, root } = await fixture(t);
    function withPath(bytes, dim = 3) {
        const doc = document();
        doc.pages['1'].snapshot.store['shape:ink'].props.segments = [{ type: 'free', path: bytes.toString('base64'), dim }];
        return doc;
    }
    const finitePoint = Buffer.alloc(12);
    finitePoint.writeUInt32LE(0x3f00ffff, 0); // Finite x whose base64 begins with //.
    finitePoint.writeFloatLE(2, 4); finitePoint.writeFloatLE(0.5, 8);
    assert.ok(finitePoint.toString('base64').startsWith('//'));
    const finiteDoc = withPath(finitePoint);
    const saved = await writeInk(ref, { revision: null, document: finiteDoc });
    assert.deepEqual(saved.document, finiteDoc);
    for (const value of [NaN, Infinity, -Infinity]) {
        const bytes = Buffer.from(finitePoint); bytes.writeFloatLE(value, 0);
        await assert.rejects(writeInk(ref, { revision: saved.revision, document: withPath(bytes) }), rejectCode('invalid', root));
    }
    const badDelta = Buffer.concat([finitePoint, Buffer.from([0, 0x7c, 0, 0, 0, 0])]);
    await assert.rejects(writeInk(ref, { revision: saved.revision, document: withPath(badDelta) }), rejectCode('invalid', root));
    const truncated = withPath(Buffer.alloc(2));
    await assert.rejects(writeInk(ref, { revision: saved.revision, document: truncated }), rejectCode('invalid', root));
    const bytes2d = Buffer.alloc(8); bytes2d.writeFloatLE(20, 0); bytes2d.writeFloatLE(30, 4);
    const next = await writeInk(ref, { revision: saved.revision, document: withPath(bytes2d, 2) });
    assert.deepEqual(next.document, withPath(bytes2d, 2));
});

test('optional actual tldraw SDK document snapshot survives storage and reload', async (t) => {
    if (!process.env.DPR_INK_SDK_MODULE) { t.skip('set DPR_INK_SDK_MODULE to local tldraw dist-esm/index.mjs for SDK integration'); return; }
    const sdk = await import(pathToFileURL(process.env.DPR_INK_SDK_MODULE).href);
    const store = sdk.createTLStore({ shapeUtils: sdk.defaultShapeUtils });
    t.after(() => store.dispose());
    store.ensureStoreIsUsable();
    const page = Object.values(sdk.getSnapshot(store).document.store).find((r) => r.typeName === 'page');
    for (const type of ['draw', 'highlight', 'geo', 'line', 'arrow', 'text']) {
        const Util = sdk.defaultShapeUtils.find((util) => util.type === type);
        const props = new Util({}).getDefaultProps();
        if (type === 'draw' || type === 'highlight') props.segments = shapeProps(type).segments;
        if (props.richText) props.richText.content = [{ type: 'paragraph', content: [{ type: 'text', text: '参考 https://example.org/paper' }] }];
        const record = store.schema.types.shape.create({ id: `shape:real_${type}`, type, parentId: page.id, index: 'a1', props });
        store.put([record]);
    }
    const snapshot = sdk.getSnapshot(store).document;
    const { ref } = await fixture(t);
    const { readInk, writeInk } = await api();
    const doc = { pages: { '1': { width: 612, height: 792, rotation: 0, snapshot } } };
    const saved = await writeInk(ref, { revision: null, document: doc });
    assert.deepEqual(await readInk(ref), saved);
    const reloaded = sdk.createTLStore({ shapeUtils: sdk.defaultShapeUtils });
    t.after(() => reloaded.dispose());
    sdk.loadSnapshot(reloaded, { document: saved.document.pages['1'].snapshot });
    assert.deepEqual(sdk.getSnapshot(reloaded).document, snapshot);
});

test('invalid and missing PDF paths return scrubbed errors without creating files', async (t) => {
    const { readInk, writeInk } = await api();
    const { root } = await fixture(t);
    for (const ref of [{}, null, { pdfPath: 'relative.pdf' }, { pdfPath: join(root, 'wrong.txt') }, { pdfPath: `${root}\u0000.pdf` }]) {
        await assert.rejects(readInk(ref), rejectCode('invalid', root));
        await assert.rejects(writeInk(ref, { revision: null, document: { pages: {} } }), rejectCode('invalid', root));
    }
    await assert.rejects(readInk({ pdfPath: join(root, 'absent.pdf') }), rejectCode('io', root));
});

test('symlinks for PDF, sidecar, lock and parent directory are rejected without touching targets', async (t) => {
    const { readInk, writeInk } = await api();
    const { root, topic, ref, sidecar } = await fixture(t);
    const target = join(root, 'target.json');
    await writeFile(target, '{private target}');
    const link = join(topic, 'link.pdf');
    try { await symlink(ref.pdfPath, link); }
    catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) { t.skip('symlink creation requires Windows Developer Mode/privilege'); return; } throw e; }
    await assert.rejects(readInk({ pdfPath: link }), rejectCode('invalid', root));
    await assert.rejects(writeInk({ pdfPath: link }, { revision: null, document: document() }), rejectCode('invalid', root));
    await symlink(target, sidecar);
    await assert.rejects(readInk(ref), rejectCode('invalid', root));
    await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('invalid', root));
    assert.equal((await lstat(sidecar)).isSymbolicLink(), true);
    await rm(sidecar);
    await symlink(target, `${sidecar}.lock`);
    await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('invalid', root));
    const linkedTopic = join(root, 'linked-topic');
    await symlink(topic, linkedTopic, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readInk({ pdfPath: join(linkedTopic, 'Paper.pdf') }), rejectCode('invalid', root));
    assert.equal(await readFile(target, 'utf8'), '{private target}');
});

test('junction parent is rejected even on Windows without file-symlink privilege', async (t) => {
    const { readInk, writeInk } = await api();
    const { root, topic } = await fixture(t);
    const linkedTopic = join(root, 'linked-topic');
    await symlink(topic, linkedTopic, process.platform === 'win32' ? 'junction' : 'dir');
    const ref = { pdfPath: join(linkedTopic, 'Paper.pdf') };
    await assert.rejects(readInk(ref), rejectCode('invalid', root));
    await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('invalid', root));
    assert.deepEqual(await readdir(topic), ['Paper.pdf']);
});

test('hardlinked, non-file and oversized sidecars fail closed with the old file intact', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, sidecar, root } = await fixture(t);
    const target = join(root, 'hardlink-target.json');
    await writeFile(target, 'private');
    await link(target, sidecar);
    await assert.rejects(readInk(ref), rejectCode('invalid', root));
    await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('invalid', root));
    assert.equal(await readFile(target, 'utf8'), 'private');
    await rm(sidecar);
    await mkdir(sidecar);
    await assert.rejects(readInk(ref), rejectCode('invalid', root));
    await rm(sidecar, { recursive: true });
    await writeFile(sidecar, '{}');
    await truncate(sidecar, 8 * 1024 * 1024 + 1);
    await assert.rejects(readInk(ref), rejectCode('invalid', root));
    assert.equal((await lstat(sidecar)).size, 8 * 1024 * 1024 + 1);
});

test('CAS revision and document are detached before the first asynchronous operation', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, root } = await fixture(t);
    const initial = await writeInk(ref, { revision: null, document: document() });
    const request = { revision: null, document: document() };
    const saving = writeInk(ref, request);
    request.revision = initial.revision;
    request.document.pages['1'].width = 10;
    await assert.rejects(saving, rejectCode('conflict', root));
    assert.deepEqual(await readInk(ref), initial);
    const nextRequest = { revision: initial.revision, document: document() };
    const nextSaving = writeInk(ref, nextRequest);
    nextRequest.document.pages['1'].width = 5;
    assert.equal((await nextSaving).document.pages['1'].width, 612);
});

test('array custom serialization cannot inject unvalidated data', async (t) => {
    const { writeInk } = await api();
    const { ref, topic, root } = await fixture(t);
    const doc = document();
    doc.pages['1'].snapshot.store['shape:ink'].props.segments.toJSON = () => [{ url: 'https://bad.example/image' }];
    await assert.rejects(writeInk(ref, { revision: null, document: doc }), rejectCode('invalid', root));
    assert.deepEqual(await readdir(topic), ['Paper.pdf']);
});

test('existing lock fails safely and is preserved for owner recovery', async (t) => {
    const { writeInk } = await api();
    const { ref, sidecar, root } = await fixture(t);
    await writeFile(`${sidecar}.lock`, 'other-process');
    await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('conflict', root));
    assert.equal(await readFile(`${sidecar}.lock`, 'utf8'), 'other-process');
});

test('lock owner finishing between EEXIST and lock inspection remains a conflict', async (t) => {
    const { writeInk } = await api();
    const { ref, sidecar, root, topic } = await fixture(t);
    const lockPath = `${sidecar}.lock`;
    await writeFile(lockPath, 'active-owner');
    const originalLstat = fsPromises.lstat;
    let raced = false;
    // Deterministically interleave the other owner's real unlink at the lstat boundary.
    const hook = t.mock.method(fsPromises, 'lstat', async (path, ...args) => {
        if (path === lockPath && !raced) { raced = true; await rm(lockPath); }
        return originalLstat(path, ...args);
    });
    syncBuiltinESMExports();
    try {
        await assert.rejects(writeInk(ref, { revision: null, document: document() }), rejectCode('conflict', root));
        assert.equal(raced, true);
        assert.deepEqual(await readdir(topic), ['Paper.pdf']);
    }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

test('simultaneous windows using one revision produce exactly one winner', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, sidecar, topic } = await fixture(t);
    const first = await writeInk(ref, { revision: null, document: document() });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => {
        const doc = document(); doc.pages['1'].width += i + 1;
        return writeInk(ref, { revision: first.revision, document: doc });
    }));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    for (const result of results.filter((r) => r.status === 'rejected')) assert.equal(result.reason.code, 'conflict');
    const winner = results.find((r) => r.status === 'fulfilled').value;
    assert.deepEqual(await readInk(ref), winner);
    assert.equal(hash(await readFile(sidecar)), winner.revision);
    assert.deepEqual((await readdir(topic)).sort(), ['Paper.pdf', 'Paper.pdf.dpr-ink.json']);
});

function childWrite(ref, revision, doc) {
    const script = `import {writeInk} from ${JSON.stringify(moduleUrl)};try{await writeInk(${JSON.stringify(ref)},${JSON.stringify({ revision, document: doc })});console.log('ok')}catch(e){console.log(e.code);process.exitCode=e.code==='conflict'?2:3}`;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject); child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    });
}

test('independent Node processes also obey CAS and leave a complete atomic file', async (t) => {
    const { readInk, writeInk } = await api();
    const { ref, topic } = await fixture(t);
    const first = await writeInk(ref, { revision: null, document: document() });
    const outcomes = await Promise.all(Array.from({ length: 4 }, (_, i) => {
        const doc = document(); doc.pages['1'].height += i + 1;
        return childWrite(ref, first.revision, doc);
    }));
    assert.equal(outcomes.filter((r) => r.code === 0).length, 1, JSON.stringify(outcomes));
    assert.equal(outcomes.filter((r) => r.code === 2 && r.stdout === 'conflict').length, 3, JSON.stringify(outcomes));
    assert.notEqual((await readInk(ref)).revision, first.revision);
    assert.deepEqual((await readdir(topic)).sort(), ['Paper.pdf', 'Paper.pdf.dpr-ink.json']);
});

test('lifecycle matches exact ink sidecars only, renames all variants, and recycles without touching neighbours', async (t) => {
    const { root, topic } = await fixture(t);
    const owned = ['Paper.pdf.dpr-ink.json', 'Paper-en.pdf.dpr-ink.json', 'Paper-zh.pdf.dpr-ink.json', 'Paper-dual.pdf.dpr-ink.json'];
    const neighbours = ['Paper Extra.pdf.dpr-ink.json', 'Paper-zh Extra.pdf.dpr-ink.json', 'Paper.pdf.dpr-ink.json.bak', 'Paper-backup.pdf.dpr-ink.json'];
    for (const name of owned) assert.equal(matchArtifactName('Paper', name), true, name);
    for (const name of neighbours) assert.equal(matchArtifactName('Paper', name), false, name);
    for (const name of [...owned, ...neighbours]) await writeFile(join(topic, name), name);
    const renamed = renamePaper(root, 'Topic', 'Paper', 'Renamed');
    for (const name of owned) {
        const next = name.replace(/^Paper/, 'Renamed');
        assert.ok(renamed.moved.includes(next));
        assert.equal(await readFile(join(topic, next), 'utf8'), name);
    }
    const deleted = deletePaper(root, 'Topic', 'Renamed');
    for (const name of owned) assert.ok(deleted.moved.includes(name.replace(/^Paper/, 'Renamed')));
    assert.deepEqual((await readdir(topic)).sort(), neighbours.sort());
    assert.equal(await readFile(join(root, deleted.trashRel, 'Renamed.pdf.dpr-ink.json'), 'utf8'), owned[0]);
});
