import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createKivo} from '../server/app.js';
const DAY=86400000,OFFSET=8*3600000;

async function harness(t){
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-analytics-')),origin='http://localhost:31996',password='analytics-test-password';let service,base;
  async function start(){service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:password,trustProxy:1});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+service.server.address().port;}
  await start();t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  async function request(route,{method='GET',body,cookie,from=origin,plain=false,ip='203.0.113.8'}={}){const res=await fetch(base+route,{method,headers:{Origin:from,'Content-Type':plain?'text/plain':'application/json','X-Real-IP':ip,'User-Agent':'Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{res,data:res.status===204?null:await res.json()};}
  const login=async()=>(await request('/api/login',{method:'POST',body:{username:'admin',password}})).res.headers.get('set-cookie').split(';')[0];
  const site=async(cookie,name)=>(await request('/api/admin/analytics/sites',{method:'POST',cookie,body:{name}})).data.id;
  return{request,login,site,get db(){return service.db;},restart:async()=>{await service.close();await start();}};
}

test('independent tracking sites accept any website, authenticate admin actions and collect idempotent PV/UV with trusted IPs',async t=>{
  const h=await harness(t),cookie=await h.login();
  for(const route of ['/api/admin/analytics/sites','/api/admin/analytics/stats'])assert.equal((await h.request(route)).res.status,401);
  assert.equal((await h.request('/api/admin/analytics/sites',{method:'POST',cookie,from:'https://foreign.example',body:{name:'坏请求'}})).res.status,403);
  for(const name of ['', 'x'.repeat(61)])assert.equal((await h.request('/api/admin/analytics/sites',{method:'POST',cookie,body:{name}})).res.status,400);
  const site=await h.site(cookie,'任意域名'),visitorId=randomUUID(),other=randomUUID();
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM sites').get().n,0,'tracking sites do not create chat sites or conversations');
  assert.equal((await h.request('/api/analytics/collect',{method:'OPTIONS',from:'https://anything.example'})).res.headers.get('access-control-allow-origin'),'*');
  const event={siteId:site,eventId:randomUUID(),visitorId,page:'https://first.example/product?secret=hidden#section',title:'商品页面',referrer:'https://search.example/find?q=private'};
  const post=async(body,ip='203.0.113.8',plain=false)=>h.request('/api/analytics/collect',{method:'POST',plain,ip,from:new URL(body.page).origin,body});
  assert.equal((await post(event,undefined,true)).res.status,204);await post(event);assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM page_views').get().n,1);
  await post({...event,eventId:randomUUID(),page:'https://first.example/product?different=1'},'198.51.100.9');
  await post({...event,eventId:randomUUID(),visitorId:other,page:'https://unrestricted.example/about',referrer:''});
  const stats=(await h.request('/api/admin/analytics/stats?days=1&site='+site,{cookie})).data;
  assert.deepEqual(stats.summary,{pv:3,uv:2,ips:2,pages:2,domains:2});assert.equal(stats.pages.items[0].page,'https://first.example/product');assert.equal(stats.pages.items[0].pv,2);assert.equal(stats.pages.items[0].uv,1);
  assert.equal(stats.visitors.items.find(v=>v.pv===2).ip,'198.51.100.9');assert.match(stats.visitors.items[0].os,/Windows/);assert.match(stats.visitors.items[0].browser,/Chrome/);
  assert.equal(h.db.prepare('SELECT referrer FROM page_views LIMIT 1').get().referrer,'https://search.example/find');assert.equal(stats.sources.find(s=>s.name==='https://search.example').pv,2);
  assert.equal((await post({...event,eventId:'bad'})).res.status,400);
  assert.equal((await h.request('/api/analytics/collect',{method:'POST',from:'https://wrong.example',body:event})).res.status,400);
  assert.equal((await h.request('/api/analytics/collect',{method:'POST',body:{...event,page:'javascript:alert(1)'}})).res.status,400);
  assert.equal((await post({...event,siteId:randomUUID()})).res.status,404);
  for(const query of ['days=2','pagesPage=-1','visitorsPage=0','visitorsPage=hello'])assert.equal((await h.request('/api/admin/analytics/stats?'+query,{cookie})).res.status,400);
  assert.equal((await h.request('/api/admin/analytics/stats?site='+randomUUID(),{cookie})).res.status,404);
  await h.request('/api/admin/analytics/sites/'+site,{method:'PUT',cookie,body:{name:'新名字'}});await h.restart();const newCookie=await h.login();
  assert.equal((await h.request('/api/admin/analytics/sites',{cookie:newCookie})).data[0].name,'新名字');assert.equal((await h.request('/api/admin/analytics/stats',{cookie:newCookie})).data.summary.pv,3);
});

test('traffic totals cover all records and site scopes with pagination, empty states and Beijing day boundaries',async t=>{
  const h=await harness(t),cookie=await h.login(),site=await h.site(cookie,'主要站点'),secondary=await h.site(cookie,'第二站点');
  const insert=h.db.prepare('INSERT INTO page_views(site_id,event_id,visitor_hash,page,host,title,referrer,source,ip,region,os,browser,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const hash=(sid,id)=>createHash('sha256').update(sid+':'+id).digest('hex');const stamp=Date.now()-10;
  h.db.exec('BEGIN');for(let i=0;i<205;i++)insert.run(site,randomUUID(),hash(site,String(i)),'https://shop.example/page/'+i,'shop.example','页面 '+i,'','','203.0.113.8','测试地区','macOS','Safari',stamp);insert.run(secondary,randomUUID(),hash(secondary,'0'),'https://other.example/','other.example','首页','','','203.0.113.8','测试地区','macOS','Safari',stamp);h.db.exec('COMMIT');
  let result=(await h.request('/api/admin/analytics/stats?days=1&pagesPage=5&visitorsPage=5&site='+site,{cookie})).data;
  assert.equal(result.summary.pv,205);assert.equal(result.summary.uv,205);assert.equal(result.pages.total,205);assert.equal(result.pages.items.length,5);assert.equal(result.visitors.items.length,5);assert.equal(result.sites.length,1);
  assert.equal((await h.request('/api/admin/analytics/stats?days=1',{cookie})).data.summary.uv,206,'UV scope includes site identity');
  assert.equal((await h.request('/api/admin/analytics/stats?pagesPage=999999&site='+site,{cookie})).data.pages.page,5);
  const empty=await h.site(cookie,'空站点');result=(await h.request('/api/admin/analytics/stats?site='+empty,{cookie})).data;assert.equal(result.summary.pv,0);assert.equal(result.pages.items.length,0);assert.equal(result.pages.pages,1);assert.equal(result.daily.length,7);
  const midnight=Math.floor((Date.now()+OFFSET)/DAY)*DAY-OFFSET;
  h.db.exec('DELETE FROM page_views');const browser=hash(site,'same-browser');
  insert.run(site,randomUUID(),browser,'https://shop.example/','shop.example','首页','','','203.0.113.8','测试地区','macOS','Safari',midnight-1);
  insert.run(site,randomUUID(),browser,'https://shop.example/','shop.example','首页','','','203.0.113.8','测试地区','macOS','Safari',midnight);
  result=(await h.request('/api/admin/analytics/stats?days=1',{cookie})).data;assert.equal(result.summary.pv,1);assert.equal(result.start,midnight);
  result=(await h.request('/api/admin/analytics/stats?days=7',{cookie})).data;assert.equal(result.summary.pv,2);assert.equal(result.summary.uv,1);assert.equal(result.daily.reduce((sum,d)=>sum+d.uv,0),2,'daily UVs cannot be summed into period UV');
});
