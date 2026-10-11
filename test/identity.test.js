import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';
import { verifyIdentity } from '../server/identity.js';

const siteId=randomUUID(),secret='a'.repeat(64),seconds=()=>Math.floor(Date.now()/1000);
const sign=(key,site,userId='123',extra={})=>{const payload=Buffer.from(JSON.stringify({siteId:site,userId,account:'张三@example.com',nickname:'张三 😊',iat:seconds(),exp:seconds()+900,...extra})).toString('base64url');return payload+'.'+createHmac('sha256',key).update(payload).digest('base64url');};

test('PHP HMAC tokens validate in Node; altered, expired, foreign and malformed identities fail',()=>{
  const source=new URL('../examples/php/KivoIdentity.php',import.meta.url).pathname;
  const php=`require ${JSON.stringify(source)};echo \\App\\Components\\KivoIdentity::sign(${JSON.stringify(siteId)},${JSON.stringify(secret)},'123','张三@example.com','张三 😊');`;
  const token=execFileSync('php',['-r',php],{encoding:'utf8'});
  const identity=verifyIdentity(token,siteId,secret);assert.equal(identity.userId,'123');assert.equal(identity.nickname,'张三 😊');
  for(const bad of [token+'x',sign(secret,siteId,'123',{exp:seconds()-1}),sign(secret,siteId,'123',{iat:seconds()+60}),sign(secret,siteId,'123',{exp:seconds()+901}),sign(secret,randomUUID()),sign(secret,siteId,'123',{nickname:'a\nb'}),sign(secret,siteId,'123',{userId:''})])assert.throws(()=>verifyIdentity(bad,siteId,secret));
  assert.throws(()=>verifyIdentity(token,siteId,''));assert.throws(()=>verifyIdentity('x'.repeat(5000),siteId,secret));
});

