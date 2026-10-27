import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RuntimeError, type Runtime, type RunRequest, type RunResult } from './runtime.js';
import { claudeBaseEnvironment, privateClaudeDirectory, validateClaudeConfig, withinClaudeWorkspace, type ClaudeConfig } from './claude-config.js';

export interface ClaudePermission { id:string; tool:string; input:Record<string,unknown>; signal:AbortSignal }
export interface ClaudeRunRequest extends RunRequest {
  onPermission?: (request:ClaudePermission)=>Promise<boolean>;
  onTools?: (tools:string[])=>void;
  onQuestion?: (request:ClaudePermission)=>Promise<Record<string,string>|undefined>;
}
/** Experimental SDK worker. Not registered for production scheduling in R7.2 validation. */
export class ClaudeRuntime implements Runtime {
  constructor(readonly config:ClaudeConfig) { validateClaudeConfig(config); }
  async run(r:ClaudeRunRequest):Promise<RunResult> {
    if(process.platform==='win32')throw new RuntimeError('claude_process_isolation_unverified');
    const root=realpathSync(this.config.validationRoot),cwd=realpathSync(r.cwd);
    if(!withinClaudeWorkspace(root,cwd))throw new RuntimeError('claude_validation_workspace_required');
    if(r.onWait)throw new RuntimeError('claude_durable_wait_unverified');
    if(r.images?.length||r.onReview)throw new RuntimeError('claude_capability_unavailable');
    if(r.signal.aborted)throw new RuntimeError('cancelled');
    const home=privateClaudeDirectory(this.config.home),turnId=`claude-run:${randomUUID()}`;
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./claude-worker.js',import.meta.url))],{
        cwd,env:claudeBaseEnvironment(home),stdio:['ignore','ignore','ignore','ipc'],detached:true});
      let finished=false,result:RunResult|undefined,threadId=r.threadId,terminalError:string|undefined,announced=false;
      const pending=new Set<string>(), controller=new AbortController();
      let killTimer:NodeJS.Timeout|undefined;
      const kill=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal);}catch{/* already exited */}};
      const timer=setTimeout(()=>stop('runtime_timeout'),this.config.timeoutMs);
      const finish=(error?:string)=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);r.signal.removeEventListener('abort',cancel);controller.abort();kill('SIGKILL');
        if(error||!result)reject(new RuntimeError(error??'claude_runtime_disconnected'));else resolve(result);};
      const stop=(code:string)=>{if(finished||terminalError)return;terminalError=code;controller.abort();kill('SIGTERM');killTimer=setTimeout(()=>finish(code),2000);};
      const cancel=()=>stop('cancelled');r.signal.addEventListener('abort',cancel,{once:true});
      child.once('error',()=>finish('claude_spawn_failed'));
      child.once('exit',(code)=>finish(terminalError??(code!==0?'claude_worker_failed':undefined)));
      child.on('message',async (message:any)=>{
        if(finished||terminalError||!message||typeof message!=='object')return;
        try {
          if(message.type==='tools')r.onTools?.(message.names);
          else if(message.type==='thread'){
            if(typeof message.id!=='string'||!message.id||message.id.length>256||(threadId&&message.id!==threadId))return stop('claude_session_mismatch');
            if(!threadId){threadId=message.id;r.onThread(message.id);}if(!announced){announced=true;r.onTurn(turnId);}
          } else if(message.type==='progress'){
            if(threadId)r.onProgress?.({...message.event,threadId,turnId});
          } else if(message.type==='evidence'){
            r.onEvidence?.(message.item);
          } else if(message.type==='permission'||message.type==='question'){
            if(typeof message.id!=='string'||pending.has(message.id))return stop('claude_permission_protocol');
            pending.add(message.id);const request={id:message.id,tool:message.tool,input:message.input,signal:controller.signal};
            const answer=message.type==='question'?await r.onQuestion?.(request):await r.onPermission?.(request);
            if(!finished&&!terminalError&&child.connected)child.send({type:'decision',id:message.id,answer},error=>{if(error)stop('claude_runtime_disconnected');});
          } else if(message.type==='result'){
            if(!threadId||message.threadId!==threadId||typeof message.text!=='string'||message.text.length>60000)return stop('claude_result_invalid');
            result={text:message.text,threadId,turnId};
          } else if(message.type==='error')stop(['claude_provider_policy_rejection','claude_auth_failed','claude_session_not_found','claude_budget_exceeded','claude_session_mismatch','claude_credentials_invalid','claude_router_credentials_mismatch','claude_capability_unavailable'].includes(message.code)?message.code:'claude_query_failed');
        } catch { stop('claude_callback_failed'); }
      });
      child.once('spawn',()=>{if(r.signal.aborted)return cancel();try {r.onProcess?.(child.pid!);r.onReady?.({steer:async()=> 'rejected'});r.onActivity?.('working');
        child.send({type:'run',config:this.config,cwd,prompt:r.prompt,threadId:r.threadId},error=>{if(error)stop('claude_runtime_disconnected');});}catch{stop('claude_callback_failed');}});
    });
  }
}
