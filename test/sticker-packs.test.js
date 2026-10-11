import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';

test('all four animated sticker packs render distinctly and round-trip for visitors and agents',async t=>{
  const context={window:{},document:{createElementNS:()=>({attributes:{},classes:[],setAttribute(key,value){this.attributes[key]=value;},classList:{add(...names){this.owner.classes.push(...names);}},get innerHTML(){return this.markup;},set innerHTML(value){this.markup=value;}}),createTextNode:value=>({textContent:value})}};
  const make=context.document.createElementNS;context.document.createElementNS=()=>{const node=make();node.classList.owner=node;return node;};
  vm.runInNewContext(readFileSync(new URL('../public/stickers.js',import.meta.url),'utf8'),context);
  const stickers=context.window.KivoStickers;
  assert.deepEqual([...stickers.packs],['团团','奶猫','水豚','机器人']);assert.equal(stickers.items.length,26);
  assert.equal(new Set(stickers.items.map(s=>s.id)).size,26);
  for(const family of ['cat','capy','bot'])assert.equal(stickers.items.filter(s=>s.family===family).length,6);
  for(const item of stickers.items){const svg=stickers.render(item.id);assert.equal(svg.attributes['aria-label'],item.label);assert.match(svg.markup,/sticker-body/);if(item.family){assert.ok(svg.classes.includes('family-'+item.family));assert.ok(svg.classes.includes('motion-'+item.motion));}}
  assert.match(stickers.render('cat-dance').markup,/sticker-tail/);assert.match(stickers.render('capy-bath').markup,/sticker-water/);assert.match(stickers.render('bot-party').markup,/sticker-confetti/);
  assert.equal(stickers.render('unknown').textContent,'[表情]');
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-stickers-')),origin='http://localhost:31999';
  const service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'sticker-test-password'}),sockets=[];
  t.after(async()=>{sockets.forEach(socket=>socket.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${service.server.address().port}`;
  const post=(route,body,cookie)=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const login=await post('/api/login',{username:'admin',password:'sticker-test-password'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const site=await (await post('/api/admin/sites',{name:'表情演示',origins:['*']},cookie)).json();
  const session=await (await post('/api/widget/session',{siteId:site.id,page:origin+'/demo'})).json();
  const detailRoute=base+'/api/admin/conversations/'+session.conversationId;
  assert.equal((await fetch(detailRoute)).status,401);
  const detail=await fetch(detailRoute,{headers:{Cookie:cookie}});assert.equal(detail.status,200);assert.equal((await detail.json()).id,session.conversationId);
  assert.equal((await fetch(base+'/api/admin/conversations/'+crypto.randomUUID(),{headers:{Cookie:cookie}})).status,404);
  for(const role of ['visitor','admin']){
    for(let offset=0;offset<stickers.items.length;offset+=13){
    const socket=io(base,{auth:role==='admin'?{role}:{role,siteId:site.id,visitorToken:session.visitorToken},reconnection:false,transports:['websocket'],extraHeaders:{Origin:origin,...(role==='admin'?{Cookie:cookie}:{})}});sockets.push(socket);
    await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});
    const send=stickerId=>new Promise((resolve,reject)=>socket.timeout(3000).emit('message:send',{conversationId:session.conversationId,kind:'sticker',stickerId,clientId:crypto.randomUUID()},(error,result)=>error?reject(error):resolve(result)));
    for(const item of stickers.items.slice(offset,offset+13)){const result=await send(item.id);assert.equal(result.ok,true,role+': '+item.id);assert.equal(result.message.sticker_id,item.id);}
    assert.equal((await send('unrecognized-sticker')).ok,false);
    socket.disconnect();
    }
  }
  assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(session.conversationId).n,52);
});
