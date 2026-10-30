import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeFixture } from './helpers.js';
import { redactExpiredInbox } from '../src/inbox-retention.js';
import { parseConfig } from '../src/config.js';

test('retention requires explicit acknowledgement and ignores unrelated legacy configuration',()=>{
 const base={dataDir:'/tmp/namo-retention-config',feishu:{},codex:{}};
 assert.equal(parseConfig({...base,retention:{enabled:true,inboxDays:30}},'/tmp/namo-retention-config/config.json').retention,undefined);
 assert.equal(parseConfig({...base,retention:{custom:'legacy'}},'/tmp/namo-retention-config/config.json').retention,undefined);
 assert.deepEqual(parseConfig({...base,retention:{enabled:true,inboxDays:30,acknowledgeRedaction:true}},'/tmp/namo-retention-config/config.json').retention,{enabled:true,inboxDays:30});
});

test('optional retention redacts only completed messages received after activation',t=>{
 const {store}=storeFixture(t,'namo-retention-'),start=1_000_000_000,day=86_400_000;
 const add=(key:string,createdAt:number,state:string)=>{store.enqueue({key,messageId:key,chatKey:'chat',chatId:'chat',senderId:'owner',text:`private ${key}`,createdAt,
  envelope:{version:1,type:'text',kind:'instruction',chatType:'p2p',scopeKey:'chat',materials:[],limitations:[]}});store.db.prepare('UPDATE inbox SET state=? WHERE key=?').run(state,key);};
 add('legacy',start-1,'replied');assert.equal(redactExpiredInbox(store,0,start),0);assert.equal(redactExpiredInbox(store,1,start),0);
 add('new',start+1,'replied');add('pending',start+2,'waiting');
 add('schedule-source',start+3,'replied');
 store.db.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('S-AAAAAAAAAAAA','owner','chat','chat','schedule-source','reminder','reminder',null,start+day,'active',null,start);
 assert.equal(redactExpiredInbox(store,1,start+day+10),1);
 assert.equal(store.get('legacy')?.text,'private legacy');assert.match(store.get('new')!.text,/已按保留策略清理/);assert.equal(store.get('pending')?.text,'private pending');
 assert.equal(store.get('schedule-source')?.text,'private schedule-source');
 assert.equal(redactExpiredInbox(store,1,start+day+20),0);
 redactExpiredInbox(store,0,start+day+21);add('while-disabled',start+day+22,'replied');
 redactExpiredInbox(store,1,start+day+23);assert.equal(redactExpiredInbox(store,1,start+2*day+100),0);
 assert.equal(store.get('while-disabled')?.text,'private while-disabled');
});
