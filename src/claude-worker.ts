import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { claudeEnvironment, withinClaudeWorkspace, type ClaudeConfig } from './claude-config.js';

process.umask(0o077);
const send=(message:unknown)=>{if(process.connected)process.send?.(message);};
const abort=new AbortController();let closing=false;
process.on('SIGTERM',()=>abort.abort());
process.on('disconnect',()=>{abort.abort();if(!closing)setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{/* group already gone */}},2000);});
const decisions=new Map<string,(answer:unknown)=>void>();
process.on('message',(m:any)=>{if(m?.type==='decision') {const done=decisions.get(m.id);decisions.delete(m.id);done?.(m.answer);}});
function decision(type:'permission'|'question',id:string,tool:string,input:Record<string,unknown>,signal:AbortSignal):Promise<unknown> {
  return new Promise(resolve=>{
    const done=(answer:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);decisions.delete(id);resolve(answer);};
    const cancel=()=>done(undefined),timer=setTimeout(cancel,30000);signal.addEventListener('abort',cancel,{once:true});
    decisions.set(id,done);if(signal.aborted)cancel();else send({type,id,tool,input});
  });
}
function fileAllowed(cwd:string,input:Record<string,unknown>):boolean {
  if(typeof input.file_path!=='string'||!input.file_path)return false;
  const target=resolve(cwd,input.file_path);if(!withinClaudeWorkspace(cwd,target))return false;
  let cursor=cwd;
  for(const part of relative(cwd,target).split('/')) {cursor=join(cursor,part);try {if(lstatSync(cursor).isSymbolicLink())return false;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')return false;}}
  let ancestor=target;
  for(;;){if(existsSync(ancestor))return !lstatSync(ancestor).isSymbolicLink()&&withinClaudeWorkspace(cwd,realpathSync(ancestor))||ancestor===cwd;
    const parent=dirname(ancestor);if(parent===ancestor)return false;ancestor=parent;}
}
async function run(m:{config:ClaudeConfig;cwd:string;prompt:string;threadId?:string}):Promise<void> {
  const c=m.config,env=claudeEnvironment(c),cwd=realpathSync(m.cwd);
  if(!withinClaudeWorkspace(realpathSync(c.validationRoot),cwd))throw new Error('claude_validation_workspace_required');
  const identity=createHash('sha256').update(JSON.stringify({cwd,bin:realpathSync(c.bin),auth:c.auth,model:c.model??env.ANTHROPIC_MODEL,toolSet:c.toolSet??'files',
    credentials:['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'].map(k=>env[k]??'')})).digest('hex');
  const secrets=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN'].flatMap(k=>env[k]?[env[k]!]:[]);
  const redact=(text:string)=>secrets.reduce((s,k)=>s.split(k).join('[redacted]'),text);
  const binding=(id:string)=>join(c.home,`session-${id}.json`);
  const validId=(id:unknown):id is string=>typeof id==='string'&&/^[a-f0-9-]{36}$/i.test(id);
  if(m.threadId&&(!validId(m.threadId)||!existsSync(binding(m.threadId))||readFileSync(binding(m.threadId),'utf8')!==identity))throw new Error('claude_session_mismatch');
  let session=m.threadId,child:ChildProcessWithoutNullStreams|undefined;
  let failure='claude_query_failed';
  const diagnose=(text:string)=>{if(/reasoning_extraction/.test(text))failure='claude_provider_policy_rejection';else if(/No conversation found|session.{0,30}not found|No messages found/i.test(text))failure='claude_session_not_found';else if(/authenticat|invalid.api.key|401/i.test(text))failure='claude_auth_failed';};
  const tools=['Read','Edit','AskUserQuestion',...(c.toolSet==='bounded-shell'?['Bash']:[])];
  const allow:Options['canUseTool']=async(tool,input,context):Promise<PermissionResult>=>{
    const deny:PermissionResult={behavior:'deny',message:'Namo declined this operation; do not bypass it.'};
    if(abort.signal.aborted||!tools.includes(tool)||JSON.stringify(input).length>32768)return deny;
    if(tool==='AskUserQuestion'){
      const answer=await decision('question',context.toolUseID,tool,input,context.signal);
      if(!answer||typeof answer!=='object'||Array.isArray(answer)||Object.values(answer).some(v=>typeof v!=='string'))return deny;
      return {behavior:'allow',updatedInput:{...input,answers:answer}};
    }
    const permitted=tool==='Bash'?['/bin/sleep 30','/usr/bin/true','/usr/bin/false'].includes(String(input.command))
      :['Read','Write','Edit'].includes(tool)&&fileAllowed(cwd,input);
    if(!permitted)return deny;
    return await decision('permission',context.toolUseID,tool,input,context.signal)===true?{behavior:'allow',updatedInput:input}:deny;
  };
  const options:Options={cwd,env,abortController:abort,pathToClaudeCodeExecutable:c.bin,
    model:c.model??env.ANTHROPIC_MODEL,settingSources:[],plugins:[],skills:[],mcpServers:{},strictMcpConfig:true,
    tools,allowedTools:[],permissionMode:'default',canUseTool:allow,includePartialMessages:true,
    settings:{disableAllHooks:true,autoMemoryEnabled:false,permissions:{ask:tools}},
    extraArgs:{bare:null},maxTurns:8,maxBudgetUsd:1,resume:m.threadId,
    systemPrompt:'You are an agent in an isolated Namo compatibility test. Use the actual provided tools when requested. Never invent tool results. Do not access files outside the working directory. Never send messages, push, deploy, read credentials or change configuration. Do not reveal reasoning or credentials. Answer in the requested language.',
    stderr:diagnose,spawnClaudeCodeProcess:opts=>{
      child=spawn(opts.command,opts.args,{cwd:opts.cwd,env:opts.env,stdio:'pipe',detached:false});child.stderr.on('data',chunk=>diagnose(String(chunk)));return child;
    }};
  const q=query({prompt:m.prompt,options});let result:{type:string;text:string;threadId:string}|undefined;
  const seen=new Map<string,string>();
  try {
    for await(const event of q){
      if(abort.signal.aborted)break;
      if(event.type==='system'&&event.subtype==='init')send({type:'tools',names:tools.filter(t=>Array.isArray(event.tools)&&event.tools.includes(t))});
      if('session_id' in event&&validId(event.session_id)){
        if(session&&session!==event.session_id)throw new Error('claude_session_mismatch');
        if(!session){session=event.session_id;writeFileSync(binding(session),identity,{mode:0o600,flag:'wx'});}send({type:'thread',id:session});
      }
      if(event.type==='assistant')for(const block of event.message.content){
        if(block.type==='tool_use'){seen.set(block.id,tools.includes(block.name)?block.name:'tool');send({type:'progress',event:{id:block.id,kind:'tool',status:'running',text:`Claude ${tools.includes(block.name)?block.name:'tool'}：已请求`}});}
      }
      if(event.type==='user'&&Array.isArray(event.message.content))for(const block of event.message.content){
        if(block.type==='tool_result'&&seen.has(block.tool_use_id)){
          const failed=block.is_error===true;send({type:'progress',event:{id:block.tool_use_id,kind:'tool',status:failed?'failed':'completed',outcome:failed?'failure':'success',text:`Claude ${seen.get(block.tool_use_id)}：${failed?'未成功':'已结束'}`}});
          send({type:'evidence',item:{id:block.tool_use_id,kind:'tool',status:failed?'failed':'completed',label:`Claude ${seen.get(block.tool_use_id)}`}});
        }
      }
      if(event.type==='result'){
        if(event.subtype!=='success'||event.is_error){diagnose('errors' in event?event.errors.join(' '):event.result);throw new Error(event.subtype==='error_max_budget_usd'?'claude_budget_exceeded':failure);}
        if(!session||event.session_id!==session)throw new Error('claude_session_mismatch');
        result={type:'result',text:redact(event.result).slice(0,60000),threadId:session};
      }
    }
    if(!result&&!abort.signal.aborted)throw new Error('claude_query_failed');
    if(result&&!abort.signal.aborted)send(result);
  } catch(e) {diagnose(e instanceof Error?e.message:'');throw new Error(failure==='claude_query_failed'&&e instanceof Error&&/^claude_/.test(e.message)?e.message:failure);} finally { q.close(); }
}
process.once('message',(m:any)=>{
  if(m?.type!=='run')return;
  void run(m).catch((e:unknown)=>send({type:'error',code:e instanceof Error&&['claude_provider_policy_rejection','claude_auth_failed','claude_session_not_found','claude_budget_exceeded','claude_session_mismatch','claude_credentials_invalid','claude_router_credentials_mismatch','claude_capability_unavailable'].includes(e.message)?e.message:'claude_query_failed'})).finally(()=>{
    for(const done of decisions.values())done(undefined);closing=true;if(process.connected)process.disconnect();
    // Parent owns the process group and kills any remaining CLI/tool descendants on exit.
    setTimeout(()=>process.exit(0),100).unref();
  });
});
