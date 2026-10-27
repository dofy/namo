import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crc32} from 'node:zlib';
import {Store} from '../src/store.js';
import {Tasks} from '../src/tasks.js';
import {TaskImages,inspectImage,loadRunImages,saveRunImages,verifyImageInput} from '../src/image-inputs.js';
import {taskMaterials} from '../src/task-materials.js';
import {Engine} from '../src/engine.js';
import type {MaterialReadAdapter,MaterialSource} from '../src/materials.js';
// Real 2x2 RGB images encoded independently with Pillow/libjpeg, not parser-shaped headers.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8H8DAwMDAxMDAwGjwHwASPwKDhuq9kQAAAABJRU5ErkJggg==','base64');
const JPEG=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAZEAADAQEBAAAAAAAAAAAAAAAAAQIDEUH/xAAVAQEBAAAAAAAAAAAAAAAAAAACBP/EABkRAAEFAAAAAAAAAAAAAAAAAAABAgMzcf/aAAwDAQACEQMRAD8Al6aWtKSuudfoAFDW3ELprXap/9k=','base64');
const PROGRESSIVE_JPEG=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAVAQEBAAAAAAAAAAAAAAAAAAABA//aAAwDAQACEAMQAAABlDf/xAAVEAEBAAAAAAAAAAAAAAAAAAABIf/aAAgBAQABBQJb/8QAFxEAAwEAAAAAAAAAAAAAAAAAAAECMv/aAAgBAwEBPwG9M//EABcRAAMBAAAAAAAAAAAAAAAAAAABAjL/2gAIAQIBAT8BjKP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAXEAEAAwAAAAAAAAAAAAAAAAABABEh/9oACAEBAAE/IUtrP//aAAwDAQACAAMAAAAQA//EABYRAAMAAAAAAAAAAAAAAAAAAAABof/aAAgBAwEBPxCpn//EABYRAAMAAAAAAAAAAAAAAAAAAAABof/aAAgBAgEBPxCBH//EABcQAQEBAQAAAAAAAAAAAAAAAAERAEH/2gAIAQEAAT8QCBKvd//Z','base64');
const source:MaterialSource={appId:'app',ownerId:'alice',chatId:'chat',messageId:'image-message'};
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'namo-images-')),store=new Store(join(dir,'db'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {dir,store};}
function adapter(bytes:Uint8Array=PNG):MaterialReadAdapter{return {async readMessage(){throw Error('no history');},async readResource(request){assert.equal(request.kind,'image');assert.equal(request.chatId,'chat');assert.ok(request.maxBytes<=5_000_000);return {bytes};}};}
const limits=()=>({maxBytes:10_000_000,deadlineMs:Date.now()+5000});
function pngChunk(type:string,data:Buffer):Buffer {
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write(type,4);data.copy(chunk,8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);return chunk;
}

test('real PNG and baseline/progressive JPEG images pass bounded structure inspection',()=>{
  assert.deepEqual(inspectImage(PNG),{mime:'image/png',width:2,height:2});
  for(const bytes of [JPEG,PROGRESSIVE_JPEG])assert.deepEqual(inspectImage(bytes),{mime:'image/jpeg',width:2,height:2});
  for(const bytes of [Buffer.from('<svg/>'),Buffer.from('GIF89a'),PNG.subarray(0,20)])assert.throws(()=>inspectImage(bytes));
  const huge=Buffer.from(PNG);huge.writeUInt32BE(100000,16);huge.writeUInt32BE(crc32(huge.subarray(12,29)),29);
  assert.throws(()=>inspectImage(huge),/dimensions/);
});
test('PNG requires ordered image data, valid chunks and a final IEND',()=>{
  const header=PNG.subarray(0,33),end=PNG.subarray(-12),data=PNG.subarray(41,-16);
  const noData=Buffer.concat([header,end]);
  const interruptedData=Buffer.concat([header,pngChunk('IDAT',data.subarray(0,4)),pngChunk('tEXt',Buffer.from('note\0x')),pngChunk('IDAT',data.subarray(4)),end]);
  const corrupt=Buffer.from(PNG);corrupt[44]^=1;
  for(const bytes of [noData,interruptedData,corrupt,PNG.subarray(0,-12),Buffer.concat([PNG,Buffer.from([0])])])assert.throws(()=>inspectImage(bytes),/image_invalid/);
  assert.throws(()=>inspectImage(Buffer.concat([header,pngChunk('acTL',Buffer.alloc(8)),PNG.subarray(33)])),/animation_unsupported/);
});
test('JPEG requires complete frame/table/scan structure and nonempty entropy data',()=>{
  const sos=JPEG.indexOf(Buffer.from([255,218])),scanStart=sos+2+JPEG.readUInt16BE(sos+2),end=JPEG.subarray(-2);
  const noScan=Buffer.concat([JPEG.subarray(0,sos),end]);
  const emptyScan=Buffer.concat([JPEG.subarray(0,scanStart),end]);
  const noFrame=Buffer.from([255,216,255,192,0,8,8,0,1,0,1,0,255,217]);
  const invalidLength=Buffer.from(JPEG);invalidLength.writeUInt16BE(65535,sos+2);
  const firstTable=JPEG.indexOf(Buffer.from([255,219])),tableEnd=firstTable+2+JPEG.readUInt16BE(firstTable+2);
  const missingTable=Buffer.concat([JPEG.subarray(0,firstTable),JPEG.subarray(tableEnd)]);
  for(const bytes of [noScan,emptyScan,noFrame,invalidLength,missingTable,JPEG.subarray(0,-2)])assert.throws(()=>inspectImage(bytes),/image_invalid/);
});
test('image cache binds task, owner, chat and resource; snapshots reject tampering and symlinks',async t=>{
  const f=fixture(t),images=new TaskImages(f.store,f.dir,'task-one');let reads=0;
  const transport=adapter(),original=transport.readResource;transport.readResource=async request=>{reads++;return original(request);};
  const expansion=await images.expand(source,{type:'image',resourceKey:'image-key'},transport,limits());
  assert.equal(expansion.state,'accessed');const selected=images.selected([expansion]);assert.equal(selected.length,1);
  assert.doesNotMatch(JSON.stringify(expansion),/material-images|base64|data:image/);
  await images.expand(source,{type:'image',resourceKey:'image-key'},transport,limits());assert.equal(reads,1);
  saveRunImages(f.store,'run',selected);assert.deepEqual(loadRunImages(f.store,f.dir,'run'),selected);
  const another=new TaskImages(f.store,f.dir,'task-two');const other=await another.expand({...source,ownerId:'bob'},{type:'image',resourceKey:'image-key'},transport,limits());
  assert.notEqual(another.selected([other])[0].path,selected[0].path);assert.equal(reads,2);
  chmodSync(selected[0].path,0o600);writeFileSync(selected[0].path,'changed');assert.throws(()=>loadRunImages(f.store,f.dir,'run'),/snapshot_changed/);
  rmSync(selected[0].path);symlinkSync(another.selected([other])[0].path,selected[0].path);assert.throws(()=>verifyImageInput(f.dir,selected[0]));
});
test('image errors remain explicit and do not include adapter errors or secrets',async t=>{
  const f=fixture(t),images=new TaskImages(f.store,f.dir,'task');
  const transport=adapter();transport.readResource=async()=>{throw Error('PRIVATE_TOKEN_AND_RAW_ERROR');};
  const failed=await images.expand(source,{type:'image',resourceKey:'key'},transport,limits());assert.equal(failed.state,'failed');
  assert.doesNotMatch(JSON.stringify(failed),/PRIVATE_TOKEN/);assert.equal(images.selected([failed]).length,0);
  const invalid=await images.expand(source,{type:'image',resourceKey:'invalid'},adapter(Buffer.from('<svg/>')),limits());assert.equal(invalid.nodes[0].error,'image_type_unsupported');
  assert.equal(invalid.nodes[0].bytes,6);assert.deepEqual(invalid.nodes[0].stages,['received','accessed','failed']);
  const oversized=await images.expand(source,{type:'image',resourceKey:'large'},adapter(new Uint8Array(5_000_001)),limits());assert.equal(oversized.nodes[0].error,'image_bytes_limit');
  assert.equal(oversized.nodes[0].bytes,5_000_001);
});
test('failed stream reads charge reported bytes or conservatively reserve their allowance',async t=>{
  const f=fixture(t),images=new TaskImages(f.store,f.dir,'task'),transport=adapter();
  transport.readResource=async()=>{throw Object.assign(Error('PRIVATE_PARTIAL_ERROR'),{bytesRead:123});};
  const partial=await images.expand(source,{type:'image',resourceKey:'partial'},transport,limits());
  assert.equal(partial.nodes[0].bytes,123);assert.equal(partial.nodes[0].error,'image_access_failed');assert.doesNotMatch(JSON.stringify(partial),/PRIVATE/);
  transport.readResource=async()=>{throw Error('material_bytes_limit');};
  const unknown=await images.expand(source,{type:'image',resourceKey:'unknown'},transport,limits());
  assert.equal(unknown.nodes[0].bytes,5_000_000);assert.equal(unknown.nodes[0].error,'image_bytes_limit');
});
test('invalid downloaded images consume the aggregate byte allowance',async t=>{
  const f=fixture(t);f.store.enqueue({key:'m',messageId:source.messageId,chatId:'chat',chatKey:'chat',senderId:'alice',text:'Read images',
    envelope:{version:1,type:'post',kind:'instruction',scopeKey:'chat',materials:Array.from({length:4},(_,i)=>({type:'image',resourceKey:`bad-${i}`})),limitations:[]}});
  const task=new Tasks(f.store).create(f.store.get('m')!,{cwd:f.dir,policyHash:'policy'}),images=new TaskImages(f.store,f.dir,task.id);
  let reads=0,downloaded=0;const transport=adapter(new Uint8Array(5_000_000)),original=transport.readResource;
  transport.readResource=async request=>{const resource=await original(request);reads++;downloaded+=resource.bytes.length;return resource;};
  const expanded=await taskMaterials(f.store,task,'app',transport,s=>s,{},(...args)=>images.expand(...args));
  assert.equal(reads,2);assert.equal(downloaded,10_000_000);assert.equal(images.selected(expanded).length,0);
  assert.ok(expanded.some(item=>item.nodes.some(node=>node.error==='material_total_bytes_limit')));
});
test('task aggregate selects only bounded images actually included in the material context',async t=>{
  const f=fixture(t);f.store.enqueue({key:'m',messageId:source.messageId,chatId:'chat',chatKey:'chat',senderId:'alice',text:'Read images',
    envelope:{version:1,type:'post',kind:'instruction',scopeKey:'chat',materials:Array.from({length:6},(_,i)=>({type:'image',resourceKey:`key-${i}`})),limitations:[]}});
  const task=new Tasks(f.store).create(f.store.get('m')!,{cwd:f.dir,policyHash:'policy'}),images=new TaskImages(f.store,f.dir,task.id);let reads=0;
  const transport=adapter(),original=transport.readResource;transport.readResource=async request=>{reads++;return original(request);};
  const expanded=await taskMaterials(f.store,task,'app',transport,s=>s,{},(...args)=>images.expand(...args));
  assert.equal(reads,4);assert.equal(images.selected(expanded).length,4);assert.ok(expanded.some(e=>e.truncated));
  const constrained=new TaskImages(f.store,f.dir,task.id);
  const omitted=await taskMaterials(f.store,task,'app',transport,s=>s,{maxSerializedChars:800},(...args)=>constrained.expand(...args));
  assert.equal(constrained.selected(omitted).length,0,'an omitted expansion never sends a hidden image');
});
test('Engine passes actual image inputs separately from the text prompt',async t=>{
  const f=fixture(t);let received=false;
  const engine=new Engine(f.store,{async run(request){received=true;assert.equal(request.images?.length,1);verifyImageInput(f.dir,request.images![0]);
    assert.doesNotMatch(request.prompt,/material-images|image_runtime_handoff_not_verified|data:image/);
    assert.match(request.prompt,/imageId/);return {text:'seen',threadId:'thread',turnId:'turn'};
  }},{materials:adapter(),async send(_c,_text,id){return id;}},{dataDir:f.dir,concurrency:1});
  try{engine.start();engine.accept({key:'m',messageId:source.messageId,chatId:'chat',chatKey:'chat',senderId:'alice',text:'What is shown?',
    envelope:{version:1,type:'post',kind:'instruction',scopeKey:'chat',materials:[{type:'image',resourceKey:'key'}],limitations:[]}});
    const deadline=Date.now()+5000;while(f.store.get('m')?.state!=='replied'){if(Date.now()>deadline)throw Error('timeout');await new Promise(r=>setTimeout(r,10));}assert.equal(received,true);
  }finally{await engine.stop();}
});
