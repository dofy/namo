import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeRuntime } from '../src/claude-runtime.js';
import { readClaudeEnv, type ClaudeAuth } from '../src/claude-config.js';

async function main():Promise<void>{
  const args=process.argv.slice(2),flag=(key:string)=>args[args.indexOf(key)+1];
  if(!args.includes('--live')||!args.includes('--auth')||!args.includes('--bin'))throw new Error('usage: --live --auth router|official-api-key|official-login --bin /path/to/claude [--env-file /private/file]');
  const mode=flag('--auth');let auth:ClaudeAuth;
  if(mode==='official-login')auth={mode};
  else if((mode==='router'||mode==='official-api-key')&&args.includes('--env-file')){
    const envFile=resolve(flag('--env-file'));
    auth=mode==='router'?{mode,envFile,baseUrl:readClaudeEnv(envFile).ANTHROPIC_BASE_URL}:{mode,envFile};
  }else throw new Error('claude_auth_mode_invalid');
  const root=realpathSync(mkdtempSync(join(tmpdir(),'namo-claude-validation-'))),cwd=join(root,'project'),home=args.includes('--profile-home')?resolve(flag('--profile-home')):join(root,'home');mkdirSync(cwd,{mode:0o700});
  const runtime=new ClaudeRuntime({bin:realpathSync(flag('--bin')),home,validationRoot:root,auth,timeoutMs:45000});
  const report:Record<string,unknown>={...(args.includes('--keep')?{root}:{}),route:mode,productionAdapterEnabled:false,providerCancellationReceipt:false};
  const progress:unknown[]=[],permissions:string[]=[],evidence:unknown[]=[];
  const request=(prompt:string,threadId?:string)=>({prompt,cwd,threadId,signal:new AbortController().signal,onThread(){},onTurn(){},
    onTools:(tools:string[])=>{report.advertisedTools=tools;},onProgress:(event:unknown)=>{progress.push(event);},onEvidence:(event:unknown)=>{evidence.push(event);}});
  try {
    if(!args.includes('--tools-only')) {
    const nonce='NAMO-'+randomUUID();
    const first=await runtime.run(request(`Remember this token: ${nonce}. Reply with exactly ${nonce}. Do not call any tools.`));
    report.exactReply=first.text.trim()===nonce;
    try {const resumed=await runtime.run(request('What was the token? Reply only with that exact token. Do not call tools.',first.threadId));
    report.exactResume=resumed.threadId===first.threadId&&resumed.text.trim()===nonce;}catch(e){report.resumeError=(e as Error).message;}
    }
    const target=join(cwd,'accepted.txt');writeFileSync(target,'BEFORE');
    await runtime.run({...request('Use Read to read accepted.txt, then Edit to replace BEFORE with NAMO_WRITE_OK. Use the native Edit tool, not Bash. After it succeeds reply DONE.'),onPermission:async p=>{permissions.push(p.tool);return ['Read','Edit'].includes(p.tool)&&resolve(cwd,String(p.input.file_path))===target;}});
    report.permissionTools=[...new Set(permissions)];report.editPermission=permissions.includes('Edit');report.writeEffect=existsSync(target)&&readFileSync(target,'utf8').trim()==='NAMO_WRITE_OK';
    const denied=join(cwd,'denied.txt');writeFileSync(denied,'BEFORE');let denies=0;
    await runtime.run({...request('Use Edit to replace BEFORE with SHOULD_NOT_EXIST in denied.txt. Do not use Bash. If permission is refused stop and reply DENIED.'),onPermission:async()=>{denies++;return false;}});
    report.denyRequested=denies>0;report.denyEffect=readFileSync(denied,'utf8')==='BEFORE';
    if((report.advertisedTools as string[]|undefined)?.includes('AskUserQuestion')) {
    let question=false;
    const answer=await runtime.run({...request('Call AskUserQuestion to ask which color to choose (blue or red). After the answer reply only with the selected color. You must call the tool.'),onQuestion:async p=>{
      question=true;const qs=p.input.questions as Array<{question:string}>;return Object.fromEntries(qs.map(q=>[q.question,'blue']));}});
    report.questionCallback=question;report.questionAnswer=question&&answer.text.trim().toLowerCase()==='blue';
    } else report.questionUnavailable=true;
    const controller=new AbortController();let initialized=false;const start=Date.now();
    try{await runtime.run({...request('Run Bash with exactly /bin/sleep 30 and then reply DONE.'),signal:controller.signal,onThread(){initialized=true;setTimeout(()=>controller.abort(),250);},onPermission:async p=>p.tool==='Bash'&&p.input.command==='/bin/sleep 30'});report.cancelled=false;}
    catch(e){report.cancelled=controller.signal.aborted&&(e as Error).message==='cancelled';}
    report.cancelAfterInit=initialized;report.cancelDurationMs=Date.now()-start;report.toolEvidenceObserved=evidence.length>0;report.progressObserved=progress.length>0;
  }catch(e){report.error=e instanceof Error&&/^claude_|^runtime_timeout$/.test(e.message)?e.message:'validation_failed';}
  finally{
    const required=['editPermission','writeEffect','denyRequested','denyEffect','cancelled','toolEvidenceObserved','progressObserved',
      ...(!args.includes('--tools-only')?['exactReply','exactResume','questionCallback','questionAnswer']:[])];
    report.missingEvidence=required.filter(key=>report[key]!==true);
    report.status=(report.missingEvidence as string[]).length?'incomplete':'passed';
    if(report.status==='incomplete')process.exitCode=2;
    console.log(JSON.stringify(report));
    if(args.includes('--report'))writeFileSync(resolve(flag('--report')),JSON.stringify(report,null,2)+'\n',{mode:0o600});
    if(!args.includes('--keep'))rmSync(root,{recursive:true,force:true});
  }
}
void main().catch(()=>{console.error('claude_validation_setup_failed');process.exitCode=1;});
