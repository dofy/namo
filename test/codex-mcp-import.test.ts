import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCodexMcp, selectCodexMcp } from '../src/codex-mcp-import.js';

test('Codex discovery exposes only metadata and selectively imports a URL without credentials or commands',t=>{
 const dir=mkdtempSync(join(tmpdir(),'namo-codex-mcp-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'config.toml');
 const contents=`[mcp_servers.docs]\nurl = "https://docs.example/mcp"\nbearer_token_env_var = "PRIVATE_ENV_NAME"\nhttp_headers = { Authorization = "PRIVATE_SECRET" }\n[mcp_servers.local]\ncommand = "PRIVATE_COMMAND"\nargs = ["PRIVATE_ARGUMENT"]\n[mcp_servers.param]\nurl = "https://api.example/mcp?token=PRIVATE_SECRET"\n`;
 writeFileSync(file,contents);const found=listCodexMcp(file),text=JSON.stringify(found);
 assert.doesNotMatch(text,/PRIVATE_|token=/);assert.equal(found.entries.length,3);
 const remote=found.entries.find(v=>v.id==='docs')!;assert.equal(remote.importable,true);assert.equal(remote.requiresOwnAuth,true);
 assert.deepEqual(selectCodexMcp('docs',found.revision,file),{id:'docs',url:'https://docs.example/mcp'});
 assert.equal(found.entries.find(v=>v.id==='local')?.reason,'local_process');
 assert.equal(found.entries.find(v=>v.id==='param')?.reason,'url_parameters');
 assert.throws(()=>selectCodexMcp('local',found.revision,file));assert.equal(readFileSync(file,'utf8'),contents);
 writeFileSync(file,contents+'\n# changed\n');assert.throws(()=>selectCodexMcp('docs',found.revision,file),/codex_mcp_config_changed/);
});


test('management imports selected servers disabled without secrets and rejects stale selections and duplicates',async t=>{
 const {storeFixture}=await import('./helpers.js'),{Management}=await import('../src/management.js'),{loadConfig}=await import('../src/config.js');
 const {dir}=storeFixture(t,'namo-codex-import-'),file=join(dir,'config.json'),source=join(dir,'codex.toml');
 writeFileSync(file,JSON.stringify({dataDir:dir,feishu:{appId:'test',appSecret:'dummy-secret',allowedUserIds:['alice']},codex:{home:join(dir,'home')}}));
 writeFileSync(source,`[mcp_servers.MyDocs]\nurl = "https://docs.example/mcp"\nhttp_headers = { Authorization = "VERY_SECRET" }\n[mcp_servers.other]\nurl = "https://other.example/mcp"\n`);
 const manager=new Management(file,{codexMcpConfig:source}),catalog=manager.codexMcpCatalog(),revision=manager.config().revision;
 const saved=manager.importCodexMcp(revision,catalog.revision,['MyDocs']);
 assert.equal(saved.mcpConnections.length,1);assert.equal(saved.mcpConnections[0].id,'mydocs');assert.equal(saved.mcpConnections[0].enabled,false);
 assert.deepEqual(saved.mcpConnections[0].audience,{organization:false,userIds:[],chatIds:[]});assert.equal(loadConfig(file).mcpConnections![0].token,'');assert.doesNotMatch(readFileSync(file,'utf8'),/VERY_SECRET/);
 assert.throws(()=>manager.importCodexMcp(saved.revision,catalog.revision,['MyDocs']),/codex_mcp_duplicate/);
 writeFileSync(source,readFileSync(source,'utf8')+'\n# changed');assert.throws(()=>manager.importCodexMcp(saved.revision,catalog.revision,['other']),/codex_mcp_config_changed/);
});
