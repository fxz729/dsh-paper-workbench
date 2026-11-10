// ISOLATED CONTRACT DOUBLE. This validates adapter schemas and dispatch only.
// It is not the installed DSH SDK; actual Host SDK/GUI registration remains pending.
const source = `
function validate(s,v,p='value') {
 if(s.oneOf){const matches=s.oneOf.filter(branch=>{try{validate(branch,v,p);return true;}catch{return false;}});if(matches.length!==1)throw Error(p+' must match one schema');return;}
 if(s.enum&&!s.enum.includes(v))throw Error(p+' enum invalid');
 if(s.type==='null'){if(v!==null)throw Error(p+' must be null');return;}
 if(s.type==='object'){
  if(!v||typeof v!=='object'||Array.isArray(v))throw Error(p+' must be object');
  const props=s.properties||{};
  for(const [k,child] of Object.entries(props)){if(child.required===true&&!Object.hasOwn(v,k))throw Error(p+'.'+k+' required');if(Object.hasOwn(v,k))validate(child,v[k],p+'.'+k);}
  if(s.additionalProperties===false&&Object.keys(v).some(k=>!Object.hasOwn(props,k)))throw Error(p+' extra field');return;
 }
 if(s.type==='array'){if(!Array.isArray(v))throw Error(p+' must be array');for(const x of v)validate(s.items,x,p+'[]');return;}
 if(s.type==='integer'){if(!Number.isInteger(v))throw Error(p+' must be integer');return;}
 if(s.type&&typeof v!==s.type)throw Error(p+' must be '+s.type);
}
export function defineTool(d){
 if(typeof d.name!=='string'||typeof d.execute!=='function'||!d.output?.schema||typeof d.output.render!=='function')throw Error('tool contract invalid');
 const params={type:'object',properties:d.parameters,additionalProperties:false};
 return {...d,execute:async(args,exec)=>{validate(params,args,'arguments');const result=await d.execute(args,exec);validate(d.output.schema,result,'result');return result;}};
}
`;
const sdk = 'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
export async function resolve(specifier, context, nextResolve) {
 if(specifier==='@deepseek-ai/dsh-tools')return {url:sdk,shortCircuit:true};
 return nextResolve(specifier,context);
}
