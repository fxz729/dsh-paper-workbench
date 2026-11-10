import { readdir, readFile, mkdir, copyFile, writeFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'dist'),{recursive:true});
for(const name of await readdir(join(root,'src'))) if(name.endsWith('.js')) await copyFile(join(root,'src',name),join(root,'dist',name));
const assets=JSON.parse(await readFile(join(root,'src/ink/ink-assets.json'),'utf8'));
for(const mapping of Object.values(assets)) for(const value of Object.values(mapping)) {
 if(typeof value!=='string'||!value.startsWith('/paper-reader/vendor/')) throw Error('Ink resources must be local');
 const name=value.slice('/paper-reader/vendor/'.length).split('#')[0];
 if(!/^[\w.-]+$/.test(name)) throw Error('Invalid local asset');
 await access(join(root,'reader/vendor',name));
}
const result=await build({absWorkingDir:root,entryPoints:['src/ink/ink-overlay.jsx'],bundle:true,outfile:'reader/vendor/ink-overlay.js',format:'iife',minify:true,sourcemap:false,metafile:true,define:{'process.env.NODE_ENV':'"production"','__INK_DEV__':'false'},loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'file'},logLevel:'info'});
const packages=new Map();
for(const input of Object.keys(result.metafile.inputs)) {
 if(!input.includes('node_modules'))continue;
 let dir=dirname(resolve(root,input));
 while(dir!==dirname(dir)) {
  try { const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8')); if(pkg.name){packages.set(pkg.name,{dir,pkg});break;} } catch {}
  dir=dirname(dir);
 }
}
const notices=[],missing=[];
for(const [name,{dir,pkg}] of [...packages].sort(([a],[b])=>a.localeCompare(b))) {
 let license='';
 for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','license.txt','License.txt','LICENCE']) {try{license=await readFile(join(dir,file),'utf8');break;}catch{}}
 if(!license) {try{license=await readFile(join(root,'licenses/upstream',name.replaceAll('/','__')+'.LICENSE'),'utf8');}catch{}}
 if(!license){missing.push(name+'@'+pkg.version);continue;}
 notices.push(`=== ${name}@${pkg.version} (${typeof pkg.license==='string'?pkg.license:'see license'}) ===\n${license.trim()}\n`);
}
if(missing.length)throw Error('Missing bundled dependency licenses: '+missing.join(', '));
await mkdir(join(root,'licenses'),{recursive:true});
await writeFile(join(root,'licenses/bundled-dependencies.txt'),notices.join('\n')+'\n');
const sdk=packages.get('tldraw')?.pkg;
if(sdk.version!=='5.6.0')throw Error('Expected tldraw 5.6.0');
const digest=async file=>createHash('sha256').update(await readFile(join(root,file))).digest('hex');
await mkdir(join(root,'artifacts'),{recursive:true});
await writeFile(join(root,'artifacts/build.json'),JSON.stringify({version:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,production:true,developmentLicenseBypass:false,tldraw:sdk.version,bundledDependencies:[...packages.keys()].sort(),outputs:{'reader/vendor/ink-overlay.js':await digest('reader/vendor/ink-overlay.js'),'reader/vendor/ink-overlay.css':await digest('reader/vendor/ink-overlay.css')}},null,2)+'\n');
console.log('BUILD_OK: local portable production bundle; '+packages.size+' dependency license notices');
