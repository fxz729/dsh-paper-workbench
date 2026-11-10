import { readdir, readFile, lstat, access } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const ignored=new Set(['node_modules','.git','release','artifacts','coverage']);
let checked=0;const failures=[];
async function scan(dir,rel=''){
 for(const item of await readdir(dir,{withFileTypes:true})){
  if(ignored.has(item.name))continue;
  const file=join(dir,item.name),name=rel+item.name;
  if(item.isSymbolicLink()){failures.push(name+': symlink');continue;}
  if(item.isDirectory()){await scan(file,name+'/');continue;}
  if(!item.isFile())continue;
  checked++;
  if(/(?:^|\/)\.env(?:\.|$)|(?:^|\/)ink-license\.json$|\.pdf$|\.study\.json$|\.ink\.json$/.test(name)) failures.push(name+': private or user-data filename');
  if(/\.(?:png|jpg|jpeg|webp|woff2|woff|ttf)$/.test(name))continue;
  if((await lstat(file)).size>10*1024*1024)throw Error('Unreviewed large public text file: '+name);
  const text=await readFile(file,'utf8');
  // Do not print matching content. Keys in synthetic tests are descriptive, not credentials.
  const privatePath=/[CD]:[\\/]Users[\\/]\d{4,}|D:[\\/]HuaweiMoveData|D:[\\/]Projects[\\/][\w-]+/;
  const credential=/(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|sk-[A-Za-z0-9]{24,}|tldraw-[A-Za-z0-9_+/.=]{40,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
  if(privatePath.test(text)||credential.test(text))failures.push(name+': private path or credential pattern');
 }
}
await scan(root);
if(failures.length)throw Error('Public content check failed:\n'+failures.join('\n'));
console.log('PUBLIC_CONTENT_OK '+checked+' regular files; no matched private paths or credential patterns');
