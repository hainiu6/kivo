import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import geoip from 'geoip-lite';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const now = () => Date.now();
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function originOf(value) { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin : ''; } catch { return ''; } }
function safePage(value) { try { const u = new URL(value); if (!originOf(value)) return ''; u.username = ''; u.password = ''; return u.href.slice(0, 2048); } catch { return ''; } }
function cookieToken(req) { const match = /(?:^|;\s*)kivo_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || ''); return match?.[1]; }

export function createKivo(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || './data';
  const publicUrl = (options.publicUrl || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const publicOrigin = originOf(publicUrl);
  if (!publicOrigin || new URL(publicUrl).pathname !== '/') throw new Error('PUBLIC_URL must be an HTTP(S) origin without a path.');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, 'kivo.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#0f766e', greeting TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), visitor_hash TEXT NOT NULL, name TEXT NOT NULL, ip TEXT NOT NULL, region TEXT NOT NULL, page TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', unread INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(site_id, visitor_hash));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id), sender TEXT NOT NULL, body TEXT NOT NULL, client_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(conversation_id, sender, client_id));
    CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
    PRAGMA user_version=1;`);
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    const password = options.adminPassword || process.env.ADMIN_PASSWORD;
    if (!password || password.length < 12) { db.close(); throw new Error('First start requires ADMIN_PASSWORD with at least 12 characters.'); }
    db.prepare('INSERT INTO users VALUES (?, ?, ?)').run(randomUUID(), text(options.adminUsername || process.env.ADMIN_USERNAME || 'admin'), bcrypt.hashSync(password, 12));
  }
  const app = express();
  app.disable('x-powered-by');
  const trustProxy = Number(options.trustProxy ?? process.env.TRUST_PROXY ?? 0);
  if (![0, 1].includes(trustProxy)) throw new Error('TRUST_PROXY must be 0 or 1.');
  app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '12kb' }));
  const server = createServer(app);
  const siteById = id => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
  const siteAllows = (site, origin) => !!site && (origin === publicOrigin || JSON.parse(site.origins).includes(origin));
  const isKnownOrigin = origin => origin === publicOrigin || db.prepare('SELECT origins FROM sites').all().some(s => JSON.parse(s.origins).includes(origin));
  // Browsers omit Origin on same-origin polling GETs; their Referer still
  // identifies our dashboard/iframe. Cross-origin requests must supply Origin.
  const socketOrigin = req => req.headers.origin || (originOf(req.headers.referer) === publicOrigin ? publicOrigin : '');
  const io = new Server(server, {
    maxHttpBufferSize: 16384,
    cors: { origin: (origin, cb) => cb(null, !origin || isKnownOrigin(origin)), credentials: true },
    allowRequest: (req, cb) => cb(null, isKnownOrigin(socketOrigin(req)))
  });
  const visitors = new Map();
  const admins = new Set();
  const sessionUser = req => {
    const raw = cookieToken(req);
    if (!raw) return null;
    return db.prepare('SELECT users.id, users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND expires>?').get(hash(raw), now());
  };
  const adminOnly = (req, res, next) => { req.user = sessionUser(req); req.user ? next() : res.status(401).json({ error: '请先登录' }); };
  const sameOrigin = (req, res, next) => req.headers.origin === publicOrigin ? next() : res.status(403).json({ error: '请求来源不允许，请检查 PUBLIC_URL' });
  const ipOf = req => {
    if (req.ip) return req.ip.replace(/^::ffff:/, '');
    // The bundled proxy is the only network path to the application container.
    const forwarded = trustProxy === 1 ? req.headers['x-forwarded-for']?.split(',').at(-1)?.trim() : null;
    return (forwarded || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  };
  const regionOf = ip => {
    const geo = geoip.lookup(ip);
    if (!geo) return '未知 / 内网';
    let country = geo.country;
    try { country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(geo.country); } catch { /* keep ISO code */ }
    return [country, geo.region, geo.city].filter(Boolean).join(' · ');
  };
  const conversation = id => {
    const c = db.prepare(`SELECT c.*, s.name AS site_name, (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message FROM conversations c JOIN sites s ON c.site_id=s.id WHERE c.id=?`).get(id);
    return c ? { ...c, visitor_hash: undefined, online: (visitors.get(id)?.size || 0) > 0 } : null;
  };
  const updateConversation = id => io.to('admins').emit('conversation:update', conversation(id));
  const messages = (id, before) => {
    const limit = before && Number.isSafeInteger(Number(before)) ? Number(before) : Number.MAX_SAFE_INTEGER;
    return db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 100').all(id, limit).reverse();
  };
  function saveMessage(id, sender, data) {
    if (!uuid(data?.clientId) || typeof data?.body !== 'string' || !data.body.trim() || data.body.length > 4000) throw new Error('消息须为 1–4000 字符');
    const existing = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sender=? AND client_id=?').get(id, sender, data.clientId);
    if (existing) return existing;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('INSERT INTO messages(conversation_id,sender,body,client_id,created_at) VALUES(?,?,?,?,?)').run(id, sender, data.body.trim(), data.clientId, now());
      db.prepare(`UPDATE conversations SET updated_at=?, status='open', unread=unread+? WHERE id=?`).run(now(), sender === 'visitor' ? 1 : 0, id);
      db.exec('COMMIT');
      const message = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
      io.to('admins').to(`conversation:${id}`).emit('message:new', message);
      updateConversation(id);
      return message;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (req.path === '/widget') {
      const site = siteById(req.query.site);
      const origins = site ? JSON.parse(site.origins) : [];
      res.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'self' ${origins.join(' ')}; base-uri 'none'; form-action 'self'`);
    } else if (!req.path.startsWith('/api/widget') && req.path !== '/widget.js') {
      res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    }
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: '登录尝试过多，请稍后重试' } });
  app.post('/api/login', sameOrigin, loginLimiter, async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(text(req.body?.username));
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '';
    // Compare a valid hash even for unknown users to avoid an obvious timing oracle.
    const valid = await bcrypt.compare(password, user?.password || '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!user || !valid) return res.status(401).json({ error: '账号或密码错误' });
    const raw = token();
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, now() + 7 * 86400000);
    res.cookie('kivo_session', raw, { httpOnly: true, sameSite: 'lax', secure: publicOrigin.startsWith('https:'), path: '/', maxAge: 7 * 86400000 });
    res.json({ username: user.username });
  });
  app.use('/api/admin', adminOnly);
  app.use('/api/admin', (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : sameOrigin(req, res, next));
  app.get('/api/admin/me', (req, res) => res.json({ username: req.user.username, publicUrl }));
  app.post('/api/admin/logout', (req, res) => {
    const raw = cookieToken(req);
    db.prepare('DELETE FROM sessions WHERE token=?').run(hash(raw));
    for (const socket of io.of('/').sockets.values()) if (socket.data.sessionHash === hash(raw)) socket.disconnect(true);
    res.clearCookie('kivo_session', { path: '/' }); res.json({ ok: true });
  });
  app.post('/api/admin/password', async (req, res) => {
    const oldPassword = req.body?.oldPassword;
    const newPassword = req.body?.newPassword;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) return res.status(400).json({ error: '新密码须为 12–128 字符' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!await bcrypt.compare(oldPassword, user.password)) return res.status(400).json({ error: '当前密码错误' });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    for (const socket of io.of('/').sockets.values()) if (socket.data.userId === user.id) socket.disconnect(true);
    res.clearCookie('kivo_session', { path: '/' }); res.json({ ok: true });
  });
  app.get('/api/admin/sites', (_req, res) => res.json(db.prepare('SELECT * FROM sites ORDER BY created_at').all().map(s => ({ ...s, origins: JSON.parse(s.origins) }))));
  function siteInput(body) {
    const name = text(body?.name, 60);
    const greeting = text(body?.greeting, 300) || '你好，欢迎联系我们！有什么可以帮你？';
    const color = /^#[0-9a-f]{6}$/i.test(body?.color || '') ? body.color : '#0f766e';
    const raw = Array.isArray(body?.origins) ? body.origins : [];
    if (!name || !raw.length || raw.length > 20) throw new Error('请填写网站名称和 1–20 个允许的网址来源');
    const origins = [...new Set(raw.map(v => originOf(v)))];
    if (origins.includes('')) throw new Error('网址必须以 http:// 或 https:// 开头');
    return { name, greeting, color, origins: JSON.stringify(origins) };
  }
  app.post('/api/admin/sites', (req, res) => {
    try { const s = siteInput(req.body); const id = randomUUID(); db.prepare('INSERT INTO sites VALUES(?,?,?,?,?,?)').run(id, s.name, s.origins, s.color, s.greeting, now()); res.status(201).json({ id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/sites/:id', (req, res) => {
    if (!siteById(req.params.id)) return res.status(404).json({ error: '网站不存在' });
    try { const s = siteInput(req.body); db.prepare('UPDATE sites SET name=?,origins=?,color=?,greeting=? WHERE id=?').run(s.name, s.origins, s.color, s.greeting, req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/conversations', (req, res) => {
    const q = `%${text(req.query.q, 100)}%`;
    const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : '';
    const site = text(req.query.site);
    const rows = db.prepare(`SELECT id FROM conversations WHERE (name LIKE ? OR ip LIKE ? OR page LIKE ?) AND (?='' OR status=?) AND (?='' OR site_id=?) ORDER BY updated_at DESC LIMIT 200`).all(q,q,q,status,status,site,site);
    res.json(rows.map(r => conversation(r.id)));
  });
  app.get('/api/admin/conversations/:id/messages', (req, res) => {
    if (!conversation(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    res.json(messages(req.params.id, req.query.before));
  });
  app.post('/api/admin/conversations/:id/read', (req, res) => {
    if (!conversation(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    // Only clear messages the client actually loaded; new arrivals remain unread.
    const lastId = Number(req.body?.lastId);
    if (!Number.isSafeInteger(lastId) || lastId < 0) return res.status(400).json({ error: '消息编号无效' });
    db.prepare("UPDATE conversations SET unread=(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND sender='visitor' AND id>?) WHERE id=?").run(req.params.id,lastId,req.params.id);
    updateConversation(req.params.id); res.json({ ok: true });
  });
  app.post('/api/admin/conversations/:id/status', (req, res) => {
    const c = conversation(req.params.id);
    if (!c) return res.status(404).json({ error: '会话不存在' });
    if (!['open', 'closed'].includes(req.body?.status)) return res.status(400).json({ error: '状态无效' });
    db.prepare('UPDATE conversations SET status=? WHERE id=?').run(req.body.status, c.id);
    updateConversation(c.id); res.json({ ok: true });
  });
  app.use('/api/widget', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isKnownOrigin(origin)) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' });
    if (req.method === 'OPTIONS') return res.sendStatus(origin && isKnownOrigin(origin) ? 204 : 403);
    next();
  });
  const visitorLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '请求过于频繁，请稍后再试' } });
  app.post('/api/widget/session', visitorLimiter, (req, res) => {
    const site = siteById(req.body?.siteId);
    if (!siteAllows(site, req.headers.origin)) return res.status(403).json({ error: '网站未授权，请检查后台允许来源' });
    const page = safePage(req.body?.page);
    if (!page || originOf(page) !== req.headers.origin) return res.status(400).json({ error: '访问地址无效' });
    const raw = validToken(req.body?.visitorToken) ? req.body.visitorToken : token();
    const visitorHash = hash(raw);
    let c = db.prepare('SELECT id FROM conversations WHERE site_id=? AND visitor_hash=?').get(site.id, visitorHash);
    const ip = ipOf(req);
    if (!c) {
      c = { id: randomUUID() };
      db.prepare('INSERT INTO conversations(id,site_id,visitor_hash,name,ip,region,page,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.id, site.id, visitorHash, `访客 ${c.id.slice(0, 6).toUpperCase()}`, ip, regionOf(ip), page, now(), now());
    } else db.prepare('UPDATE conversations SET ip=?,region=?,page=? WHERE id=?').run(ip,regionOf(ip),page,c.id);
    updateConversation(c.id);
    res.json({ visitorToken: raw, conversationId: c.id, site: { id: site.id, name: site.name, color: site.color, greeting: site.greeting } });
  });
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (auth.role === 'admin') {
      if (socketOrigin(socket.request) !== publicOrigin) return next(new Error('来源无效'));
      const user = sessionUser(socket.request);
      if (!user) return next(new Error('登录已过期'));
      socket.data.role = 'admin'; socket.data.userId = user.id; socket.data.sessionHash = hash(cookieToken(socket.request));
    } else {
      if (!validToken(auth.visitorToken) || !uuid(auth.siteId)) return next(new Error('访客凭证无效'));
      const c = db.prepare('SELECT id FROM conversations WHERE site_id=? AND visitor_hash=?').get(auth.siteId,hash(auth.visitorToken));
      if (!c) return next(new Error('访客凭证无效'));
      socket.data.role = 'visitor'; socket.data.conversationId = c.id;
    }
    next();
  });
  io.on('connection', socket => {
    if (socket.data.role === 'admin') {
      socket.join('admins'); admins.add(socket.id); io.emit('agents:status', { online: true });
    } else {
      const id = socket.data.conversationId;
      socket.join(`conversation:${id}`);
      if (!visitors.has(id)) visitors.set(id, new Set());
      visitors.get(id).add(socket.id); updateConversation(id);
      socket.emit('history', messages(id)); socket.emit('agents:status', { online: admins.size > 0 });
    }
    let windowStart = now(), count = 0;
    socket.on('message:send', (data, ack = () => {}) => {
      if (typeof ack !== 'function') return;
      try {
        if (now() - windowStart > 10000) { count = 0; windowStart = now(); }
        if (++count > 20) throw new Error('发送过于频繁，请稍后再试');
        if (socket.data.role === 'admin' && !sessionUser(socket.request)) { socket.disconnect(true); throw new Error('登录已过期'); }
        const id = socket.data.role === 'admin' ? data?.conversationId : socket.data.conversationId;
        if (!uuid(id) || !conversation(id)) throw new Error('会话不存在');
        ack({ ok: true, message: saveMessage(id, socket.data.role === 'admin' ? 'agent' : 'visitor', data) });
      } catch (e) { ack({ ok: false, error: e.message }); }
    });
    socket.on('visitor:page', data => {
      if (socket.data.role !== 'visitor') return;
      const c = conversation(socket.data.conversationId);
      const site = siteById(c.site_id);
      const page = safePage(data?.page);
      if (!page || !siteAllows(site,originOf(page))) return;
      db.prepare('UPDATE conversations SET page=? WHERE id=?').run(page,c.id); updateConversation(c.id);
    });
    socket.on('disconnect', () => {
      if (socket.data.role === 'admin') { admins.delete(socket.id); io.emit('agents:status', { online: admins.size > 0 }); }
      else { const id = socket.data.conversationId; visitors.get(id)?.delete(socket.id); if (!visitors.get(id)?.size) visitors.delete(id); updateConversation(id); }
    });
  });
  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    for (const socket of io.of('/').sockets.values()) if (socket.data.role === 'admin' && !sessionUser(socket.request)) socket.disconnect(true);
  }, 60000);
  cleanup.unref();
  app.get('/widget', (_req,res) => res.sendFile(path.join(publicDir,'widget.html')));
  app.get('/demo', (_req,res) => res.sendFile(path.join(publicDir,'demo.html')));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  app.use('/api', (_req,res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err, _req, res, _next) => { console.error(err.message); res.status(err.status || 500).json({ error: err.status === 413 ? '请求内容过大' : '请求失败，请稍后再试' }); });
  return { app, server, db, io, close: async () => { clearInterval(cleanup); await new Promise(resolve => io.close(resolve)); db.close(); } };
}
