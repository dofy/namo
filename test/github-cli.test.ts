import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { configureGitHub } from '../src/github-cli.js';
import type { Prompter } from '../src/prompts.js';
import { withLocale } from '../src/locale.js';
import { Management } from '../src/management.js';

test('GitHub wizard hides token input and saves only explicit scopes after confirmation',async t=>{
  const root=mkdtempSync(join(tmpdir(),'namo-github-cli-')),data=join(root,'data'),project=join(root,'project'),file=join(root,'config.json');
  t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(data);mkdirSync(project);
  writeFileSync(file,JSON.stringify({dataDir:data,feishu:{appId:'fixture',appSecret:'fake-feishu',allowedUserIds:['alice','bob']},
    codex:{bin:'codex',home:join(data,'auth'),sandbox:'read-only',projects:{app:project},defaultProject:'app'}}));new Store(join(data,'bot.sqlite')).close();
  const lines:string[]=[],inputs=['example/private','fake-github-credential'],answers=[false,false,true,false,true];
  const ui:Prompter={async text(label,_initial,secret){lines.push(label);if(inputs.length===1)assert.equal(secret,true);return inputs.shift()!;},
    async confirm(label){lines.push(label);return answers.shift()!;},info(value){lines.push(value);},close(){}};
  await withLocale('en',()=>configureGitHub(file,ui));
  const saved=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(saved.github,{repositories:['example/private'],allowedUserIds:['alice'],token:'fake-github-credential'});
  assert.equal(statSync(file).mode&0o777,0o600);assert.doesNotMatch(lines.join('\n'),/fake-github-credential/);
  assert.match(lines.join('\n'),/GitHub/);assert.doesNotMatch(lines.join('\n'),/[\u4e00-\u9fff]/);
  const before=readFileSync(file,'utf8');
  await configureGitHub(file,{...ui,async text(_label,initial){return initial??'';},async confirm(){return false;}});
  assert.equal(readFileSync(file,'utf8'),before);
});

test('local GitHub wizard uses the sole paired owner and never asks for token or repositories',async t=>{
 const root=mkdtempSync(join(tmpdir(),'namo-gh-cli-')),data=join(root,'data'),file=join(root,'config.json');
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(data);
 writeFileSync(file,JSON.stringify({dataDir:data,feishu:{appId:'fixture',appSecret:'fake-feishu',allowedUserIds:['alice']},
  codex:{bin:'codex',home:join(data,'auth'),sandbox:'read-only',projects:{app:root},defaultProject:'app'}}));new Store(join(data,'bot.sqlite')).close();
 const local={executable:'/usr/bin/gh',configDir:'/tmp/gh-fixture',login:'owner',userId:42};
 const manager=new Management(file,{localGh:async()=>local}),lines:string[]=[];
 await withLocale('en',()=>configureGitHub(file,{async text(){throw Error('unexpected credential prompt');},async confirm(){return true;},info(s){lines.push(s);},close(){}},manager));
 assert.equal(manager.config().github.credentialSource,'gh');assert.equal(manager.config().github.localGh.login,'owner');
 assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).github.allowedUserIds,['alice']);assert.doesNotMatch(lines.join('\n'),/[\u4e00-\u9fff]/);
});
