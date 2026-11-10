import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/ink/ink-overlay.jsx', import.meta.url), 'utf8');
test('explicit toolbar and keyboard mutations obey navigation, live-mutation and sync save locks', () => {
  const helper = source.match(/function isInkLocked\(\)\{[^\n]+\}/)?.[0];
  assert.ok(helper, 'shared lock predicate required');
  for (const lockedBy of [null, 'navigation', 'mutation', 'suspended', 'bridge']) {
    const state = { navigation: lockedBy === 'navigation', mutationLease: { locked: lockedBy === 'mutation' },
      syncSuspended: lockedBy === 'suspended', bridge: { syncBlocked: () => lockedBy === 'bridge' } };
    assert.equal(vm.runInNewContext(helper + ';isInkLocked()', state), lockedBy !== null, String(lockedBy));
  }
  assert.match(source, /function selectTool\(next\)\{if\(isInkLocked\(\)\)return;/);
  assert.match(source, /if\(isInkLocked\(\)\)\{e\.preventDefault\(\);e\.stopImmediatePropagation\(\);return;\}/);
  for (const action of ['undo', 'redo']) {
    assert.ok(source.includes('onClick={()=>{if(isInkLocked())return;active?.editor.' + action + '();changed();}}'), action + ' must honor the shared lock');
  }
});
