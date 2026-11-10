import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as library from '../dist/library.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dpr-identity-'));
  await mkdir(join(root, 'parent', 'child'), { recursive: true });
  await writeFile(join(root, 'parent', 'child', 'paper.pdf'), '%PDF-1.4 original');
  assert.equal(typeof library.initializeLibraryIdentity, 'function', 'shared identity initialization is required');
  const catalog = await library.initializeLibraryIdentity(root);
  const paper = catalog.listPapers()[0];
  return { root, catalog, paper };
}

test('library identity is explicit and recursive entries carry stable IDs', async t => {
  const { root, paper } = await fixture(t);
  assert.ok(paper.paperId);
  assert.deepEqual(library.listTopics(root), ['parent', 'parent/child']);
  assert.equal(library.listPapers(root)[0].paperId, paper.paperId);
  assert.equal(library.resolvePaper(root, { paperId: paper.paperId }).name, 'paper');
  assert.equal(library.resolvePaper(root, { name: 'paper' }).paperId, paper.paperId);
});

test('recursive topic filtering follows the same NFC/case folding as canonical resolution', async t => {
  const { root, paper } = await fixture(t);
  assert.equal(library.resolvePaper(root, { topic: 'PARENT/CHILD', name: 'PAPER' }).paperId, paper.paperId);
  assert.equal(library.listPapers(root, 'PARENT/CHILD')[0]?.paperId, paper.paperId);
});

test('stable IDs dominate stale paths and legacy claims preserve renamed identity', async t => {
  const { root, catalog, paper } = await fixture(t);
  const old = join(root, 'parent', 'child', 'paper.pdf');
  await rename(old, join(root, 'parent', 'child', 'renamed.pdf'));
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[paper.paperId].name = 'renamed'; });
  assert.equal(library.resolvePaper(root, { paperId: paper.paperId, topic: 'wrong', name: 'wrong' }).name, 'renamed');
  assert.equal(library.resolvePaper(root, { path: old }).paperId, paper.paperId);
  await writeFile(old, '%PDF-1.4 second');
  const other = randomUUID();
  await catalog.transact(catalog.snapshot().revision, d => {
    d.papers[other] = { ...paper, paperId: other, origin: 'import', ingestSeq: ++d.ingestSeq };
  });
  for (const args of [{ path: old }, { topic: 'parent/child', name: 'paper' }]) {
    assert.throws(() => library.resolvePaper(root, args), e => e.code === 'paper-ref-ambiguous' && e.status === 409);
  }
  assert.equal(library.resolvePaper(root, { paperId: paper.paperId }).name, 'renamed');
});

test('session identity is exact and missing bound IDs never fall back to another paper', async t => {
  const { root, catalog, paper } = await fixture(t);
  await catalog.transact(catalog.snapshot().revision, d => { d.sessionBindings['exact-session'] = paper.paperId; });
  assert.equal(library.resolvePaper(root, { sessionId: 'exact-session' }).paperId, paper.paperId);
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[paper.paperId].status = 'missing'; });
  assert.throws(() => library.resolvePaper(root, { sessionId: 'exact-session', name: 'paper', topic: 'parent/child' }), e => e.code === 'not-found');
});

test('name-only search includes historical claims instead of preferring the current occupant', async t => {
  const { root, catalog, paper } = await fixture(t);
  await rename(join(root, 'parent', 'child', 'paper.pdf'), join(root, 'parent', 'child', 'renamed.pdf'));
  await catalog.transact(catalog.snapshot().revision, d => { d.papers[paper.paperId].name = 'renamed'; });
  assert.equal(library.resolvePaper(root, { name: 'paper' }).paperId, paper.paperId);
});

test('internal path traversal and symlink aliases stay outside the ID fallback', async t => {
  const { root } = await fixture(t);
  assert.throws(() => library.resolvePaper(root, { topic: 'parent/../parent/child', name: 'paper' }), e => e.status === 400);
  assert.throws(() => library.resolvePaper(root, { paperId: 'invalid', path: join(root, 'parent', 'child', 'paper.pdf') }), e => e.status === 400);
});
