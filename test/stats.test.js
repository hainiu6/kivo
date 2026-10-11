import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {io} from 'socket.io-client';
import {createKivo} from '../server/app.js';

test('statistics cover all records, Beijing midnight, website scopes, message kinds, deduplicated online visitors and deletion',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-stats-')),origin='http://localhost:31997',sockets=[];
  const service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'stats-test-password'});
  t.after(async()=>{sockets.forEach(s=>s.disconnect());await service.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${service.server.address().port}`;
  const now=Date.parse('2026-10-11T16:30:00Z'),midnight=Date.parse('2026-10-11T16:00:00Z');t.mock.method(Date,'now',()=>now);
  const request=(route,{body,cookie,method=body?'POST':'GET'}={})=>fetch(base+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal((await request('/api/admin/stats')).status,401);
  const login=await request('/api/login',{body:{username:'admin',password:'stats-test-password'}}),cookie=login.headers.get('set-cookie').split(';')[0];
  const stats=async query=>(await request('/api/admin/stats?'+query,{cookie})).json();
  const empty=await stats('days=1');assert.equal(empty.daily[0].date,'2026-10-12');assert.equal(empty.summary.visitorMessages,0);assert.deepEqual(empty.sites,[]);
  const sites=[];for(const name of ['商城 A','商城 B','暂无访问'])sites.push(await(await request('/api/admin/sites',{cookie,body:{name,origins:['*']}})).json());
  const insertConversation=service.db.prepare('INSERT INTO conversations(id,site_id,visitor_hash,name,ip,region,page,status,unread,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const conversation=(site,time,unread=0,status='open')=>{const id=crypto.randomUUID();insertConversation.run(id,site.id,crypto.randomUUID(),'访客','1.1.1.1','美国',origin+'/',status,unread,time,time);return id;};
  const insertMessage=service.db.prepare('INSERT INTO messages(conversation_id,sender,body,client_id,created_at,kind) VALUES(?,?,?,?,?,?)');
  const message=(id,sender,time,kind='text')=>Number(insertMessage.run(id,sender,'test',crypto.randomUUID(),time,kind).lastInsertRowid);
  let firstId,firstMessage;
  for(let i=0;i<210;i++){const id=conversation(sites[0],midnight,1),mid=message(id,'visitor',midnight);if(!i){firstId=id;firstMessage=mid;}}
  const old=conversation(sites[0],midnight-20*86400000,2);message(old,'visitor',midnight,'image');message(old,'agent',midnight,'sticker');message(old,'auto',midnight);
  const b=conversation(sites[1],midnight-1,0,'closed');message(b,'visitor',midnight-1);message(b,'agent',now);message(b,'visitor',now+1);
  const session=await(await request('/api/widget/session',{body:{siteId:sites[0].id,page:origin+'/demo'}})).json();
  for(let i=0;i<2;i++){const s=io(base,{auth:{role:'visitor',siteId:sites[0].id,visitorToken:session.visitorToken},transports:['websocket'],extraHeaders:{Origin:origin},reconnection:false});sockets.push(s);await new Promise((resolve,reject)=>{s.once('connect',resolve);s.once('connect_error',reject);});}
  assert.equal((await(await request('/api/admin/conversations',{cookie})).json()).length,200);
  const today=await stats('days=1');assert.equal(today.start,midnight);assert.equal(today.end,now);assert.equal(today.timezone,'Asia/Shanghai');
  assert.deepEqual(today.summary,{newConversations:211,chatConversations:212,visitorMessages:211,agentMessages:2,autoMessages:1,textMessages:212,imageMessages:1,stickerMessages:1,openConversations:212,unreadMessages:212,onlineVisitors:1});
  assert.equal(today.daily[0].visitorMessages,211);assert.equal(today.sites.find(s=>s.id===sites[1].id).newConversations,0);
  const week=await stats('days=7');assert.equal(week.daily.length,7);assert.equal(week.daily[0].date,'2026-10-06');assert.equal(week.daily[0].visitorMessages,0);assert.equal(week.summary.visitorMessages,212);assert.equal(week.summary.newConversations,212);
  const onlyB=await stats('days=7&site='+sites[1].id);assert.equal(onlyB.sites.length,1);assert.equal(onlyB.summary.visitorMessages,1);assert.equal(onlyB.summary.agentMessages,1);assert.equal(onlyB.summary.onlineVisitors,0);
  const noTraffic=await stats('days=90&site='+sites[2].id);assert.equal(noTraffic.daily.length,90);assert.ok(Object.values(noTraffic.summary).every(value=>value===0));
  for(const query of ['days=2','days=-1','days=7%20','days=7&days=30','site=a&site=b'])assert.equal((await request('/api/admin/stats?'+query,{cookie})).status,400,query);
  assert.equal((await request('/api/admin/stats?site='+crypto.randomUUID(),{cookie})).status,404);
  assert.equal((await request(`/api/admin/conversations/${firstId}/messages/${firstMessage}`,{cookie,method:'DELETE'})).status,200);
  const deleted=await stats('days=1');assert.equal(deleted.summary.visitorMessages,210);assert.equal(deleted.summary.chatConversations,211);assert.equal(deleted.summary.newConversations,211);
  assert.equal((await request(`/api/admin/conversations/${b}`,{cookie,method:'DELETE'})).status,200);const clearedB=await stats('days=7&site='+sites[1].id);assert.equal(clearedB.summary.agentMessages,0);assert.equal(clearedB.summary.newConversations,0);
  sockets[0].disconnect();await new Promise(resolve=>setImmediate(resolve));assert.equal((await stats('days=1')).summary.onlineVisitors,1,'another tab keeps the visitor online');
});
