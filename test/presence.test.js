import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';

test('support availability persists, synchronizes agents and visitors, controls offline replies and counts unique live conversations', async t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-presence-')),origin='http://localhost:31997',external='https://shop.example',password='presence-test-password',sockets=[];
  let service,base;
  async function start(){service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:password});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${service.server.address().port}`;}
  await start();t.after(async()=>{sockets.forEach(s=>s.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  async function request(route,{method='GET',body,cookie,from=origin}={}){const res=await fetch(base+route,{method,headers:{Origin:from,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{res,data:await res.json()};}
  const login=async()=>(await request('/api/login',{method:'POST',body:{username:'admin',password}})).res.headers.get('set-cookie').split(';')[0];
  const event=(s,name,predicate=()=>true)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.off(name,listen);reject(new Error(`Timeout ${name}`));},3000);function listen(data){if(!predicate(data))return;clearTimeout(timer);s.off(name,listen);resolve(data);}s.on(name,listen);});
  async function connect(auth,cookie,from=origin){const s=io(base,{auth,autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Origin:from,...(cookie?{Cookie:cookie}:{})}});sockets.push(s);const ready=event(s,auth.role==='admin'?'presence:update':'agents:status');s.connect();return{s,data:await ready};}
  let cookie=await login();
  assert.equal((await request('/api/admin/presence')).res.status,401);
  assert.equal((await request('/api/admin/presence',{method:'PUT',cookie,from:external,body:{availability:'offline'}})).res.status,403);
  assert.equal((await request('/api/admin/presence',{method:'PUT',cookie,body:{availability:'unknown'}})).res.status,400);
  assert.deepEqual((await request('/api/admin/presence',{cookie})).data,{availability:'online',online:false,onlineVisitors:0});
  const a=await connect({role:'admin'},cookie),b=await connect({role:'admin'},cookie);
  assert.equal(a.data.online,true);assert.equal(b.data.online,true);
  const site=(await request('/api/admin/sites',{method:'POST',cookie,body:{name:'演示',allowAll:true,autoReply:{firstEnabled:false,offlineEnabled:true,offlineMessage:'已离线，请留言'}}})).data.id;
  const session=async()=> (await request('/api/widget/session',{method:'POST',from:external,body:{siteId:site,page:external}})).data;
  const first=await session(),second=await session();
  const count1=event(a.s,'presence:update',d=>d.onlineVisitors===1);
  const visitor=await connect({role:'visitor',siteId:site,visitorToken:first.visitorToken},undefined,external);await count1;assert.equal(visitor.data.online,true);
  const duplicate=await connect({role:'visitor',siteId:site,visitorToken:first.visitorToken},undefined,external);
  assert.equal((await request('/api/admin/presence',{cookie})).data.onlineVisitors,1);
  const other=await connect({role:'visitor',siteId:site,visitorToken:second.visitorToken},undefined,external);
  assert.equal((await request('/api/admin/presence',{cookie})).data.onlineVisitors,2);
  const aOff=event(a.s,'presence:update',d=>d.availability==='offline'),bOff=event(b.s,'presence:update',d=>d.availability==='offline'),visitorOff=event(visitor.s,'agents:status',d=>!d.online);
  await request('/api/admin/presence',{method:'PUT',cookie,body:{availability:'offline'}});await Promise.all([aOff,bOff,visitorOff]);
  assert.equal((await request('/api/admin/me',{cookie})).data.presence.availability,'offline');
  const send=(s,data)=>new Promise((resolve,reject)=>s.timeout(3000).emit('message:send',{clientId:crypto.randomUUID(),...data},(e,ack)=>e?reject(e):resolve(ack)));
  await send(visitor.s,{body:'客服在后台但主动离线'});
  const history=()=>request(`/api/admin/conversations/${first.conversationId}/messages`,{cookie});
  assert.equal((await history()).data.at(-1).body,'已离线，请留言');
  assert.equal((await send(a.s,{conversationId:first.conversationId,body:'仍可回复'})).ok,true);
  // Multiple tabs are counted once, even when the list filters hide their conversation.
  const oneLeft=event(a.s,'presence:update',d=>d.onlineVisitors===1);other.s.disconnect();await oneLeft;
  const stillOne=event(a.s,'presence:update',d=>d.onlineVisitors===1);duplicate.s.disconnect();await stillOne;
  assert.equal((await request('/api/admin/conversations?status=closed',{cookie})).data.length,0);
  assert.equal((await request('/api/admin/presence',{cookie})).data.onlineVisitors,1);
  const removed=event(a.s,'presence:update',d=>d.onlineVisitors===0);
  await request(`/api/admin/conversations/${first.conversationId}`,{method:'DELETE',cookie});await removed;
  sockets.forEach(s=>s.disconnect());await service.close();await start();cookie=await login();
  const persisted=await connect({role:'admin'},cookie);assert.equal(persisted.data.availability,'offline');assert.equal(persisted.data.online,false);
  const newVisitor=await connect({role:'visitor',siteId:site,visitorToken:second.visitorToken},undefined,external);assert.equal(newVisitor.data.online,false);
  const on=event(newVisitor.s,'agents:status',d=>d.online);await request('/api/admin/presence',{method:'PUT',cookie,body:{availability:'online'}});await on;
  const off=event(newVisitor.s,'agents:status',d=>!d.online);await request('/api/admin/logout',{method:'POST',cookie});await off;
});
