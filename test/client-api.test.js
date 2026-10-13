import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';
import { KivoClient } from '../examples/client/kivo-client.mjs';

async function setup(t) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-client-')),origin='https://support.example';
  let service,base;
  async function start(){service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'client-test-password',trustProxy:1});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;}
  await start();const sockets=[];
  t.after(async()=>{sockets.forEach(s=>s.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  const request=(route,body,headers={},method=body===undefined?'GET':'POST')=>fetch(base+route,{method,headers:{...(body===undefined||body instanceof FormData?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
  const login=await request('/api/login',{username:'admin',password:'client-test-password'},{Origin:origin});const admin={Origin:origin,Cookie:login.headers.get('set-cookie').split(';')[0]};
  const site=await(await request('/api/admin/sites',{name:'客户端测试',origins:['https://shop.example']},admin)).json();
  const secret=(await(await request(`/api/admin/sites/${site.id}/identity`,{action:'rotate'},admin)).json()).secret;
  const issue=async(user={userId:'123',account:'alice@example.com',nickname:'小夏',attributes:{会员等级:'VIP'}},ttl=900)=>{const res=await request('/api/client/v1/tokens',{siteId:site.id,user,ttl},{Authorization:'Bearer '+secret});assert.equal(res.status,201);return res.json();};
  const connect=async(auth,headers={})=>{const socket=io(base,{auth,extraHeaders:headers,reconnection:false,transports:['websocket'],autoConnect:false});sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);socket.connect();});return socket;};
  return {get service(){return service;},get base(){return base;},origin,admin,site,secret,request,issue,connect,restart:async()=>{sockets.forEach(s=>s.disconnect());await service.close();await start();}};
}
const once=(socket,event)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Missing '+event)),3000);socket.once(event,data=>{clearTimeout(timer);resolve(data);});});

test('native identity issuance is backend-only, bounded, short-lived and isolated from website credentials',async t=>{
  const f=await setup(t),route='/api/client/v1/tokens',body={siteId:f.site.id,user:{userId:'1',account:'alice'}};
  assert.equal((await f.request(route,body)).status,401);
  assert.equal((await f.request(route,body,{Authorization:'Bearer '+'é'.repeat(64)})).status,401);
  assert.equal((await f.request(route,body,{Origin:f.origin,Authorization:'Bearer '+f.secret})).status,403);
  for(const user of [{userId:'',account:'a'},{userId:'1',account:'a',attributes:{nested:{}}},{userId:'1',account:'a',attributes:Object.fromEntries(Array.from({length:6},(_,i)=>['k'+i,'v']))}])assert.equal((await f.request(route,{...body,user},{Authorization:'Bearer '+f.secret})).status,400);
  assert.equal((await f.request(route,{...body,ttl:901},{Authorization:'Bearer '+f.secret})).status,400);
  const proof=await f.issue();const changed=proof.token.slice(0,-4)+'aaaa';
  await f.request('/api/admin/sites',{name:'另一个站点',origins:['https://another.example']},f.admin);
  assert.equal((await f.request('/api/client/v1/sessions',{siteId:f.site.id,identityToken:proof.token,client:{platform:'Windows'}},{Origin:'https://another.example'})).status,403);
  assert.equal((await f.request('/api/client/v1/sessions',{siteId:f.site.id,identityToken:changed,client:{platform:'Windows'}})).status,401);
  assert.equal((await f.request('/api/client/v1/sessions',{siteId:randomUUID(),identityToken:proof.token,client:{platform:'Windows'}})).status,401);
  const expiredPayload=Buffer.from(JSON.stringify({siteId:f.site.id,userId:'123',account:'alice',nickname:'',aud:'kivo-client',iat:Math.floor(Date.now()/1000)-100,exp:Math.floor(Date.now()/1000)-1})).toString('base64url');
  const expired=expiredPayload+'.'+createHmac('sha256',f.secret).update(expiredPayload).digest('base64url');
  assert.equal((await f.request('/api/client/v1/sessions',{siteId:f.site.id,identityToken:expired,client:{platform:'Android'}})).status,401);
  const payload=Buffer.from(JSON.stringify({siteId:f.site.id,userId:'123',account:'alice',nickname:'',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+900})).toString('base64url');
  const website=payload+'.'+createHmac('sha256',f.secret).update(payload).digest('base64url');
  assert.equal((await f.request('/api/client/v1/sessions',{siteId:f.site.id,identityToken:website,client:{platform:'Windows'}})).status,401);
  await assert.rejects(f.connect({role:'visitor',siteId:f.site.id,visitorToken:website}),/客户端凭证/);
  assert.equal((await f.request('/api/widget/session',{siteId:f.site.id,identityToken:proof.token,page:'https://shop.example/'},{Origin:'https://shop.example'})).status,403);
  const allowed=await f.request('/api/client/v1/sessions',undefined,{Origin:'https://shop.example'},'OPTIONS');assert.equal(allowed.status,204);assert.match(allowed.headers.get('access-control-allow-methods'),/GET/);
  assert.equal((await f.request('/api/client/v1/sessions',undefined,{Origin:'https://evil.example'},'OPTIONS')).status,403);
  const proxyClient=new KivoClient({baseUrl:f.base,siteId:f.site.id,fetchImpl:async()=>new Response('<html>proxy error</html>',{status:200})});
  await assert.rejects(proxyClient.start(proof.token,{platform:'Windows'}),error=>error.status===502);assert.equal(proxyClient.accessToken,'');
});

test('desktop and mobile clients share verified history, receive realtime replies/deletions and enforce image ownership and pagination',async t=>{
  const f=await setup(t),proof=await f.issue();
  const client=new KivoClient({baseUrl:f.base,siteId:f.site.id});
  const session=await client.start(proof.token,{platform:'Windows',version:'2.0',device:'PC'},'订单详情');
  assert.equal(session.user.nickname,'小夏');assert.equal((await client.status()).support.online,false);
  let rows=await(await f.request('/api/admin/conversations',undefined,f.admin)).json();assert.equal(rows[0].online,true);assert.equal(rows[0].client.screen,'订单详情');assert.deepEqual(rows[0].client.attributes,{会员等级:'VIP'});
  const visitor=await f.connect(client.socketAuth()),agent=await f.connect({role:'admin'},f.admin);
  const notification=once(agent,'message:new'),id=randomUUID();const sent=await client.send({body:'桌面客户端咨询',clientId:id});assert.equal((await notification).body,'桌面客户端咨询');
  assert.equal((await client.send({body:'桌面客户端咨询',clientId:id})).message.id,sent.message.id);
  const incoming=once(visitor,'message:new');await new Promise((resolve,reject)=>agent.emit('message:send',{conversationId:session.conversationId,body:'客服回复',clientId:randomUUID()},result=>result.ok?resolve():reject(new Error(result.error))));assert.equal((await incoming).body,'客服回复');
  const mobile=new KivoClient({baseUrl:f.base,siteId:f.site.id});const fresh=await f.issue();assert.notEqual(fresh.token,proof.token);
  assert.equal((await mobile.start(fresh.token,{platform:'Android',version:'3.0',device:'Pixel'},'账户页面')).conversationId,session.conversationId);
  assert.equal((await mobile.history()).messages.length,2);await mobile.context('支付结果');
  const png=await sharp({create:{width:12,height:12,channels:4,background:'#0f766e'}}).png().toBuffer();const form=new FormData();form.append('image',new Blob([png],{type:'image/png'}),'image.png');
  const image=await mobile.upload(form);await mobile.send({kind:'image',mediaId:image.id,clientId:randomUUID()});assert.equal((await mobile.image(image.id)).type,'image/webp');
  const stranger=new KivoClient({baseUrl:f.base,siteId:f.site.id});await stranger.start((await f.issue({userId:'456',account:'bob',nickname:''})).token,{platform:'iOS'});
  await assert.rejects(stranger.image(image.id),error=>error.status===404);await assert.rejects(stranger.send({kind:'image',mediaId:image.id}),error=>error.status===400);
  const deletion=once(visitor,'message:deleted');assert.equal((await f.request(`/api/admin/conversations/${session.conversationId}/messages/${sent.message.id}`,undefined,f.admin,'DELETE')).status,200);assert.equal((await deletion).messageId,sent.message.id);assert.equal((await mobile.history()).messages.length,2);
  const insert=f.service.db.prepare("INSERT INTO messages(conversation_id,sender,body,client_id,created_at) VALUES(?,'visitor','分页消息',?,?)");for(let i=0;i<105;i++)insert.run(session.conversationId,randomUUID(),Date.now());
  const page=await mobile.history();assert.equal(page.messages.length,100);assert.equal(page.hasMore,true);const older=await mobile.history(page.nextBefore);assert.equal(older.messages.length,7);assert.equal(older.hasMore,false);
  const clear=once(visitor,'history:cleared');await f.request(`/api/admin/conversations/${session.conversationId}/messages`,undefined,f.admin,'DELETE');await clear;assert.equal((await mobile.history()).messages.length,0);
  const removed=once(visitor,'conversation:deleted');await f.request(`/api/admin/conversations/${session.conversationId}`,undefined,f.admin,'DELETE');await removed;await assert.rejects(mobile.history(),e=>e.status===404);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM client_profiles WHERE conversation_id=?').get(session.conversationId).n,0);
});

test('client logout revokes only its credential across restart, while account history/profile survive and site key rotation revokes all clients',async t=>{
  const f=await setup(t),p=await f.issue();let client=new KivoClient({baseUrl:f.base,siteId:f.site.id});const original=await client.start(p.token,{platform:'macOS',version:'1.0'},'客服');await client.send({body:'保留的记录'});
  const other=await f.issue();const b=new KivoClient({baseUrl:f.base,siteId:f.site.id});await b.start(other.token,{platform:'iOS'});const socket=await f.connect(client.socketAuth()),disconnected=once(socket,'disconnect');await client.logout();await disconnected;assert.equal(client.accessToken,'');assert.equal((await b.history()).messages.length,1);
  await f.restart();client=new KivoClient({baseUrl:f.base,siteId:f.site.id});await assert.rejects(client.start(p.token,{platform:'Windows'}),e=>e.status===401);
  const resumed=await client.start(other.token,{platform:'iOS'});assert.equal(resumed.conversationId,original.conversationId);assert.equal((await client.history()).messages.length,1);
  await f.request(`/api/admin/sites/${f.site.id}/identity`,{action:'rotate'},f.admin);await assert.rejects(client.history(),e=>e.status===401);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,1);
});
