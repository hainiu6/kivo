import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { signClientIdentity, verifyIdentity } from './identity.js';

const prefix = '/api/client/v1';
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const bearer = req => /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1];
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const platforms = new Set(['Windows', 'macOS', 'Linux', 'Android', 'iOS', 'Other']);
const clean = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);

export function registerClientRoutes(app, context) {
  const { db, io, dataDir, publicOrigin, siteById, siteAllows, identitySecret, resolveVisitor, openSession, siteProfile, agentsOnline, saveMessage, imageLimiter, imageBody, upload, ipOf, regionOf, visitors, updateConversation, publishPresence, isKnownOrigin, readVisitorMessages } = context;
  db.exec(`CREATE TABLE IF NOT EXISTS client_profiles(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,info TEXT NOT NULL,attributes TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS client_revocations(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS client_revocations_expiry ON client_revocations(expires);`);
  const leases = new Map();
  const validIdentity = (raw, siteId) => {
    const identity = verifyIdentity(raw, siteId, identitySecret(siteId));
    if (!identity.client || db.prepare('SELECT 1 FROM client_revocations WHERE token_hash=?').get(tokenHash(raw))) throw new Error('客户端凭证无效或已撤销');
    return identity;
  };
  const removeLease = (key, id) => {
    leases.delete(key); visitors.get(id)?.delete(key);
    if (!visitors.get(id)?.size) visitors.delete(id);
    updateConversation(id); publishPresence();
  };
  const touch = (req, id, identity) => {
    const key = 'client:' + tokenHash(req.clientToken), first = !leases.has(key);
    const connected = [...io.of('/').sockets.values()].some(socket => socket.connected && socket.data.visitorToken === req.clientToken);
    if (!connected) {
      leases.set(key, { id, until: Math.min(Date.now() + 90000, identity.exp * 1000) });
      if (!visitors.has(id)) visitors.set(id, new Set());
      visitors.get(id).add(key);
    }
    const ip = ipOf(req);
    db.prepare('UPDATE conversations SET ip=?,region=? WHERE id=?').run(ip, regionOf(ip), id);
    if (first && !connected) { updateConversation(id); publishPresence(); }
  };
  app.use(prefix, (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !isKnownOrigin(origin)) return res.status(403).json({ error: '请求来源不允许' });
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Kivo-Site', Vary: 'Origin' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const limiter = rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '请求过于频繁，请稍后重试' } });
  const issueLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '凭证申请过于频繁，请稍后重试' } });
  app.post(prefix + '/tokens', issueLimiter, (req, res) => {
    // Long-lived keys belong on the business server, never in a browser/app bundle.
    if (req.headers.origin) return res.status(403).json({ error: '凭证签发接口仅供业务后端调用' });
    const siteId = req.body?.siteId, secret = uuid(siteId) && identitySecret(siteId), supplied = bearer(req);
    if (!secret || !/^[a-f0-9]{64}$/.test(supplied || '') || !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) return res.status(401).json({ error: '站点 ID 或后端密钥无效' });
    const ttl = req.body?.ttl ?? 900;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900) return res.status(400).json({ error: 'ttl 须为 60–900 秒' });
    try { res.status(201).json(signClientIdentity(siteId, secret, req.body?.user, ttl, randomUUID())); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  const authorize = (req, res, next) => {
    req.clientToken = bearer(req);
    try { req.clientIdentity = validIdentity(req.clientToken, req.headers['x-kivo-site']); }
    catch { return res.status(401).json({ error: '客户端凭证无效、已过期或已撤销，请重新获取凭证' }); }
    if (req.headers.origin && !siteAllows(siteById(req.headers['x-kivo-site']), req.headers.origin)) return res.status(403).json({ error: '该站点未授权当前网页来源' });
    const c = resolveVisitor(req.headers['x-kivo-site'], req.clientToken);
    if (!c) return res.status(404).json({ error: '会话不存在，请由用户主动重新创建会话' });
    req.clientConversation = c;
    touch(req, c.id, req.clientIdentity); next();
  };
  const sessionData = (id, identity, raw) => ({ conversationId: id, accessToken: raw, expiresAt: identity.exp, user: { userId: identity.userId, account: identity.account, nickname: identity.nickname, attributes: identity.attributes }, support: { ...siteProfile(db.prepare('SELECT site_id FROM conversations WHERE id=?').get(id).site_id), online: agentsOnline() }, socket: { url: publicOrigin, path: '/socket.io', protocol: 'Socket.IO 4' } });
  app.post(prefix + '/sessions', limiter, (req, res) => {
    const siteId = req.body?.siteId, raw = req.body?.identityToken;
    let identity;
    try { identity = validIdentity(raw, siteId); } catch { return res.status(401).json({ error: '客户端凭证无效、已过期或已撤销' }); }
    if (req.headers.origin && !siteAllows(siteById(siteId), req.headers.origin)) return res.status(403).json({ error: '该站点未授权当前网页来源' });
    const client = req.body?.client, screen = req.body?.screen ?? '';
    if (!client || !platforms.has(client.platform) || !clean(client.version ?? '', 40) || !clean(client.device ?? '', 80) || !clean(screen, 128)) return res.status(400).json({ error: '客户端平台、版本、设备或当前页面信息无效' });
    const result = openSession({ site: siteById(siteId), identity, raw, ip: ipOf(req), page: publicOrigin + '/client', visitorName: '', ua: req.headers['user-agent'] });
    const info = { platform: client.platform, version: client.version ?? '', device: client.device ?? '', screen };
    db.prepare('INSERT INTO client_profiles VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET info=excluded.info,attributes=excluded.attributes').run(result.conversationId, JSON.stringify(info), JSON.stringify(identity.attributes));
    db.prepare("UPDATE visitor_devices SET os=CASE WHEN os='未知系统' THEN ? ELSE os END,browser=CASE WHEN browser='未知浏览器' THEN '原生客户端' ELSE browser END WHERE conversation_id=?").run(client.platform, result.conversationId);
    req.clientToken = raw; touch(req, result.conversationId, identity); updateConversation(result.conversationId);
    res.json(sessionData(result.conversationId, identity, raw));
  });
  app.get(prefix + '/session', limiter, authorize, (req, res) => res.json(sessionData(req.clientConversation.id, req.clientIdentity, req.clientToken)));
  app.delete(prefix + '/session', limiter, authorize, (req, res) => {
    db.prepare('INSERT OR REPLACE INTO client_revocations VALUES(?,?)').run(tokenHash(req.clientToken), req.clientIdentity.exp * 1000);
    removeLease('client:' + tokenHash(req.clientToken), req.clientConversation.id);
    for (const socket of io.of('/').sockets.values()) if (socket.data.visitorToken === req.clientToken) socket.disconnect(true);
    res.json({ ok: true });
  });
  app.get(prefix + '/messages', limiter, authorize, (req, res) => {
    const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
    if (!Number.isSafeInteger(before) || before < 1) return res.status(400).json({ error: 'before 须为正整数消息 ID' });
    const rows = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 101').all(req.clientConversation.id, before);
    const hasMore = rows.length > 100, messages = rows.slice(0, 100).reverse();
    res.json({ conversationId: req.clientConversation.id, messages, hasMore, nextBefore: hasMore ? messages[0].id : null });
  });
  const sendLimiter = rateLimit({ windowMs: 10000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: req => req.clientConversation.id, message: { error: '发送过于频繁，请稍后重试' } });
  app.post(prefix + '/messages', limiter, authorize, sendLimiter, (req, res) => {
    try { res.json({ ok: true, message: saveMessage(req.clientConversation.id, 'visitor', req.body) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  app.post(prefix + '/images', authorize, (req, _res, next) => { req.uploadConversation = req.clientConversation.id; next(); }, imageLimiter, imageBody, upload('chat'));
  app.get(prefix + '/images/:id', limiter, authorize, (req, res) => {
    const media = uuid(req.params.id) && db.prepare("SELECT id FROM media WHERE id=? AND kind='chat' AND conversation_id=?").get(req.params.id, req.clientConversation.id);
    if (!media) return res.status(404).json({ error: '图片不存在或无权访问' });
    res.type('image/webp').sendFile(path.resolve(dataDir, 'media', media.id + '.webp'));
  });
  app.post(prefix + '/read', limiter, authorize, (req, res) => {
    try { res.json(readVisitorMessages(req.clientConversation.id, req.body?.lastId)); }
    catch (error) { res.status(400).json({error:error.message}); }
  });
  app.post(prefix + '/context', limiter, authorize, (req, res) => {
    if (!clean(req.body?.screen, 128)) return res.status(400).json({ error: 'screen 须为最多 128 字符的文本' });
    const existing = db.prepare('SELECT info FROM client_profiles WHERE conversation_id=?').get(req.clientConversation.id);
    if (!existing) return res.status(404).json({ error: '请先创建客户端会话' });
    const info = { ...JSON.parse(existing.info), screen: req.body.screen };
    db.prepare('UPDATE client_profiles SET info=? WHERE conversation_id=?').run(JSON.stringify(info), req.clientConversation.id);
    updateConversation(req.clientConversation.id); res.json({ ok: true });
  });
  const cleanup = setInterval(() => {
    const time = Date.now();
    db.prepare('DELETE FROM client_revocations WHERE expires<=?').run(time);
    for (const [key, lease] of leases) if (lease.until <= time || !db.prepare('SELECT 1 FROM conversations WHERE id=?').get(lease.id)) removeLease(key, lease.id);
  }, 15000);
  cleanup.unref();
  return { validIdentity, releaseLease: (raw, id) => { const key = 'client:' + tokenHash(raw); if (leases.has(key)) removeLease(key, id); }, close: () => clearInterval(cleanup) };
}
