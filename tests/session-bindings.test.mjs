import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCatalog } from '../dist/paper-catalog.js';
let sessions;
try { sessions = await import('../dist/session-bindings.js'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; sessions = {}; }
async function setup() {
  assert.equal(typeof sessions.bindPaperSessions, 'function', 'exact session migration must exist');
  const root = await mkdtemp(join(tmpdir(), 'dpr-sessions-'));
  await mkdir(join(root, 'parent', 'child'), { recursive: true });
  await writeFile(join(root, 'parent', 'child', 'paper.pdf'), '%PDF-1.4 A');
  const catalog = createCatalog(root); await catalog.initializeBaseline();
  const paper = catalog.listPapers()[0];
  return { root, catalog, paper };
}
const legacy = (topic, name, n = '') => `dpr-${Buffer.from(`${topic}/${name}`).toString('base64url')}${n ? '-' + n : ''}`;
test('real legacy and v2 sessions bind by full actual session ID', async () => {
  const { catalog, paper } = await setup();
  const rows = [{ sessionId: legacy('parent/child', 'paper'), blank: false }, { sessionId: legacy('parent/child', 'paper', 1), blank: false }, { sessionId: `dpr-v2-${paper.paperId}-2`, blank: true }];
  const result = await sessions.bindPaperSessions(catalog, rows);
  assert.equal(result.bound.length, 3);
  for (const s of rows) assert.equal(catalog.resolvePaper({ sessionId: s.sessionId }).paperId, paper.paperId);
  const listed = sessions.listBoundPaperSessions(catalog, rows, paper.paperId);
  assert.equal(listed.length, 3, 'same-number legacy aliases are preserved rather than overwritten');
  assert.equal(new Set(listed.map(s => s.n)).size, 3);
});
test('rename and old-path reuse retain original exact session ownership', async () => {
  const { root, catalog, paper } = await setup();
  const row = { sessionId: legacy('parent/child', 'paper', 3), blank: false };
  await sessions.bindPaperSessions(catalog, [row]);
  await rename(join(root, 'parent', 'child', 'paper.pdf'), join(root, 'parent', 'child', 'renamed.pdf'));
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[paper.paperId].name = 'renamed'; });
  await writeFile(join(root, 'parent', 'child', 'paper.pdf'), '%PDF-1.4 B');
  const id = randomUUID();
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[id] = { ...paper, paperId: id, origin: 'import', ingestSeq: ++d.ingestSeq }; });
  await sessions.bindPaperSessions(catalog, [row]);
  assert.equal(catalog.resolvePaper({ sessionId: row.sessionId }).paperId, paper.paperId);
  assert.equal(sessions.listBoundPaperSessions(catalog, [row], id).length, 0);
});
test('unbound ambiguous legacy session is reported for review instead of assigned to new occupant', async () => {
  const { root, catalog, paper } = await setup();
  await rename(join(root, 'parent', 'child', 'paper.pdf'), join(root, 'parent', 'child', 'renamed.pdf'));
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[paper.paperId].name = 'renamed'; });
  await writeFile(join(root, 'parent', 'child', 'paper.pdf'), '%PDF-1.4 B');
  await catalog.transact(catalog.snapshot().revision, d => { const id = randomUUID(); d.papers[id] = { ...paper, paperId: id, origin: 'import', ingestSeq: ++d.ingestSeq }; });
  const sid = legacy('parent/child', 'paper', 4);
  const result = await sessions.bindPaperSessions(catalog, [{ sessionId: sid }]);
  assert.deepEqual(result.needsReview, [sid]);
  assert.equal(catalog.snapshot().sessionBindings[sid], undefined);
});
test('only canonical, safe session formats are decoded and malformed inputs remain unbound', async () => {
  const { catalog } = await setup();
  const invalid = ['random-session', legacy('parent/../parent/child', 'paper'), 'dpr-not-base64!!!-1', legacy('parent/child', 'paper') + '-0', `dpr-v2-${randomUUID()}-1`];
  await sessions.bindPaperSessions(catalog, invalid.map(sessionId => ({ sessionId })));
  assert.equal(Object.keys(catalog.snapshot().sessionBindings).length, 0);
});
test('actual long legacy session IDs from legal CJK filenames retain their complete binding', async () => {
  assert.equal(typeof sessions.bindPaperSessions, 'function');
  const root = await mkdtemp(join(tmpdir(), 'dpr-session-cjk-')), name = '文'.repeat(200);
  await mkdir(join(root, 'collection'));
  await writeFile(join(root, 'collection', name + '.pdf'), '%PDF-1.4 CJK');
  const catalog = createCatalog(root); await catalog.initializeBaseline();
  const paper = catalog.listPapers()[0], sid = legacy('collection', name, 1);
  assert.ok(sid.length > 800);
  assert.equal(sessions.parsePaperSessionId(sid)?.name, name);
  await sessions.bindPaperSessions(catalog, [{ sessionId: sid }]);
  assert.equal(catalog.resolvePaper({ sessionId: sid }).paperId, paper.paperId);
});

test('repeated migration is idempotent and new session allocation uses immutable paper UUID', async () => {
  const { catalog, paper } = await setup();
  const row = { sessionId: legacy('parent/child', 'paper', 2) };
  await sessions.bindPaperSessions(catalog, [row]);
  const revision = catalog.snapshot().revision;
  await sessions.bindPaperSessions(catalog, [row]);
  assert.equal(catalog.snapshot().revision, revision);
  assert.equal(sessions.newPaperSessionId(paper.paperId, 3), `dpr-v2-${paper.paperId}-3`);
});
