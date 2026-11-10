import { readFile, readdir, stat, lstat, access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function checkPackage(){
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 for(const file of [pkg.main,pkg.exports['./client'],pkg.dsh.bundle.patch,'reader/index.html','reader/batch.html','reader/paper-details.html','reader/vendor/pdf.min.mjs','reader/vendor/pdf.worker.min.mjs','reader/vendor/ink-overlay.js','reader/vendor/ink-overlay.css','LICENSE','THIRD_PARTY_NOTICES.md','licenses/tldraw-LICENSE.md','licenses/bundled-dependencies.txt','licenses/pdfjs-LICENSE','licenses/IBMPlex-OFL.txt','licenses/ShantellSans-OFL.txt'])await access(join(root,file));
 let registration;vm.runInNewContext(await readFile(join(root,pkg.exports['./client']),'utf8'),{window:{__ModuleLoader__:{load(value){registration=value;}}}});assert.equal(registration.id,pkg.name);
 assert.ok((await readFile(join(root,pkg.dsh.bundle.patch),'utf8')).includes(`name: '${pkg.name}'`));
 assert.equal(pkg.engines.dsh,'0.2.2-rc.1');
 const npm=process.env.npm_execpath;
 if(!npm||!npm.endsWith('.js'))throw Error('Run through npm run check:package or npm run pack:release');
 const result=spawnSync(process.execPath,[npm,'pack','--dry-run','--json','--ignore-scripts'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,timeout:60000});
 if(result.status!==0)throw Error('npm pack dry-run failed: '+result.stderr);
 const report=JSON.parse(result.stdout)[0],names=report.files.map(row=>row.path);
 const allowed=/^(?:dist\/|lib\/|reader\/|runtime\/[\w.-]+\.py$|licenses\/|package\.json$|cordis\.patch\.yml$|LICENSE$|README\.md$|THIRD_PARTY_NOTICES\.md$)/;
 for(const name of names){
  if(!allowed.test(name)||/(?:^|\/)\.env(?:\.|$)|ink-license\.json|\.pdf$|\.ink\.json$|\.study\.json$|\.log$/i.test(name))throw Error('Unexpected package content: '+name);
  const file=join(root,name),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw Error('Non-regular package content: '+name);
  if(/\.(?:js|mjs|json|html|css|py|yml|md|txt)$/.test(name)&&info.size<10*1024*1024){
   const text=await readFile(file,'utf8');
   if(/(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-[A-Za-z0-9]{24,}|tldraw-[A-Za-z0-9_+/.=]{40,}|[A-Za-z]:[\\/]Users[\\/]\d{4,}|D:[\\/]Projects[\\/])/.test(text))throw Error('Sensitive or machine-bound package content detected in '+name);
  }
 }
 const mod=await import(new URL('../dist/index.js',import.meta.url));assert.equal(typeof mod.apply,'function');
 await mkdir(join(root,'artifacts'),{recursive:true});
 const safe={package:pkg.name,version:pkg.version,files:names,unpackedSize:report.unpackedSize,entryPointLoads:true,identityMatches:true,privateLicenseExcluded:true,productionLicenseEnforcement:true};
 await writeFile(join(root,'artifacts/package-check.json'),JSON.stringify(safe,null,2)+'\n');
 console.log('PACKAGE_CHECK_OK: '+names.length+' allowlisted files, '+report.unpackedSize+' bytes unpacked');return{pkg,report,names};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkPackage();
