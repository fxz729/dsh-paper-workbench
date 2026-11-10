import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
// Optional host-side check. A path to an installed DSH package.json is supplied
// explicitly; no profile configuration or authentication file is read.
const hostManifest=process.argv[2];
if(!hostManifest)throw Error('Supply the installed @deepseek-ai/dsh package.json path');
const require=createRequire(pathToFileURL(hostManifest));
const entry=require.resolve('@deepseek-ai/dsh-plugin-market-index');
const api=await import(pathToFileURL(entry));
const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
const value=JSON.parse(await readFile(new URL('../marketplace/index.json',import.meta.url),'utf8'));
const index=api.parseMarketIndex(value,'https://raw.githubusercontent.com/fxz729/dsh-paper-workbench/main/marketplace/index.json');
assert.equal(index.plugins.length,1);
const plugin=index.plugins[0],version=plugin.versions[0];
assert.equal(plugin.name,pkg.name);assert.equal(version.version,pkg.version);assert.equal(version.engines.dsh,pkg.engines.dsh);
assert.match(version.source.commit,/^[0-9a-f]{40}$/);
const target=api.marketInstallTarget(plugin.name,version);
assert.ok(target.spec.includes(version.source.commit));
console.log(JSON.stringify({validatedBy:'actual DSH format-1 parser',name:plugin.name,version:version.version,commit:version.source.commit,installSpec:target.spec}));
