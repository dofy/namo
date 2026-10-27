import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {claudeEnvironment,readClaudeEnv,type ClaudeConfig} from '../src/claude-config.js';
function fixture(t:{after(fn:()=>void):void}){
 const root=mkdtempSync(join(tmpdir(),'claude-auth-')),file=join(root,'auth.env');t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(file,'export ANTHROPIC_API_KEY="test-private-api-key"\nexport ANTHROPIC_AUTH_TOKEN="test-private-router-token"\nexport ANTHROPIC_BASE_URL="https://router.example.test"\nexport ANTHROPIC_MODEL="router-model"\n',{mode:0o600});
 const config:ClaudeConfig={bin:process.execPath,home:join(root,'home'),validationRoot:root,timeoutMs:5000,auth:{mode:'router',envFile:file,baseUrl:'https://router.example.test'}};
 return {root,file,config};
}
test('official login and API key modes cannot inherit router or host credentials',t=>{
 const f=fixture(t);const saved={...process.env};t.after(()=>{for(const k of ['ANTHROPIC_API_KEY','OPENAI_API_KEY'])if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];});process.env.ANTHROPIC_API_KEY='host-key';process.env.OPENAI_API_KEY='host-openai';
 const login=claudeEnvironment({...f.config,auth:{mode:'official-login'}});
 assert.equal(login.ANTHROPIC_API_KEY,undefined);assert.equal(login.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(login.ANTHROPIC_BASE_URL,undefined);assert.equal(login.OPENAI_API_KEY,undefined);
 const officialFile=join(f.root,'official.env');writeFileSync(officialFile,'ANTHROPIC_API_KEY="test-private-api-key"\n',{mode:0o600});
 const official=claudeEnvironment({...f.config,home:join(f.root,'official-home'),auth:{mode:'official-api-key',envFile:officialFile}});
 assert.equal(official.ANTHROPIC_API_KEY,'test-private-api-key');assert.equal(official.ANTHROPIC_AUTH_TOKEN,undefined);assert.equal(official.ANTHROPIC_BASE_URL,undefined);assert.equal(official.ANTHROPIC_MODEL,undefined);
 const router=claudeEnvironment({...f.config,home:join(f.root,'router-home')});assert.equal(router.ANTHROPIC_AUTH_TOKEN,'test-private-router-token');assert.equal(router.ANTHROPIC_BASE_URL,'https://router.example.test');
 assert.throws(()=>claudeEnvironment({...f.config,home:join(f.root,'other-router-home'),auth:{mode:'router',envFile:f.file,baseUrl:'https://unexpected.example.test'}}),/mismatch/);
 assert.throws(()=>claudeEnvironment(f.config),/auth_home_conflict/);
 assert.throws(()=>claudeEnvironment({...f.config,home:join(f.root,'ambiguous-home'),auth:{mode:'official-api-key',envFile:f.file}}),/auth_mode_conflict/);
});
test('credential parser never sources shell and rejects expansions, duplicates and public files',t=>{
 const f=fixture(t);for(const text of ['export ANTHROPIC_API_KEY="$(touch bad)"','export ANTHROPIC_API_KEY="`bad`"','export ANTHROPIC_API_KEY="a"\nexport ANTHROPIC_API_KEY="b"']){
 writeFileSync(f.file,text);assert.throws(()=>readClaudeEnv(f.file),/^Error: claude_credentials_invalid$/);}
 writeFileSync(f.file,'ANTHROPIC_API_KEY="private"\n');chmodSync(f.file,0o644);assert.throws(()=>readClaudeEnv(f.file),/credentials_invalid/);
});
test('symlink credentials and non-private profile homes fail closed',t=>{
 const f=fixture(t),link=join(f.root,'symlink');symlinkSync(f.file,link);assert.throws(()=>readClaudeEnv(link),/credentials_invalid/);
 mkdirSync(f.config.home,{mode:0o755});assert.throws(()=>claudeEnvironment(f.config),/home_not_private/);
});
