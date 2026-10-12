import express from 'express';
import { randomUUID, createHash } from 'node:crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { deviceInfo } from './device.js';

const DAY=86400000,OFFSET=8*3600000,LIMIT=50;
const uuid=value=>typeof value==='string'&&/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const dateKey=time=>new Date(time+OFFSET).toISOString().slice(0,10);
const clean=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').trim().slice(0,max):'';
function webURL(value){
  if(typeof value!=='string'||value.length>2048)return null;
  try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;return url;}catch{return null;}
}
const pageKey=url=>url.origin+url.pathname+(url.hash.startsWith('#/')?url.hash.split('?')[0]:'');

export function registerAnalyticsRoutes(app,{db,ipOf,regionOf}){
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_sites(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS page_views(id INTEGER PRIMARY KEY AUTOINCREMENT,site_id TEXT NOT NULL REFERENCES analytics_sites(id),event_id TEXT NOT NULL,visitor_hash TEXT NOT NULL,page TEXT NOT NULL,host TEXT NOT NULL,title TEXT NOT NULL,referrer TEXT NOT NULL,source TEXT NOT NULL,ip TEXT NOT NULL,region TEXT NOT NULL,os TEXT NOT NULL,browser TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(site_id,event_id));
    CREATE INDEX IF NOT EXISTS page_views_created ON page_views(created_at);
    CREATE INDEX IF NOT EXISTS page_views_site_created ON page_views(site_id,created_at);
    CREATE INDEX IF NOT EXISTS page_views_visitor ON page_views(visitor_hash,created_at);`);
  const siteById=id=>uuid(id)&&db.prepare('SELECT * FROM analytics_sites WHERE id=?').get(id);
  app.get('/api/admin/analytics/sites',(_req,res)=>res.json(db.prepare('SELECT * FROM analytics_sites ORDER BY created_at,id').all()));
  const nameOf=body=>typeof body?.name==='string'&&body.name.trim().length<=60?clean(body.name,60):'';
  app.post('/api/admin/analytics/sites',(req,res)=>{
    const name=nameOf(req.body);if(!name)return res.status(400).json({error:'请填写 1–60 字符的站点名称'});
    const id=randomUUID();db.prepare('INSERT INTO analytics_sites VALUES(?,?,?)').run(id,name,Date.now());res.status(201).json({id,name});
  });
  app.put('/api/admin/analytics/sites/:id',(req,res)=>{
    if(!siteById(req.params.id))return res.status(404).json({error:'统计站点不存在'});
    const name=nameOf(req.body);if(!name)return res.status(400).json({error:'请填写 1–60 字符的站点名称'});
    db.prepare('UPDATE analytics_sites SET name=? WHERE id=?').run(name,req.params.id);res.json({ok:true});
  });
  app.use('/api/analytics/collect',(req,res,next)=>{
    res.set({'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Cache-Control':'no-store'});
    if(req.method==='OPTIONS')return res.sendStatus(204);next();
  });
  const limiter=rateLimit({windowMs:60000,limit:1200,keyGenerator:req=>ipKeyGenerator(ipOf(req)),standardHeaders:'draft-8',legacyHeaders:false,message:{error:'访问上报过于频繁'}});
  app.post('/api/analytics/collect',limiter,express.text({type:'text/plain',limit:'8kb'}),(req,res)=>{
    let data=req.body;
    try{if(typeof data==='string')data=JSON.parse(data);}catch{return res.status(400).json({error:'访问数据格式无效'});}
    if(!data||JSON.stringify(data).length>8192||!uuid(data.eventId)||!uuid(data.visitorId))return res.status(400).json({error:'访问标识无效'});
    if(!siteById(data.siteId))return res.status(404).json({error:'统计站点不存在'});
    const url=webURL(data.page),origin=req.headers.origin;
    if(!url||(origin&&origin!==url.origin))return res.status(400).json({error:'访问地址与来源不匹配'});
    const referrer=webURL(data.referrer),ip=ipOf(req),device=deviceInfo(req.headers['user-agent']);
    const visitor=createHash('sha256').update(data.siteId+':'+data.visitorId.toLowerCase()).digest('hex');
    db.prepare('INSERT OR IGNORE INTO page_views(site_id,event_id,visitor_hash,page,host,title,referrer,source,ip,region,os,browser,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(data.siteId,data.eventId.toLowerCase(),visitor,pageKey(url),url.host,clean(data.title,200),referrer?referrer.origin+referrer.pathname:'',referrer?.origin||'',ip,regionOf(ip),device.os,device.browser,Date.now());
    res.sendStatus(204);
  });
  app.get('/api/admin/analytics/stats',(req,res)=>{
    const days=Number(req.query.days??7),site=req.query.site||'';
    const validPage=value=>value===undefined||typeof value==='string'&&/^[1-9]\d{0,5}$/.test(value);
    if(!['1','7','30','90'].includes(String(req.query.days??7))||typeof site!=='string'||!validPage(req.query.pagesPage)||!validPage(req.query.visitorsPage))return res.status(400).json({error:'统计筛选无效'});
    if(site&&!siteById(site))return res.status(404).json({error:'统计站点不存在'});
    const end=Date.now(),start=Math.floor((end+OFFSET)/DAY)*DAY-OFFSET-(days-1)*DAY;
    const where="p.created_at>=? AND p.created_at<=? AND (?='' OR p.site_id=?)",params=[start,end,site,site];
    const summary=db.prepare(`SELECT COUNT(*) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv,COUNT(DISTINCT p.ip) AS ips,COUNT(DISTINCT p.page) AS pages,COUNT(DISTINCT p.host) AS domains FROM page_views p WHERE ${where}`).get(...params);
    const daily=Array.from({length:days},(_,i)=>({date:dateKey(start+i*DAY),pv:0,uv:0})),dates=new Map(daily.map(d=>[d.date,d]));
    const dayRows=db.prepare(`SELECT strftime('%Y-%m-%d',p.created_at/1000,'unixepoch','+8 hours') AS date,COUNT(*) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv FROM page_views p WHERE ${where} GROUP BY date`).all(...params);
    for(const row of dayRows)Object.assign(dates.get(row.date),row);
    const siteRows=db.prepare(`SELECT s.id,s.name,COUNT(p.id) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv,MAX(p.created_at) AS lastVisit FROM analytics_sites s LEFT JOIN page_views p ON p.site_id=s.id AND p.created_at>=? AND p.created_at<=? WHERE (?='' OR s.id=?) GROUP BY s.id ORDER BY pv DESC,s.created_at`).all(...params);
    const paginate=(total,requested)=>{const pages=Math.max(1,Math.ceil(total/LIMIT)),page=Math.min(Number(requested||1),pages);return{total,page,pages,limit:LIMIT,offset:(page-1)*LIMIT};};
    const pagesMeta=paginate(summary.pages,req.query.pagesPage),visitorsMeta=paginate(summary.uv,req.query.visitorsPage);
    const pages=db.prepare(`SELECT a.page,a.pv,a.uv,a.lastVisit,p.title FROM (SELECT p.page,COUNT(*) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv,MAX(p.created_at) AS lastVisit,MAX(p.id) AS latest FROM page_views p WHERE ${where} GROUP BY p.page) a JOIN page_views p ON p.id=a.latest ORDER BY a.pv DESC,a.page LIMIT ? OFFSET ?`).all(...params,LIMIT,pagesMeta.offset);
    const visitors=db.prepare(`SELECT a.visitor_hash AS id,a.pv,a.firstVisit,a.lastVisit,p.ip,p.region,p.page,p.os,p.browser,s.name AS siteName FROM (SELECT p.visitor_hash,COUNT(*) AS pv,MIN(p.created_at) AS firstVisit,MAX(p.created_at) AS lastVisit,MAX(p.id) AS latest FROM page_views p WHERE ${where} GROUP BY p.visitor_hash) a JOIN page_views p ON p.id=a.latest JOIN analytics_sites s ON s.id=p.site_id ORDER BY a.lastVisit DESC,a.visitor_hash LIMIT ? OFFSET ?`).all(...params,LIMIT,visitorsMeta.offset);
    const domains=db.prepare(`SELECT p.host AS name,COUNT(*) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv FROM page_views p WHERE ${where} GROUP BY p.host ORDER BY pv DESC,p.host LIMIT 50`).all(...params);
    const sources=db.prepare(`SELECT p.source AS name,COUNT(*) AS pv,COUNT(DISTINCT p.visitor_hash) AS uv FROM page_views p WHERE ${where} GROUP BY p.source ORDER BY pv DESC,p.source LIMIT 50`).all(...params);
    res.json({days,site,start,end,timezone:'Asia/Shanghai',summary,daily,sites:siteRows,pages:{...pagesMeta,items:pages},visitors:{...visitorsMeta,items:visitors},domains,sources});
  });
}
