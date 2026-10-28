import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateChangelog } from '../scripts/changelog.js';

function repo(t:{after(fn:()=>void):void}) {
  const root=mkdtempSync(join(tmpdir(),'namo-changelog-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.invalid'};
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git('init');let n=0;
  const commit=(message:string,version?:string)=>{
    if(version)writeFileSync(join(root,'package.json'),JSON.stringify({name:'namo-fixture',version}));
    else writeFileSync(join(root,'file.txt'),String(++n));
    git('add','package.json','file.txt');git('commit','--allow-empty','-m',message);
  };
  // Both paths exist before the first git add.
  writeFileSync(join(root,'file.txt'),'0');commit('chore: baseline','0.2.0');
  return {root,git,commit};
}

test('build derives pending and released changes from version transitions without editing the repository',t=>{
  const r=repo(t);r.commit('feat: add a visible feature');r.commit('docs: internal notes');r.commit('fix(ui): correct task display');
  r.commit('fix: avoid leaking secret contents');
  const before=r.git('status','--porcelain');
  const pending=generateChangelog(r.root,'0.2.0');assert.equal(pending.source,'git');
  assert.equal(pending.releases.length,1);assert.equal(pending.releases[0].version,null);
  assert.deepEqual(pending.releases[0].changes.map(x=>x.text),['correct task display','add a visible feature']);
  assert.equal(r.git('status','--porcelain'),before);
  const beforeCommit=generateChangelog(r.root,'0.3.0');assert.equal(beforeCommit.releases[0].version,'0.3.0');
  assert.equal(beforeCommit.releases[0].date,null);assert.equal(beforeCommit.releases[0].changes.length,2);
  assert.equal(generateChangelog(r.root,'0.3.0-rc.1+build.7').releases[0].version,'0.3.0-rc.1+build.7');
  r.commit('chore: release 0.3.0','0.3.0');r.commit('perf: improve startup');
  const after=generateChangelog(r.root,'0.3.0');
  assert.deepEqual(after.releases.map(x=>x.version),[null,'0.3.0']);
  assert.deepEqual(after.releases[0].changes.map(x=>x.text),['improve startup']);
  assert.deepEqual(after.releases[1].changes.map(x=>x.text),['correct task display','add a visible feature']);
  const next=generateChangelog(r.root,'0.4.0');assert.deepEqual(next.releases.map(x=>x.version),['0.4.0','0.3.0']);
});

test('missing, unrelated or incomplete repository history uses the offline fallback',t=>{
  const r=repo(t),outside=join(r.root,'nested');mkdirSync(outside);
  assert.equal(generateChangelog(outside,'0.3.0').source,'fallback');
  assert.equal(generateChangelog(r.root,'not-a-version').source,'fallback');
  const clone=join(tmpdir(),`namo-changelog-clone-${process.pid}-${Date.now()}`);t.after(()=>rmSync(clone,{recursive:true,force:true}));
  execFileSync('git',['clone','--depth','1',`file://${r.root}`,clone],{stdio:'ignore'});
  assert.equal(generateChangelog(clone,'0.2.0').source,'fallback');
});

test('features merged from a branch appear in the appropriate version exactly once',t=>{
  const r=repo(t),main=r.git('branch','--show-current');
  r.git('checkout','-b','topic');r.commit('feat: add merged capability');
  r.git('checkout',main);r.git('merge','--no-ff','--no-edit','topic');
  const pending=generateChangelog(r.root,'0.2.0');
  assert.deepEqual(pending.releases[0].changes.map(x=>x.text),['add merged capability']);
  r.commit('chore: release 0.3.0','0.3.0');
  const released=generateChangelog(r.root,'0.3.0');
  assert.deepEqual(released.releases.map(x=>x.version),['0.3.0']);
  assert.deepEqual(released.releases[0].changes.map(x=>x.text),['add merged capability']);
});

test('version bumps merged from a branch use the merge as the release boundary',t=>{
  const r=repo(t),main=r.git('branch','--show-current');r.git('checkout','-b','release-branch');
  r.commit('feat: add a released capability');r.commit('chore: release 0.3.0','0.3.0');
  r.git('checkout',main);r.git('merge','--no-ff','--no-edit','release-branch');
  const result=generateChangelog(r.root,'0.3.0');
  assert.equal(result.source,'git');assert.deepEqual(result.releases.map(x=>x.version),['0.3.0']);
  assert.deepEqual(result.releases[0].changes.map(x=>x.text),['add a released capability']);
});
