const DAY = 86400000, OFFSET = 8 * 3600000;
const dateKey = time => new Date(time + OFFSET).toISOString().slice(0,10);
const emptyCounts = () => ({newConversations:0,chatConversations:0,visitorMessages:0,agentMessages:0,autoMessages:0,textMessages:0,imageMessages:0,stickerMessages:0,openConversations:0,unreadMessages:0,onlineVisitors:0});

export function registerStatsRoutes(app, { db, visitors }) {
  // Additive indexes also work with older application images after rollback.
  db.exec('CREATE INDEX IF NOT EXISTS messages_created ON messages(created_at); CREATE INDEX IF NOT EXISTS conversations_created ON conversations(created_at);');
  app.get('/api/admin/stats', (req, res) => {
    const days = req.query.days === undefined ? 7 : Number(req.query.days), site = req.query.site || '';
    if (!['1','7','30','90'].includes(String(req.query.days ?? 7)) || ![1,7,30,90].includes(days) || typeof site !== 'string') return res.status(400).json({error:'统计筛选无效'});
    if (site && !db.prepare('SELECT id FROM sites WHERE id=?').get(site)) return res.status(404).json({error:'网站不存在'});
    const end = Date.now(), start = Math.floor((end + OFFSET) / DAY) * DAY - OFFSET - (days - 1) * DAY;
    const scope = site ? ' AND c.site_id=?' : '', params = site ? [start,end,site] : [start,end];
    const rows = db.prepare('SELECT id,name FROM sites'+(site?' WHERE id=?':'')+' ORDER BY created_at,id').all(...(site?[site]:[]));
    const sites = new Map(rows.map(s => [s.id,{...s,...emptyCounts()}]));
    const daily = Array.from({length:days},(_,i)=>({date:dateKey(start+i*DAY),newConversations:0,visitorMessages:0,agentMessages:0,autoMessages:0})), dates = new Map(daily.map(d=>[d.date,d]));
    const newRows = db.prepare(`SELECT c.site_id, strftime('%Y-%m-%d',c.created_at/1000,'unixepoch','+8 hours') AS date, COUNT(*) AS total FROM conversations c WHERE c.created_at>=? AND c.created_at<=?${scope} GROUP BY c.site_id,date`).all(...params);
    for (const row of newRows) { sites.get(row.site_id).newConversations+=row.total; dates.get(row.date).newConversations+=row.total; }
    const fields = `SUM(m.sender='visitor') AS visitorMessages, SUM(m.sender='agent') AS agentMessages, SUM(m.sender='auto') AS autoMessages`;
    const messageDays = db.prepare(`SELECT c.site_id, strftime('%Y-%m-%d',m.created_at/1000,'unixepoch','+8 hours') AS date, ${fields} FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.created_at>=? AND m.created_at<=?${scope} GROUP BY c.site_id,date`).all(...params);
    for (const row of messageDays) for (const key of ['visitorMessages','agentMessages','autoMessages']) dates.get(row.date)[key]+=row[key];
    const totals = db.prepare(`SELECT c.site_id,COUNT(DISTINCT c.id) AS chatConversations,${fields},SUM(m.kind='text') AS textMessages,SUM(m.kind='image') AS imageMessages,SUM(m.kind='sticker') AS stickerMessages FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.created_at>=? AND m.created_at<=?${scope} GROUP BY c.site_id`).all(...params);
    for (const row of totals) { const {site_id,...counts}=row; Object.assign(sites.get(site_id),counts); }
    const current = db.prepare(`SELECT c.site_id,SUM(c.status='open') AS openConversations,SUM(c.unread) AS unreadMessages FROM conversations c WHERE 1=1${scope} GROUP BY c.site_id`).all(...(site?[site]:[]));
    for (const row of current) Object.assign(sites.get(row.site_id),{openConversations:row.openConversations,unreadMessages:row.unreadMessages});
    const siteFor = db.prepare('SELECT site_id FROM conversations WHERE id=?');
    for (const [id,connections] of visitors) if (connections.size) { const s=sites.get(siteFor.get(id)?.site_id); if(s)s.onlineVisitors++; }
    const summary = emptyCounts();
    for(const s of sites.values())for(const key of Object.keys(summary))summary[key]+=s[key];
    res.json({days,site,start,end,timezone:'Asia/Shanghai',summary,daily,sites:[...sites.values()].sort((a,b)=>b.visitorMessages-a.visitorMessages||b.newConversations-a.newConversations)});
  });
}
