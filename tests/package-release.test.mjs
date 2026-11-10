import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
test('the distributed client registers under the exact installable package name',()=>{
 let definition; vm.runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(value){definition=value;}}}});
 assert.equal(definition.id,pkg.name);
 const patch=readFileSync(new URL('../cordis.patch.yml',import.meta.url),'utf8');
 assert.ok(patch.includes(`name: '${pkg.name}'`));
});
test('the public bundle excludes machine-local license files and install lifecycle code',()=>{
 assert.ok(pkg.files.includes('runtime/*.py'));
 assert.equal(pkg.files.includes('runtime'),false);
 for(const script of ['postinstall','preinstall','install','prepare']) assert.equal(pkg.scripts[script],undefined);
 assert.equal(existsSync(new URL('../runtime/ink-license.json',import.meta.url)),false);
});
