import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Cards, renderTaskCard } from '../src/cards.js';
import { Engine, SendError } from '../src/engine.js';
import { Feedback } from '../src/feedback.js';
import { cardMarkdown, hasMarkdown, openFence, richPost, splitDisplay } from '../src/richtext.js';

function fixture(t:any){
  const dir=mkdtempSync(join(tmpdir(),'namo-format-')),store=new Store(join(dir,'db'));
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  store.enqueue({key:'m',messageId:'original',chatId:'chat',chatKey:'chat',senderId:'alice',text:'do work'});
  const tasks=new Tasks(store),task=tasks.create(store.get('m')!,{cwd:dir,policyHash:'policy'}),run=tasks.start(task);
  return {dir,store,tasks,task,run};
}
const until=async(fn:()=>boolean)=>{const end=Date.now()+5000;while(!fn()){if(Date.now()>end)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}};

test('normal Markdown replies use rich posts both on first send and after persisted preparation',async t=>{
  for(const prepared of [false,true])for(const answer of ['> quotation','_italic_','~~removed~~','| A | B |\n| --- | --- |\n| 1 | 2 |']){
    await t.test(`${prepared?'prepared':'fresh'} ${answer.slice(0,12)}`,async t=>{
      const f=fixture(t),posts:object[]=[],texts:string[]=[];f.tasks.finish(f.task,f.run,answer);
      if(prepared)new Cards(f.store).prepare(f.store.nextOutput()!);
      const engine=new Engine(f.store,{async run(){throw Error('must not rerun');}}, {
        async send(_c,text,id){texts.push(text);return id;},async sendPost(_c,post,id){posts.push(post);return id;},
        async sendCard(){throw Error('simple reply needs no card');},
      },{dataDir:f.dir,concurrency:1,feishu:{cards:true}});
      try {engine.start();await until(()=>f.store.get('m')?.state==='replied');assert.equal(posts.length,1);assert.deepEqual(texts,[]);
        assert.equal(f.store.db.prepare("SELECT content FROM output_sources WHERE kind='result'").get()?.content,answer);
      }finally{await engine.stop();}
    });
  }
});

test('format rejection allows exactly one plain fallback; ambiguous sends are never retried',async t=>{
  for(const unknown of [false,true])await t.test(String(unknown),async t=>{
    const f=fixture(t);f.tasks.finish(f.task,f.run,'**bold**');new Cards(f.store).prepare(f.store.nextOutput()!);
    let posts=0,texts=0;const engine=new Engine(f.store,{async run(){throw Error('must not rerun');}}, {
      async send(_c,_text,id){texts++;return id;},async sendPost(){posts++;throw new SendError(unknown,unknown?'timeout':'feishu_230099');},
      async sendCard(){throw Error('unexpected card');},
    },{dataDir:f.dir,concurrency:1,feishu:{cards:true}});
    try {engine.start();await until(()=>['replied','delivery_unknown'].includes(f.store.get('m')!.state));
      assert.equal(posts,1);assert.equal(texts,unknown?0:1);assert.equal(f.store.get('m')?.state,unknown?'delivery_unknown':'replied');
    }finally{await engine.stop();}
  });
});

test('result cards use the code-capable component and degrade unsupported blocks without altering stored answers',t=>{
  const f=fixture(t),answer='# Heading\n> quote\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```';
  const card=renderTaskCard(f.task,answer,'result',0) as any;
  assert.equal(card.elements[0].tag,'markdown');assert.equal(card.config.update_multi,true);
  const rendered=cardMarkdown(answer);assert.match(rendered,/\*\*Heading\*\*/);assert.match(rendered,/```(?:text)?\n\| A/);
  assert.match(rendered,/```ts\nconst x = 1;/);assert.doesNotMatch(rendered,/^# Heading/m);
  assert.doesNotMatch(cardMarkdown('<at user_id="all">all</at> ![x](https://example.com/a.png) [bad](javascript:alert)'),/<at|!\[x\]|javascript:/);
  for(const value of ['> quote','_italic_','*italic*','~~strike~~','|a|b|\n|---|---|'])assert.equal(hasMarkdown(value),true);
  assert.equal(cardMarkdown('# C#'),'**C#**');assert.equal(cardMarkdown('# C# ###'),'**C#**');
  assert.match(cardMarkdown('| one |\n| --- |\n| value |'),/^```text\n/);
});

test('split code fences retain their marker and length and do not swallow following prose',()=>{
  for(const fence of ['~~~','````']){
    const source=`${fence}js\n${'const x = 1;\n'.repeat(220)}${fence}\n# After`;
    const chunks=splitDisplay(source);let prefix='';
    for(const chunk of chunks){const continuation=openFence(prefix),post=richPost(chunk,continuation??false) as any;
      const rendered=post.zh_cn.content[0][0].text;if(continuation)assert.ok(rendered.startsWith(fence+'\n'));
      assert.equal(openFence(rendered),undefined);prefix+=chunk;
      if(chunk.includes('# After'))assert.ok(rendered.endsWith('# After'));
    }assert.equal(chunks.join(''),source);
  }
});

test('viewing details repeatedly does not stop shared progress updates or repeat final delivery',async t=>{
  const f=fixture(t);f.store.addOutput('m','progress','started');const output=f.store.nextOutput()!,cards=new Cards(f.store);
  const initial=cards.prepare(output) as any;assert.equal(initial.config.update_multi,true);f.store.sending(output.id);f.store.sent(output.id,'card-id');
  const token=f.store.db.prepare("SELECT token FROM card_actions WHERE action='details'").get()!.token;
  const event={operator:{open_id:'alice'},context:{open_chat_id:'chat',open_message_id:'card-id'},action:{value:{namo:String(token)}}};
  const patches:any[]=[];const feedback=new Feedback(f.store,{async send(){throw Error('no new card');},async updateCard(id,card){assert.equal(id,'card-id');patches.push(card);}});
  await feedback.tick({cadenceMs:0,heartbeatMs:0});cards.accept(event);cards.accept(event);
  f.store.db.prepare('UPDATE tasks SET startedAt=startedAt-5000 WHERE id=?').run(f.task.id);
  await feedback.tick({cadenceMs:0,heartbeatMs:0});assert.equal(patches.length,2);assert.notDeepEqual(patches[0],patches[1]);
  f.tasks.finish(f.task,f.run,'done');await feedback.tick({cadenceMs:0,heartbeatMs:0});await feedback.tick({cadenceMs:0,heartbeatMs:0});
  assert.equal(patches.length,3);for(const patch of patches)assert.equal(patch.config.update_multi,true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind LIKE 'card-status:%'").get()?.n,1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE kind='result'").get()?.n,1);
});
