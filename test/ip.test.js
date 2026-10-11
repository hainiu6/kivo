import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visitorIP } from '../server/ip.js';
import { createKivo } from '../server/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';

test('proxy address handling ignores spoofed prefixes, normalizes IPv6 and refuses invalid addresses',()=>{
  const request=headers=>({headers,socket:{remoteAddress:'::ffff:172.17.0.1'}});
  assert.equal(visitorIP(request({'x-forwarded-for':'8.8.8.8, 1.1.1.1'}),1),'1.1.1.1');
  assert.equal(visitorIP(request({'x-forwarded-for':'8.8.8.8'}),0),'172.17.0.1');
  assert.equal(visitorIP(request({'x-real-ip':'2001:4860:4860::8888'}),1),'2001:4860:4860::8888');
  assert.equal(visitorIP(request({'x-forwarded-for':'bad','x-real-ip':'::ffff:1.1.1.1'}),1),'1.1.1.1');
  assert.equal(visitorIP(request({'x-forwarded-for':'127.0.0.1, bad','x-real-ip':'bad'}),1),'172.17.0.1');
});

test('visitor IP updates from trusted headers during HTTP bootstrap and Socket.IO reconnection',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-ip-')),origin='http://localhost:31995',service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'ip-test-password',trustProxy:1});
  let socket;t.after(async()=>{socket?.disconnect();await service.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${service.server.address().port}`;
  const request=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const login=await request('/api/login',{username:'admin',password:'ip-test-password'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const site=await (await request('/api/admin/sites',{name:'test',origins:['*']},{Cookie:cookie})).json();
  const visitor=await (await request('/api/widget/session',{siteId:site.id,page:origin+'/demo'},{'X-Forwarded-For':'8.8.8.8, 1.1.1.1'})).json();
  assert.equal(service.db.prepare('SELECT ip FROM conversations WHERE id=?').get(visitor.conversationId).ip,'1.1.1.1');
  socket=io(base,{autoConnect:false,auth:{role:'visitor',siteId:site.id,visitorToken:visitor.visitorToken},reconnection:false,transports:['websocket'],extraHeaders:{Origin:origin,'X-Real-IP':'8.8.4.4'}});
  const ready=new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});socket.connect();await ready;
  assert.equal(service.db.prepare('SELECT ip FROM conversations WHERE id=?').get(visitor.conversationId).ip,'8.8.4.4');
});