test('PHP session embed reads usernames, escapes HTML and defaults to anonymous without a session',()=>{
  const source=new URL('../examples/php/kivo-session.php',import.meta.url).pathname;
  const render=session=>execFileSync('php',['-r',`$_SESSION=json_decode(${JSON.stringify(JSON.stringify(session))},true);include ${JSON.stringify(source)};`],{encoding:'utf8'});
  assert.match(render({username:'张三'}),/data-visitor-name="张三"/);
  assert.match(render({user:{username:'user@example.com'}}),/data-visitor-name="user@example.com"/);
  assert.match(render({username:'"><img src=x onerror=alert(1)>'}),/data-visitor-name="&quot;&gt;&lt;img/);
  assert.match(render({}),/data-visitor-name=""/);
  assert.match(render({username:[]}),/data-visitor-name=""/);
  assert.doesNotMatch(render({username:'alice'}),/data-identity-url|data-identity-token/);
});

test('session-provided names persist as display labels and never grant signed account history',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-label-')),origin='http://localhost:31019',shop='https://shop.example';
  let service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'label-test-password'});
  const start=async()=>{await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}`;};let base=await start();
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  const post=async(route,body,cookie='',requestOrigin=origin)=>{const r=await fetch(base+route,{method:'POST',headers:{Origin:requestOrigin,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.ok(r.ok);return r;};
  const cookie=(await post('/api/login',{username:'admin',password:'label-test-password'})).headers.get('set-cookie').split(';')[0];
  const site=await(await post('/api/admin/sites',{name:'Session 网站',origins:[shop]},cookie)).json();
  const session=async visitorName=>(await post('/api/widget/session',{siteId:site.id,page:shop,visitorName},'',shop)).json();
  const named=await session('Session 用户');assert.equal(named.identity,null);
  let rows=await(await fetch(base+'/api/admin/conversations',{headers:{Cookie:cookie}})).json();
  assert.equal(rows[0].name,'Session 用户');assert.equal(rows[0].visitor_name,'Session 用户');assert.equal(rows[0].user_id,null);
  const anonymous=await session('');rows=await(await fetch(base+'/api/admin/conversations',{headers:{Cookie:cookie}})).json();assert.match(rows.find(c=>c.id===anonymous.conversationId).name,/^访客 /);
  assert.notEqual((await session('Session 用户')).conversationId,named.conversationId,'a matching name alone cannot restore another visitor');
  const key=(await(await post(`/api/admin/sites/${site.id}/identity`,{action:'rotate'},cookie)).json()).secret;
  const verified=await(await post('/api/widget/session',{siteId:site.id,page:shop,identityToken:sign(key,site.id),visitorName:'伪造显示名'},'',shop)).json();
  assert.equal(verified.identity.account,'张三@example.com');assert.notEqual((await session('张三@example.com')).conversationId,verified.conversationId);
  await service.close();service=createKivo({dataDir:dir,publicUrl:origin});base=await start();
  rows=await(await fetch(base+'/api/admin/conversations',{headers:{Cookie:cookie}})).json();assert.equal(rows.find(c=>c.id===named.conversationId).name,'Session 用户');
});

test('verified accounts keep separate history across devices, logout, expiry and key rotation',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-identity-')),origin='http://localhost:31009',shop='https://shop.example';
  let service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'identity-test-password'});
  const start=async()=>{await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${service.server.address().port}`;};let base=await start();
  const sockets=[];t.after(async()=>{sockets.forEach(s=>s.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  const request=(route,{body,headers={},requestOrigin=origin}={})=>fetch(base+route,{method:body?'POST':'GET',headers:{Origin:requestOrigin,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{}),...headers},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const cookie=(await request('/api/login',{body:{username:'admin',password:'identity-test-password'}})).headers.get('set-cookie').split(';')[0],admin={Cookie:cookie};
  const site=await(await request('/api/admin/sites',{body:{name:'身份网站',origins:[shop]},headers:admin})).json();
  const identityPath=`/api/admin/sites/${site.id}/identity`;
  assert.equal((await request(identityPath)).status,401);assert.equal((await request(identityPath,{body:{action:'rotate'},headers:admin,requestOrigin:shop})).status,403);
  const key=(await(await request(identityPath,{body:{action:'rotate'},headers:admin})).json()).secret;
  assert.equal((await request('/api/admin/sites',{headers:admin})).status,200);assert.doesNotMatch(await(await request('/api/admin/sites',{headers:admin})).text(),new RegExp(key),'bulk sites do not leak keys');
  const session=async(identityToken=null,visitorToken)=>{const r=await request('/api/widget/session',{body:{siteId:site.id,page:shop+'/user',identityToken,visitorToken},requestOrigin:shop});assert.equal(r.status,200);return r.json();};
  const anonymous=await session(),proof=sign(key,site.id),user=await session(proof,anonymous.visitorToken);
  assert.notEqual(user.conversationId,anonymous.conversationId);assert.equal(user.identity.account,'张三@example.com');assert.equal(user.visitorToken,proof);
  const connect=async(s,role='visitor')=>{const socket=io(base,{auth:role==='admin'?{role}:{role,siteId:site.id,visitorToken:s.visitorToken},extraHeaders:{Origin:origin,...(role==='admin'?admin:{})},reconnection:false,transports:['websocket']});sockets.push(socket);await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;};
  const send=(socket,event,data)=>new Promise((resolve,reject)=>socket.timeout(3000).emit(event,data,(error,result)=>error?reject(error):resolve(result)));
  const socket=await connect(user);assert.equal((await send(socket,'message:send',{body:'账号私有消息',clientId:randomUUID()})).ok,true);
  const otherDevice=await session(sign(key,site.id));assert.equal(otherDevice.conversationId,user.conversationId);
  const other=await session(sign(key,site.id,'456',{account:'李四@example.com',nickname:''}),user.visitorToken);assert.notEqual(other.conversationId,user.conversationId);
  assert.equal((await send(socket,'visitor:identity',{visitorToken:other.visitorToken})).ok,false,'socket cannot change to another account');
  assert.equal((await session(null,anonymous.visitorToken)).conversationId,anonymous.conversationId,'logout restores only anonymous history');
  assert.notEqual((await session(null,user.visitorToken)).conversationId,user.conversationId,'signed credentials cannot fall back to anonymous restore');
  const rows=await(await request('/api/admin/conversations?q='+encodeURIComponent('张三 😊'),{headers:admin})).json();assert.equal(rows.length,1);assert.equal(rows[0].user_id,'123');
  const png=await sharp({create:{width:20,height:20,channels:4,background:'#0f766e'}}).png().toBuffer();const image=new FormData();image.append('image',new Blob([png],{type:'image/png'}),'image.png');
  const headers={Authorization:'Bearer '+proof,'X-Kivo-Site':site.id};const upload=await request('/api/widget/images',{body:image,headers,requestOrigin:origin});assert.equal(upload.status,201);const media=await upload.json();
  assert.equal((await request('/api/media/'+media.id,{headers})).status,200);assert.equal((await request('/api/media/'+media.id,{headers:{...headers,Authorization:'Bearer '+other.visitorToken}})).status,404);
  const expired=sign(key,site.id,'123',{exp:seconds()-1});assert.equal((await request('/api/widget/session',{body:{siteId:site.id,page:shop,identityToken:expired},requestOrigin:shop})).status,403);
  assert.equal((await request('/api/media/'+media.id,{headers:{...headers,Authorization:'Bearer '+expired}})).status,404);
  const short=await session(sign(key,site.id,'short',{iat:seconds(),exp:seconds()+2}));const shortSocket=await connect(short);
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Expired account socket stayed connected')),3000);shortSocket.once('disconnect',()=>{clearTimeout(timeout);resolve();});});
  assert.equal(shortSocket.connected,false,'expired sockets cannot receive further account messages');
  socket.disconnect();await service.close();service=createKivo({dataDir:dir,publicUrl:origin});base=await start();assert.equal((await session(proof)).conversationId,user.conversationId,'identity and key survive restart');
  const reconnected=await connect(user);const disconnected=new Promise(resolve=>reconnected.once('disconnect',resolve));await request(identityPath,{body:{action:'rotate'},headers:admin});await disconnected;
  assert.equal((await request('/api/media/'+media.id,{headers})).status,404,'key rotation revokes old account credentials');
  assert.equal((await session(null,anonymous.visitorToken)).conversationId,anonymous.conversationId);
});
