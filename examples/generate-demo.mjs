// Self-authored public demo document. No external files, fonts or services are used.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const escapePdf=s=>String(s).replace(/[\\()]/g,'\\$&');
export function createDemoPdf({title='Reproducible Research, One Paper at a Time',edition='Field notes 01'}={}){
 const pages=[
  [title,'A practical reading workflow','Open workbench / public demonstration',
   'A small library makes a large question easier to explore.',
   'Keep each source intact. Organize the questions, not just the files.',
   'This document was authored for the open-source workbench demo.',
   'No personal research, API credentials or conversation history is included.',
   '1  Build a collection around a clear research question.',
   '2  Record a short note describing its scope and next reading step.',
   '3  Import PDFs by copying, preserving the original source bytes.',
   '4  Read the original, capture a summary, and return to the source.',
   'ABSTRACT',
   'A reproducible literature workflow connects stable paper identity,',
   'collection notes and local PDF reading. Automatic model actions remain',
   'opt-in. This example uses only self-authored data and local services.'],
  ['From a library to an argument','Reading protocol','Methods / questions / evidence',
   'QUESTION', 'What does this source add to the argument?',
   'METHOD', 'Which assumptions determine the result?',
   'EVIDENCE', 'Where is the supporting passage in the original PDF?',
   'NEXT STEP', 'Compare a second paper before accepting a general claim.',
   'NOTES', 'Collection notes describe a topic. A paper summary belongs to one paper.',
   'Renames and moves should preserve stable identity and sidecar data.',
   'A copied source should never be silently overwritten or moved.'],
  ['A checklist for the next reading session','Make progress visible','Local-first research habits',
   'Before reading', 'Choose one question and keep the original PDF available.',
   'During reading', 'Distinguish an author claim from an observation in the evidence.',
   'After reading', 'Write a concise summary and a next action in the collection note.',
   'Before using automation', 'Review the target, scope and API costs. Defaults stay off.',
   'This is page three of a deterministic, self-authored demonstration PDF.']
 ];
 const objects=[];const add=s=>{objects.push(s);return objects.length;};
 add('<< /Type /Catalog /Pages 2 0 R >>');add('');add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');const kids=[];
 for(let i=0;i<pages.length;i++){
  const lines=pages[i],commands=['0.97 0.975 0.965 rg 0 0 612 792 re f','0.20 0.37 0.30 rg 42 704 528 5 re f','0.20 0.37 0.30 rg BT /F2 10 Tf 42 736 Td ('+escapePdf('PAPER WORKBENCH  /  '+edition)+') Tj ET'];
  let y=669;for(let j=0;j<lines.length;j++){const big=j===0,size=big?20:j===1?14:10,heavy=big||j===1||/^[A-Z ]+$/.test(lines[j]);commands.push((big?'0.12 0.19 0.17':'0.25 0.29 0.27')+' rg BT /'+(heavy?'F2':'F1')+' '+size+' Tf 42 '+y+' Td ('+escapePdf(lines[j])+') Tj ET');y-=big?37:j===1?28:30;}
  commands.push('0.20 0.37 0.30 rg 42 52 528 1 re f','0.40 0.45 0.42 rg BT /F1 9 Tf 42 34 Td (Self-authored public demo / Local only) Tj ET','BT /F1 9 Tf 535 34 Td ('+(i+1)+' / 3) Tj ET');
  const stream=commands.join('\n'),content=add('<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'\nendstream');kids.push(add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents '+content+' 0 R >>'));
 }
 objects[1]='<< /Type /Pages /Count '+kids.length+' /Kids ['+kids.map(id=>id+' 0 R').join(' ')+'] >>';
 let result='%PDF-1.7\n% public deterministic demo\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(result));result+=(i+1)+' 0 obj\n'+objects[i]+'\nendobj\n';}
 const xref=Buffer.byteLength(result);result+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(result,'ascii');
}
export async function generateDemo(directory){await mkdir(directory,{recursive:true});const files=[];for(const [name,title,edition] of [['reading-workflow.pdf','Reproducible Research, One Paper at a Time','Field notes 01'],['evidence-checklist.pdf','Evidence Before Conclusions','Field notes 02'],['comparison-notes.pdf','Comparing Methods Across Papers','Field notes 03']]){const file=join(directory,name);await writeFile(file,createDemoPdf({title,edition}),{flag:'wx'});files.push(file);}return files;}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){if(!process.argv[2])throw Error('Usage: node examples/generate-demo.mjs <new output directory>');await generateDemo(resolve(process.argv[2]));console.log(JSON.stringify({generated:3,pagesPerPdf:3,selfAuthored:true}));}
