import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { DatabaseSync, backup } from 'node:sqlite';
import { createKivo } from '../server/app.js';
import { randomUUID } from 'node:crypto';

const origin = 'http://127.0.0.1:31999';
const visitorOrigin = 'https://shop.example.com';
const password = 'test-password-very-long';
const waitEvent = (socket,event) => new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`Timeout: ${event}`)),4000);
  socket.once(event,value=>{clearTimeout(timer);resolve(value);});
});
const send = (socket,data) => new Promise((resolve,reject)=>socket.timeout(3000).emit('message:send',data,(err,value)=>err?reject(err):resolve(value)));

test('real HTTP + WebSocket workflow, authorization, persistence and backup', async t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-test-'));
  let service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:password});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  let base=`http://127.0.0.1:${service.server.address().port}`;
  const sockets=[];
  t.after(async()=>{sockets.forEach(s=>s.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  async function request(route, { method='GET', body, cookie, requestOrigin=origin }={}) {
    const res=await fetch(base+route,{method,headers:{Origin:requestOrigin,...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});
    const data=res.headers.get('content-type')?.includes('json')?await res.json():await res.text();
    return {res,data};
  }
  function connect(auth,cookie,requestOrigin=origin) {
    const s=io(base,{auth,autoConnect:false,reconnection:false,transports:['websocket'],extraHeaders:{Origin:requestOrigin,...(cookie?{Cookie:cookie}:{})}});sockets.push(s);return s;
  }
  assert.equal((await request('/healthz')).data.status,'ok');
  assert.equal((await request('/api/admin/sites')).res.status,401);
  assert.equal((await request('/api/admin/unread')).res.status,401);
  assert.equal((await request('/api/login',{method:'POST',body:{username:'admin',password},requestOrigin:'https://evil.example'})).res.status,403);
  assert.equal((await request('/api/login',{method:'POST',body:{username:'admin',password:'wrong'}})).res.status,401);
  const login=await request('/api/login',{method:'POST',body:{username:'admin',password}});
  assert.equal(login.res.status,200);const cookie=login.res.headers.get('set-cookie').split(';')[0];
  assert.match(login.res.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await request('/api/admin/unread',{cookie})).data.total,0);
  const polling=io(base,{auth:{role:'admin'},autoConnect:false,reconnection:false,transports:['polling'],extraHeaders:{Referer:origin+'/',Cookie:cookie}});
  sockets.push(polling);const pollingReady=waitEvent(polling,'connect');polling.connect();await pollingReady;polling.disconnect();
  const site=await request('/api/admin/sites',{method:'POST',cookie,body:{name:'演示商城',origins:[visitorOrigin],color:'#0f766e',greeting:'你好！'}});
  assert.equal(site.res.status,201);const siteId=site.data.id;
  assert.equal((await request('/api/admin/sites',{method:'POST',cookie,body:{name:'bad',origins:['javascript:alert(1)']}})).res.status,400);
  assert.equal((await request('/api/widget/session',{method:'POST',body:{siteId,page:'https://evil.example/'},requestOrigin:'https://evil.example'})).res.status,403);
  const session=await request('/api/widget/session',{method:'POST',requestOrigin:visitorOrigin,body:{siteId,page:visitorOrigin+'/products/1'}});
  assert.equal(session.res.status,200);assert.equal(session.res.headers.get('access-control-allow-origin'),visitorOrigin);
  const id=session.data.conversationId;
  const secondSession=await request('/api/widget/session',{method:'POST',requestOrigin:visitorOrigin,body:{siteId,page:visitorOrigin+'/other'}});
  const outsider=connect({role:'visitor',siteId,visitorToken:secondSession.data.visitorToken});const outsiderReady=waitEvent(outsider,'connect');outsider.connect();await outsiderReady;
  let leaked=false;outsider.on('message:new',()=>leaked=true);
  const resumed=await request('/api/widget/session',{method:'POST',requestOrigin:visitorOrigin,body:{siteId,page:visitorOrigin+'/cart',visitorToken:session.data.visitorToken}});
  assert.equal(resumed.data.conversationId,id);
  assert.equal((await request('/api/widget/session',{method:'POST',requestOrigin:visitorOrigin,body:{siteId,page:'https://evil.example/'}})).res.status,400);
  const rejected=connect({role:'visitor',siteId,visitorToken:'0'.repeat(64)});const rejectedEvent=waitEvent(rejected,'connect_error');rejected.connect();assert.match((await rejectedEvent).message,/凭证/);
  const admin=connect({role:'admin'},cookie);const adminReady=waitEvent(admin,'connect');admin.connect();await adminReady;
  const visitor=connect({role:'visitor',siteId,visitorToken:session.data.visitorToken});const visitorReady=waitEvent(visitor,'connect'),history=waitEvent(visitor,'history');visitor.connect();await visitorReady;assert.deepEqual(await history,[]);
  const incoming=waitEvent(admin,'message:new');
  const clientId=crypto.randomUUID();const sent=await send(visitor,{body:'请问订单什么时候发货？',clientId,conversationId:crypto.randomUUID()});
  assert.equal(sent.ok,true);assert.equal((await incoming).conversation_id,id);
  const duplicate=await send(visitor,{body:'请问订单什么时候发货？',clientId});assert.equal(duplicate.message.id,sent.message.id);
  let list=(await request('/api/admin/conversations',{cookie})).data;
  assert.equal(list.length,2);assert.equal(list[0].unread,1);assert.equal(list[0].online,true);assert.equal(list[0].page,visitorOrigin+'/cart');assert.equal(list[0].ip,'127.0.0.1');assert.equal(list[0].visitor_hash,undefined);
  const replyEvent=waitEvent(visitor,'message:new');const reply=await send(admin,{conversationId:id,body:'你好，今天会发出。',clientId:crypto.randomUUID()});assert.equal(reply.ok,true);assert.equal((await replyEvent).sender,'agent');
  assert.equal((await send(visitor,{body:'x'.repeat(4001),clientId:crypto.randomUUID()})).ok,false);
  await request(`/api/admin/conversations/${id}/read`,{method:'POST',cookie,body:{lastId:sent.message.id}});
  assert.equal((await request('/api/admin/conversations',{cookie})).data[0].unread,0);
  assert.equal((await request('/api/admin/unread',{cookie})).data.total,0);
  await send(visitor,{body:'谢谢',clientId:crypto.randomUUID()});
  await request(`/api/admin/conversations/${id}/read`,{method:'POST',cookie,body:{lastId:sent.message.id}});
  assert.equal((await request('/api/admin/conversations',{cookie})).data[0].unread,1,'read does not clear an unseen message');
  assert.equal((await request('/api/admin/unread?status=closed&q=no-match&site=missing',{cookie})).data.total,1,'unread count is independent of every list filter');
  await request(`/api/admin/conversations/${id}/status`,{method:'POST',cookie,body:{status:'closed'}});
  assert.equal((await request('/api/admin/conversations?status=closed',{cookie})).data.length,1);
  await send(visitor,{body:'再问一个问题',clientId:crypto.randomUUID()});
  assert.equal((await request('/api/admin/conversations?status=open',{cookie})).data.length,2,'new message reopens a closed conversation');
  const changed=waitEvent(admin,'conversation:update');visitor.emit('visitor:page',{page:visitorOrigin+'/checkout'});assert.equal((await changed).page,visitorOrigin+'/checkout');
  const invalidAdmin=connect({role:'admin'},cookie,visitorOrigin);const invalidEvent=waitEvent(invalidAdmin,'connect_error');invalidAdmin.connect();assert.match((await invalidEvent).message,/来源/);
  const disconnect=waitEvent(admin,'disconnect');await request('/api/admin/logout',{method:'POST',cookie});await disconnect;
  assert.equal((await request('/api/admin/me',{cookie})).res.status,401);
  const historyRows=(await request('/api/admin/conversations/'+id+'/messages',{cookie:(await request('/api/login',{method:'POST',body:{username:'admin',password}})).res.headers.get('set-cookie').split(';')[0]})).data;
  assert.equal(historyRows.length,4);
  assert.equal(leaked,false,'visitors cannot receive messages from another conversation');
  const backupPath=path.join(dir,'backup.sqlite');await backup(service.db,backupPath);const backed=new DatabaseSync(backupPath,{readOnly:true});assert.equal(backed.prepare('SELECT COUNT(*) AS n FROM messages').get().n,4);backed.close();
  sockets.forEach(s=>s.disconnect());await service.close();service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'ignored-after-first-start'});await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${service.server.address().port}`;
  const relogin=await request('/api/login',{method:'POST',body:{username:'admin',password}});assert.equal(relogin.res.status,200);const newCookie=relogin.res.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/admin/conversations/'+id+'/messages',{cookie:newCookie})).data.length,4);
  assert.equal((await request('/api/admin/password',{method:'POST',cookie:newCookie,body:{oldPassword:'wrong',newPassword:'new-strong-password'}})).res.status,400);
  assert.equal((await request('/api/admin/password',{method:'POST',cookie:newCookie,body:{oldPassword:password,newPassword:'new-strong-password'}})).res.status,200);
  assert.equal((await request('/api/admin/me',{cookie:newCookie})).res.status,401);
  assert.equal((await request('/api/login',{method:'POST',body:{username:'admin',password:'new-strong-password'}})).res.status,200);
});

test('startup refuses an insecure initial password',()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-init-'));
  try{assert.throws(()=>createKivo({dataDir:dir,adminPassword:'short'}),/ADMIN_PASSWORD/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('global unread count includes conversations outside the latest 200 rows and every site/status', async t => {
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-unread-'));
  const service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:password});
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${service.server.address().port}`;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const createSite=async name=>(await (await fetch(base+'/api/admin/sites',{method:'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({name,origins:['*']})})).json()).id;
  const one=await createSite('one'),two=await createSite('two');
  const insert=service.db.prepare('INSERT INTO conversations(id,site_id,visitor_hash,name,ip,region,page,status,unread,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<205;i++)insert.run(randomUUID(),i%2?one:two,randomUUID(),'visitor','1.1.1.1','test',origin,i%2?'closed':'open',1,1,i+1);
  const headers={Cookie:cookie};
  assert.equal((await (await fetch(base+'/api/admin/conversations',{headers})).json()).length,200);
  assert.equal((await (await fetch(base+`/api/admin/unread?site=${one}&status=open&q=nothing`,{headers})).json()).total,205);
});
