// Model adapter: local business operations stay in the shared runtime services.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolveDataDir } from './library.js';
import { getPaperRuntime } from './library-runtime.js';

const actions = ['list','create_collection','update_collection','import_pdfs','get_paper','update_paper','plan_enrichment','run_enrichment','set_automation','job_status'];
const str = description => ({ type: 'string', description });
const bibliography = { type:'object', properties:{firstAuthor:str('首作者全名'),hasMoreAuthors:{type:'boolean'},year:str('年份'),originalTitle:str('原文标题')}, additionalProperties:false };
const parameters = {
 action:{type:'string',required:true,enum:actions},
 paperId:str('稳定论文 UUID。'), collectionId:str('稳定文献库 UUID。'), parentId:str('新子库的父库 UUID；省略则根目录。'),
 name:str('新库名；update_collection 未带 planId 时仅生成物理改名计划。'), note:str('库备注，本地保存。'), summaryText:str('模型已知摘要，本地保存，不另发生成请求。'), bibliography,
 expectedRevision:{oneOf:[{type:'string'},{type:'integer'},{type:'null'}],description:'当前元数据或命名实体版本，首次元数据为 null。'},
 operationId:str('幂等操作标识；重复请求须复用。'),planId:str('先前返回的费用或改名计划 ID。'),
 features:{type:'array',items:{type:'string',enum:['summary','name']}},
 sources:{type:'array',items:{type:'object',properties:{path:str('仅导入使用的外部 PDF 绝对路径；保留原文件。'),name:str('导入名称'),summaryText:str('已知摘要'),bibliography},additionalProperties:false}},
 autoSummary:{type:'boolean'},autoName:{type:'boolean'},
 confirmCosts:{type:'boolean',description:'费用意愿提示；实际授权由宿主确认本次调用。'},
};
const fields = {
 list:[],create_collection:['parentId','name','note','operationId'],update_collection:['collectionId','name','note','expectedRevision','operationId','planId'],
 import_pdfs:['collectionId','sources','operationId'],get_paper:['paperId','collectionId'],update_paper:['paperId','summaryText','bibliography','expectedRevision'],
 plan_enrichment:['paperId','features'],run_enrichment:['planId','operationId','confirmCosts'],set_automation:['autoSummary','autoName','expectedRevision','confirmCosts'],job_status:['paperId'],
};
function validate(args) {
 if (!args || typeof args !== 'object' || Array.isArray(args) || !actions.includes(args.action)) throw Error('文献管理 action 无效');
 const allowed = ['action',...fields[args.action]];
 if (Object.keys(args).some(k=>!allowed.includes(k))) throw Error('当前 action 包含无关字段');
 if (args.action==='update_collection' && typeof args.collectionId!=='string') throw Error('update_collection 需要 collectionId');
 if (args.action==='update_collection' && args.planId!==undefined && (typeof args.operationId!=='string'||!args.operationId)) throw Error('改名计划执行需要 operationId');
 if (args.action==='update_collection' && args.note!==undefined && (args.name!==undefined || args.planId!==undefined)) throw Error('请分别提交库备注与物理改名');
 return Object.fromEntries(fields[args.action].filter(k=>Object.hasOwn(args,k)).map(k=>[k,args[k]]));
}
function needsApproval(args) {
 return args?.action==='run_enrichment' || (args?.action==='set_automation' && (args.autoSummary===true || args.autoName===true))
  || (args?.action==='update_collection' && args.planId!==undefined);
}
export function registerLibraryTools(ctx, config, {runtimeFactory=getPaperRuntime}={}) {
 const runtime=runtimeFactory(resolveDataDir(config.dataDir),config);
 const approvalError='请通过本工具的宿主确认后执行费用或物理改名操作';
 const approvals=new WeakMap();
 const requiresApproval=exec=>approvals.get(exec)??needsApproval(exec.arguments);
 ctx.on('tools/pre-execute',async (exec,next)=>{
  if(exec.name!=='library_manage') return next();
  validate(exec.arguments);
  await runtime.ready;
  if(exec.signal?.aborted) return {kind:'cancel'};
  let required=needsApproval(exec.arguments);
  if(exec.arguments.action==='set_automation'&&required){
   const old=await runtime.enrichment.getAutomation();
   required=(exec.arguments.autoSummary===true&&!old.autoSummary)||(exec.arguments.autoName===true&&!old.autoName);
  }
  approvals.set(exec,required);
  if(!required) return next();
  runtime.recordToolIntent(exec);
  const rename=exec.arguments.action==='update_collection';
  return {kind:'ask',reason:rename?'Confirm physical library rename':'Confirm paper API costs',displayReason:{en:rename?'Apply this physical library rename and update related files?':'Allow this paper API operation and its potential costs?',zh:rename?'确认按此计划物理改名文献库及相关文件？':'确认执行本次 API 操作并接受相关费用？'}};
 });
 ctx.tools.guard(exec=>exec.name==='library_manage'&&requiresApproval(exec)&&!runtime.hasToolIntent(exec)?approvalError:undefined);
 ctx.tools.register(defineTool({
  name:'library_manage',description:'管理嵌套文献库、库备注、PDF 非覆盖导入与本地论文摘要。先 plan 再确认 API 费用或物理改名；开关默认关闭。无删除或任意配置修改。',parameters,
  output:{schema:{type:'object',properties:{action:{type:'string',required:true,enum:actions},result:{type:'object',required:true,additionalProperties:true}},additionalProperties:false},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
  execute:async(args,exec)=>{
   try {
    await runtime.ready;
    exec.signal?.throwIfAborted();
    const input=validate(args);
    if(requiresApproval(exec)&&!runtime.hasToolIntent(exec)) throw Error(approvalError);
    let result;
    switch(args.action){
     case 'list':result=await runtime.service.listTree();break;
     case 'create_collection':result=await runtime.service.createCollection(input,'model');break;
     case 'update_collection':
      if(input.planId!==undefined) result=await runtime.applyToolRename(exec,{planId:input.planId,collectionId:input.collectionId,operationId:input.operationId});
      else if(input.name!==undefined) result={plan:await runtime.service.planRename(input),requiresConfirmation:true};
      else result=await runtime.service.updateDetails(input,'model');
      break;
     case 'import_pdfs':result=await runtime.service.importPdfs(input,'model');break;
     case 'get_paper':result=await runtime.service.getDetails(input);break;
     case 'update_paper':result=await runtime.service.updateDetails(input,'model');break;
     case 'plan_enrichment':result=await runtime.enrichment.plan(input);break;
     case 'run_enrichment':result=await runtime.enrichment.run({...input,confirmCosts:true},exec.token);break;
     case 'set_automation':result=await runtime.enrichment.setAutomation({...input,confirmCosts:requiresApproval(exec)},exec.token);break;
     case 'job_status':result={jobs:await runtime.enrichment.jobs(input)};break;
    }
    return {action:args.action,result};
   } finally {approvals.delete(exec);runtime.revokeToolIntent(exec);}
  },
 }));
}
