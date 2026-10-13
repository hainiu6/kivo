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
import { createRegionLookup } from './region.js';
import { deviceInfo } from './device.js';
import { MAX_IMAGE_BYTES, storeImage } from './media.js';
import multer from 'multer';
import { verifyIdentity } from './identity.js';
import { registerHistoryRoutes } from './history.js';
import { visitorIP } from './ip.js';
import { registerStatsRoutes } from './stats.js';
import { registerAnalyticsRoutes } from './analytics.js';
import { registerClientRoutes } from './client-api.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('hex');
const SESSION_MAX_AGE = 30 * 86400000;
const now = () => Date.now();
const text = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const uuid = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stickerIds = new Set(['hello', 'love', 'yay', 'laugh', 'cry', 'wait', 'coffee', 'thanks',
  'cat-dance','cat-wow','cat-love','cat-cheer','cat-sleep','cat-zoom',
  'capy-chill','capy-bath','capy-snack','capy-yay','capy-thanks','capy-spin',
  'bot-hi','bot-loading','bot-ok','bot-party','bot-power','bot-hug']);
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
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS site_replies(site_id TEXT PRIMARY KEY REFERENCES sites(id), config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auto_reply_state(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), last_sent INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visitor_devices(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), os TEXT NOT NULL, browser TEXT NOT NULL, ua TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, kind TEXT NOT NULL, conversation_id TEXT REFERENCES conversations(id), bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS site_identity(site_id TEXT PRIMARY KEY REFERENCES sites(id), secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS website_users(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),site_id TEXT NOT NULL REFERENCES sites(id),user_id TEXT NOT NULL,account TEXT NOT NULL,nickname TEXT NOT NULL,UNIQUE(site_id,user_id));
    CREATE TABLE IF NOT EXISTS visitor_labels(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS site_profiles(site_id TEXT PRIMARY KEY REFERENCES sites(id), support_name TEXT NOT NULL DEFAULT '在线客服', avatar_id TEXT REFERENCES media(id));`);
  // Additive migration keeps older deployment and rollback images compatible.
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
    if (!columns.has('kind')) db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
    if (!columns.has('media_id')) db.exec('ALTER TABLE messages ADD COLUMN media_id TEXT REFERENCES media(id)');
    if (!columns.has('sticker_id')) db.exec('ALTER TABLE messages ADD COLUMN sticker_id TEXT');
    db.exec('PRAGMA user_version=5; COMMIT');
  } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
  const defaultReplies = [{ label: '问候语', body: '你好，很高兴为你服务！' }, { label: '请稍候', body: '收到，请稍等，我帮你查看一下。' }, { label: '结束语', body: '感谢你的咨询，有其他问题随时联系我们。' }];
  const quickReplies = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key='quickReplies'").get()?.value || JSON.stringify(defaultReplies));
  const replyConfig = id => JSON.parse(db.prepare('SELECT config FROM site_replies WHERE site_id=?').get(id)?.config || '{"firstEnabled":false,"firstMessage":"","offlineEnabled":false,"offlineMessage":""}');
  const siteProfile = id => {
    const profile = db.prepare('SELECT * FROM site_profiles WHERE site_id=?').get(id);
    return { supportName: profile?.support_name || '在线客服', avatarId: profile?.avatar_id || '', avatarUrl: profile?.avatar_id ? `/avatars/${profile.avatar_id}` : '/support-avatar.svg' };
  };
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
  app.use('/api/analytics/collect', express.json({ limit: '8kb' }));
  app.use(express.json({ limit: '256kb' }));
  const server = createServer(app);
  const siteById = id => db.prepare('SELECT * FROM sites WHERE id=?').get(id);
  const originsAllow = (origins, origin) => !!originOf(origin) && originOf(origin) === origin && (origins.includes('*') || origins.includes(origin));
  const siteAllows = (site, origin) => !!site && (origin === publicOrigin || originsAllow(JSON.parse(site.origins), origin));
  const isKnownOrigin = origin => origin === publicOrigin || db.prepare('SELECT origins FROM sites').all().some(s => originsAllow(JSON.parse(s.origins), origin));
  // Browsers omit Origin on same-origin polling GETs; their Referer still
  // identifies our dashboard/iframe. Cross-origin requests must supply Origin.
  const socketOrigin = req => req.headers.origin || (originOf(req.headers.referer) === publicOrigin ? publicOrigin : '');
  const io = new Server(server, {
    maxHttpBufferSize: 16384,
    cors: { origin: (origin, cb) => cb(null, !origin || isKnownOrigin(origin)), credentials: true },
    allowRequest: (req, cb) => cb(null, (!req.headers.origin && !req.headers.referer) || isKnownOrigin(socketOrigin(req)))
  });
  const visitors = new Map();
  const admins = new Set();
  let availability = db.prepare("SELECT value FROM settings WHERE key='supportAvailability'").get()?.value === 'offline' ? 'offline' : 'online';
  const agentsOnline = () => availability === 'online' && admins.size > 0;
  const existingConversation = db.prepare('SELECT 1 FROM conversations WHERE id=?');
  const presence = () => ({ availability, online: agentsOnline(), onlineVisitors: [...visitors].filter(([id, sockets]) => sockets.size && existingConversation.get(id)).length });
  const publishPresence = () => io.to('admins').emit('presence:update', presence());
  const publishAgents = () => { io.emit('agents:status', { online: agentsOnline() }); publishPresence(); };
  const sessionUser = req => {
    const raw = cookieToken(req);
    if (!raw) return null;
    return db.prepare('SELECT users.id, users.username FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND expires>?').get(hash(raw), now());
  };
  const adminOnly = (req, res, next) => { req.user = sessionUser(req); req.user ? next() : res.status(401).json({ error: '请先登录' }); };
  const sameOrigin = (req, res, next) => req.headers.origin === publicOrigin ? next() : res.status(403).json({ error: '请求来源不允许，请检查 PUBLIC_URL' });
  const ipOf = req => visitorIP(req, trustProxy);
  const regionOf = createRegionLookup({ dataDir });
  const conversation = id => {
    const c = db.prepare(`SELECT c.*, s.name AS site_name, COALESCE(d.os,'未知系统') AS os, COALESCE(d.browser,'未知浏览器') AS browser, u.user_id,u.account,u.nickname,l.name AS visitor_name, (SELECT CASE kind WHEN 'image' THEN '[图片] ' || body WHEN 'sticker' THEN '[动态表情]' ELSE body END FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) AS last_message FROM conversations c JOIN sites s ON c.site_id=s.id LEFT JOIN visitor_devices d ON d.conversation_id=c.id LEFT JOIN website_users u ON u.conversation_id=c.id LEFT JOIN visitor_labels l ON l.conversation_id=c.id WHERE c.id=?`).get(id);
    const profile = c && db.prepare('SELECT info,attributes FROM client_profiles WHERE conversation_id=?').get(c.id);
    return c ? { ...c, client: profile ? { ...JSON.parse(profile.info), attributes: JSON.parse(profile.attributes) } : null, region: regionOf(c.ip), visitor_hash: undefined, online: (visitors.get(id)?.size || 0) > 0 } : null;
  };
  const updateConversation = id => io.to('admins').emit('conversation:update', conversation(id));
  const messages = (id, before) => {
    const limit = before && Number.isSafeInteger(Number(before)) ? Number(before) : Number.MAX_SAFE_INTEGER;
    return db.prepare('SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 100').all(id, limit).reverse();
  };
  function saveMessage(id, sender, data) {
    const kind = data?.kind || 'text', body = typeof data?.body === 'string' ? data.body.trim() : '';
    if (!uuid(data?.clientId) || !['text', 'image', 'sticker'].includes(kind) || (data?.body?.length || 0) > 4000 || (kind === 'text' && !body)) throw new Error('消息须为 1–4000 字符，或选择图片 / 表情');
    const existing = db.prepare('SELECT * FROM messages WHERE conversation_id=? AND sender=? AND client_id=?').get(id, sender, data.clientId);
    if (existing) return existing;
    if (kind === 'image' && (!uuid(data.mediaId) || !db.prepare("SELECT id FROM media WHERE id=? AND kind='chat' AND conversation_id=?").get(data.mediaId, id))) throw new Error('图片不存在或不属于此会话');
    if (kind === 'sticker' && !stickerIds.has(data.stickerId)) throw new Error('表情无效');
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = db.prepare('INSERT INTO messages(conversation_id,sender,body,client_id,created_at,kind,media_id,sticker_id) VALUES(?,?,?,?,?,?,?,?)').run(id, sender, body, data.clientId, now(), kind, kind === 'image' ? data.mediaId : null, kind === 'sticker' ? data.stickerId : null);
      db.prepare(`UPDATE conversations SET updated_at=?, status='open', unread=unread+? WHERE id=?`).run(now(), sender === 'visitor' ? 1 : 0, id);
      if (sender === 'auto') db.prepare('INSERT INTO auto_reply_state VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET last_sent=excluded.last_sent').run(id, now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const message = db.prepare('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
    io.to('admins').to(`conversation:${id}`).emit('message:new', message);
    updateConversation(id);
    if (sender === 'visitor') sendAutoReply(id);
    return message;
  }
  function sendAutoReply(id) {
    const c = db.prepare('SELECT site_id FROM conversations WHERE id=?').get(id);
    const config = replyConfig(c.site_id);
    if (!config.firstEnabled && !config.offlineEnabled) return;
    const first = config.firstEnabled && db.prepare("SELECT id FROM messages WHERE conversation_id=? AND sender='visitor' LIMIT 2").all(id).length === 1;
    const lastSent = db.prepare('SELECT last_sent FROM auto_reply_state WHERE conversation_id=?').get(id)?.last_sent || 0;
    let body;
    if (first && config.firstEnabled) body = config.firstMessage;
    else if (!agentsOnline() && config.offlineEnabled && now() - lastSent >= 300000) body = config.offlineMessage;
    if (!body) return;
    saveMessage(id, 'auto', { body, clientId: randomUUID() });
  }
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (req.path === '/widget') {
      const site = siteById(req.query.site);
      const origins = site ? JSON.parse(site.origins) : [];
      res.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; frame-ancestors 'self' ${origins.includes('*') ? 'http: https:' : origins.join(' ')}; base-uri 'none'; form-action 'self'`);
    } else if (!req.path.startsWith('/api/widget') && req.path !== '/widget.js') {
      res.set({ 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' blob: data:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    }
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', (_req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok' }); });
  const identitySecret = id => db.prepare('SELECT secret FROM site_identity WHERE site_id=?').get(id)?.secret || '';
  const anonymousVisitor = (siteId, raw) => validToken(raw) ? db.prepare('SELECT id,site_id FROM conversations WHERE site_id=? AND visitor_hash=? AND id NOT IN (SELECT conversation_id FROM website_users)').get(siteId, hash(raw)) : null;
  const resolveVisitor = (siteId, raw) => {
    if (!uuid(siteId)) return null;
    if (validToken(raw)) return anonymousVisitor(siteId, raw);
    try {
      const identity = verifyIdentity(raw, siteId, identitySecret(siteId));
      if (identity.client && db.prepare('SELECT 1 FROM client_revocations WHERE token_hash=?').get(hash(raw))) return null;
      return db.prepare('SELECT conversation_id AS id,site_id FROM website_users WHERE site_id=? AND user_id=?').get(siteId, identity.userId) || null;
    } catch { return null; }
  };
  const visitorFor = req => resolveVisitor(req.headers['x-kivo-site'], req.headers.authorization?.replace(/^Bearer /, ''));
  app.get('/api/media/:id', (req, res) => {
    const media = uuid(req.params.id) && db.prepare("SELECT * FROM media WHERE id=? AND kind='chat'").get(req.params.id);
    if (!media || (!sessionUser(req) && visitorFor(req)?.id !== media.conversation_id)) return res.status(404).json({ error: '图片不存在或无权访问' });
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline; filename="chat-image.webp"' });
    res.sendFile(path.resolve(dataDir, 'media', `${media.id}.webp`));
  });
  app.get('/avatars/:id', (req, res) => {
    const media = uuid(req.params.id) && db.prepare("SELECT id FROM media WHERE id=? AND kind='avatar'").get(req.params.id);
    if (!media) return res.sendStatus(404);
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' }); res.sendFile(path.resolve(dataDir, 'media', `${media.id}.webp`));
  });
  const imageLimiter = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '图片上传过于频繁，请稍后再试' } });
  const rawImageBody = express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: MAX_IMAGE_BYTES });
  const multipartImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 2, fieldNameSize: 32 } }).single('image');
  // Keep raw uploads for older components while using browser-native multipart
  // for new clients. Authentication and rate limits run before buffering files.
  const imageBody = (req, res, next) => {
    if (!req.is('multipart/form-data')) return rawImageBody(req, res, next);
    multipartImage(req, res, error => {
      if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '图片大小须小于 5 MB' : '每次只能上传一张图片，请重新选择' });
      req.body = req.file?.buffer;
      next();
    });
  };
  const upload = kind => async (req, res) => {
    try { const media = await storeImage(db, dataDir, req.body, { kind, conversationId: req.uploadConversation || null }); res.status(201).json({ ...media, ...(kind === 'avatar' ? { avatarUrl: `/avatars/${media.id}` } : {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  };
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: '登录尝试过多，请稍后重试' } });
  app.post('/api/login', sameOrigin, loginLimiter, async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(text(req.body?.username));
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '';
    // Compare a valid hash even for unknown users to avoid an obvious timing oracle.
    const valid = await bcrypt.compare(password, user?.password || '$2b$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!user || !valid) return res.status(401).json({ error: '账号或密码错误' });
    const raw = token();
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(raw), user.id, now() + SESSION_MAX_AGE);
    res.cookie('kivo_session', raw, { httpOnly: true, sameSite: 'lax', secure: publicOrigin.startsWith('https:'), path: '/', maxAge: SESSION_MAX_AGE });
    res.json({ username: user.username });
  });
  app.use('/api/admin', adminOnly);
  registerStatsRoutes(app, { db, visitors });
  app.use('/api/admin', (req, res, next) => ['GET', 'HEAD'].includes(req.method) ? next() : sameOrigin(req, res, next));
  registerAnalyticsRoutes(app, { db, ipOf, regionOf });
  app.post('/api/admin/avatar', imageLimiter, imageBody, upload('avatar'));
  app.post('/api/admin/conversations/:id/images', (req, res, next) => {
    if (!uuid(req.params.id) || !conversation(req.params.id)) return res.status(404).json({ error: '会话不存在' });
    req.uploadConversation = req.params.id; next();
  }, imageLimiter, imageBody, upload('chat'));
  app.get('/api/admin/me', (req, res) => {
    const raw = cookieToken(req);
    // Only already-valid sessions reach this handler. Upgrade existing logins too.
    db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(now() + SESSION_MAX_AGE, hash(raw));
    res.cookie('kivo_session', raw, { httpOnly: true, sameSite: 'lax', secure: publicOrigin.startsWith('https:'), path: '/', maxAge: SESSION_MAX_AGE });
    res.json({ username: req.user.username, publicUrl, presence: presence() });
  });
  app.get('/api/admin/presence', (req, res) => res.json(presence()));
  app.put('/api/admin/presence', (req, res) => {
    if (!['online', 'offline'].includes(req.body?.availability)) return res.status(400).json({ error: '请选择在线或离线' });
    db.prepare("INSERT INTO settings VALUES('supportAvailability',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(req.body.availability);
    availability = req.body.availability;
    publishAgents(); res.json(presence());
  });
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
  app.get('/api/admin/replies', (_req, res) => res.json(quickReplies()));
  app.put('/api/admin/replies', (req, res) => {
    const rows = req.body;
    if (!Array.isArray(rows) || rows.length > 20 || rows.some(r => typeof r?.label !== 'string' || !r.label.trim() || r.label.length > 40 || typeof r.body !== 'string' || !r.body.trim() || r.body.length > 2000)) return res.status(400).json({ error: '最多 20 条话术，名称 1–40 字符，内容 1–2000 字符' });
    const replies = rows.map(r => ({ label: r.label.trim(), body: r.body.trim() }));
    db.prepare("INSERT INTO settings VALUES('quickReplies',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(replies));
    io.to('admins').emit('replies:update', replies);
    res.json({ ok: true });
  });
  app.get('/api/admin/sites', (_req, res) => res.json(db.prepare('SELECT * FROM sites ORDER BY created_at').all().map(s => ({ ...s, origins: JSON.parse(s.origins), autoReply: replyConfig(s.id), ...siteProfile(s.id) }))));
  app.get('/api/admin/sites/:id/identity', (req, res) => {
    if (!siteById(req.params.id)) return res.status(404).json({ error: '网站不存在' });
    const secret = identitySecret(req.params.id);
    res.json({ siteId: req.params.id, enabled: !!secret, secret });
  });
  app.post('/api/admin/sites/:id/identity', (req, res) => {
    if (!siteById(req.params.id)) return res.status(404).json({ error: '网站不存在' });
    if (!['rotate','disable'].includes(req.body?.action)) return res.status(400).json({ error: '请选择生成密钥或关闭对接' });
    const secret = req.body.action === 'rotate' ? token() : '';
    db.prepare('INSERT INTO site_identity VALUES(?,?) ON CONFLICT(site_id) DO UPDATE SET secret=excluded.secret').run(req.params.id, secret);
    for (const socket of io.of('/').sockets.values()) if (socket.data.role === 'visitor' && socket.data.siteId === req.params.id && !validToken(socket.data.visitorToken)) socket.disconnect(true);
    res.json({ siteId: req.params.id, enabled: !!secret, secret });
  });
  function siteInput(body) {
    const name = text(body?.name, 60);
    const greeting = text(body?.greeting, 300) || '你好，欢迎联系我们！有什么可以帮你？';
    const color = /^#[0-9a-f]{6}$/i.test(body?.color || '') ? body.color : '#0f766e';
    const raw = body?.allowAll === true ? ['*'] : Array.isArray(body?.origins) ? body.origins : [];
    if (!name || !raw.length || raw.length > 20) throw new Error('请填写网站名称和 1–20 个允许的网址来源');
    const origins = raw.length === 1 && raw[0] === '*' ? ['*'] : [...new Set(raw.map(v => originOf(v)))];
    if (origins.includes('')) throw new Error('网址必须以 http:// 或 https:// 开头');
    const input = body?.autoReply || {};
    const autoReply = { firstEnabled: input.firstEnabled === true, firstMessage: text(input.firstMessage, 2000), offlineEnabled: input.offlineEnabled === true, offlineMessage: text(input.offlineMessage, 2000) };
    if ((autoReply.firstEnabled && !autoReply.firstMessage) || (autoReply.offlineEnabled && !autoReply.offlineMessage) || [input.firstMessage, input.offlineMessage].some(v => typeof v === 'string' && v.length > 2000)) throw new Error('启用的自动回复须填写 1–2000 字符的内容');
    const supportName = text(body?.supportName, 40) || '在线客服', avatarId = text(body?.avatarId, 36);
    if (avatarId && (!uuid(avatarId) || !db.prepare("SELECT id FROM media WHERE id=? AND kind='avatar'").get(avatarId))) throw new Error('请上传有效的客服头像');
    return { name, greeting, color, origins: JSON.stringify(origins), autoReply, supportName, avatarId };
  }
  function saveSite(id, s, create) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (create) db.prepare('INSERT INTO sites VALUES(?,?,?,?,?,?)').run(id, s.name, s.origins, s.color, s.greeting, now());
      else db.prepare('UPDATE sites SET name=?,origins=?,color=?,greeting=? WHERE id=?').run(s.name, s.origins, s.color, s.greeting, id);
      db.prepare('INSERT INTO site_replies VALUES(?,?) ON CONFLICT(site_id) DO UPDATE SET config=excluded.config').run(id, JSON.stringify(s.autoReply));
      db.prepare('INSERT INTO site_profiles VALUES(?,?,?) ON CONFLICT(site_id) DO UPDATE SET support_name=excluded.support_name,avatar_id=excluded.avatar_id').run(id, s.supportName, s.avatarId || null);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  app.post('/api/admin/sites', (req, res) => {
    try { const s = siteInput(req.body); const id = randomUUID(); saveSite(id, s, true); res.status(201).json({ id }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/sites/:id', (req, res) => {
    if (!siteById(req.params.id)) return res.status(404).json({ error: '网站不存在' });
    try { const s = siteInput(req.body), profile = siteProfile(req.params.id); if (req.body.autoReply === undefined) s.autoReply = replyConfig(req.params.id); if (req.body.supportName === undefined) s.supportName = profile.supportName; if (req.body.avatarId === undefined) s.avatarId = profile.avatarId; saveSite(req.params.id, s, false); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.get('/api/admin/unread', (req, res) => {
    res.json({ total: db.prepare('SELECT COALESCE(SUM(unread),0) AS total FROM conversations').get().total });
  });
  app.get('/api/admin/conversations', (req, res) => {
    const q = `%${text(req.query.q, 100)}%`;
    const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : '';
    const site = text(req.query.site);
    const rows = db.prepare(`SELECT id FROM conversations WHERE (name LIKE ? OR ip LIKE ? OR page LIKE ? OR id IN (SELECT conversation_id FROM website_users WHERE user_id LIKE ? OR account LIKE ? OR nickname LIKE ?)) AND (?='' OR status=?) AND (?='' OR site_id=?) ORDER BY updated_at DESC LIMIT 200`).all(q,q,q,q,q,q,status,status,site,site);
    res.json(rows.map(r => conversation(r.id)));
  });
  registerHistoryRoutes(app, { db, dataDir, io, conversation, updateConversation });
  app.get('/api/admin/conversations/:id', (req, res) => {
    const c = conversation(req.params.id);
    c ? res.json(c) : res.status(404).json({ error: '会话不存在' });
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
    if (origin && isKnownOrigin(origin)) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Kivo-Site', 'Vary': 'Origin' });
    if (req.method === 'OPTIONS') return res.sendStatus(origin && isKnownOrigin(origin) ? 204 : 403);
    next();
  });
  const visitorLimiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: '请求过于频繁，请稍后再试' } });
  app.post('/api/widget/images', (req, res, next) => {
    const c = visitorFor(req);
    if (!c || !siteAllows(siteById(c.site_id), req.headers.origin)) return res.status(403).json({ error: '访客凭证或来源无效' });
    req.uploadConversation = c.id; next();
  }, imageLimiter, imageBody, upload('chat'));
  app.post('/api/widget/session', visitorLimiter, (req, res) => {
    const site = siteById(req.body?.siteId);
    if (!siteAllows(site, req.headers.origin)) return res.status(403).json({ error: '网站未授权，请检查后台允许来源' });
    const page = safePage(req.body?.page);
    if (!page || originOf(page) !== req.headers.origin) return res.status(400).json({ error: '访问地址无效' });
    let identity = null;
    const visitorName = text(req.body?.visitorName,128).replace(/[\u0000-\u001f\u007f]/g,'').trim();
    if (req.body?.identityToken != null) {
      try { identity = verifyIdentity(req.body.identityToken, site.id, identitySecret(site.id)); if (identity.client) throw new Error('客户端凭证请使用 /api/client/v1/sessions'); }
      catch (e) { return res.status(403).json({ error: e.message }); }
    }
    const raw = identity ? req.body.identityToken : validToken(req.body?.visitorToken) && !db.prepare('SELECT conversation_id FROM website_users WHERE site_id=? AND conversation_id IN (SELECT id FROM conversations WHERE visitor_hash=?)').get(site.id,hash(req.body.visitorToken)) ? req.body.visitorToken : token();
    res.json(openSession({site, identity, raw, ip:ipOf(req), page, visitorName, ua:req.headers['user-agent']}));
  });
  function openSession({site, identity, raw, ip, page, visitorName, ua}) {
    let c = identity ? db.prepare('SELECT conversation_id AS id FROM website_users WHERE site_id=? AND user_id=?').get(site.id,identity.userId) : anonymousVisitor(site.id,raw);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!c) {
        c = { id: randomUUID() };
        db.prepare('INSERT INTO conversations(id,site_id,visitor_hash,name,ip,region,page,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,site.id,hash(identity ? 'website-user:' + identity.userId : raw),identity?.account || `访客 ${c.id.slice(0,6).toUpperCase()}`,ip,regionOf(ip),page,now(),now());
      } else db.prepare('UPDATE conversations SET ip=?,region=?,page=? WHERE id=?').run(ip,regionOf(ip),page,c.id);
      if (identity) {
        db.prepare('INSERT INTO website_users VALUES(?,?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET account=excluded.account,nickname=excluded.nickname').run(c.id,site.id,identity.userId,identity.account,identity.nickname);
        db.prepare('UPDATE conversations SET name=? WHERE id=?').run(identity.account,c.id);
      } else {
        db.prepare('INSERT INTO visitor_labels VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET name=excluded.name').run(c.id,visitorName);
        db.prepare('UPDATE conversations SET name=? WHERE id=?').run(visitorName || `访客 ${c.id.slice(0,6).toUpperCase()}`,c.id);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const device = deviceInfo(ua);
    db.prepare('INSERT INTO visitor_devices VALUES(?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET os=excluded.os,browser=excluded.browser,ua=excluded.ua').run(c.id, device.os, device.browser, device.ua);
    updateConversation(c.id);
    return { visitorToken: raw, conversationId: c.id, identity: identity ? {userId:identity.userId,account:identity.account,nickname:identity.nickname,verified:true} : null, site: { id: site.id, name: site.name, color: site.color, greeting: site.greeting, ...siteProfile(site.id) } };
  }
  const clientApi = registerClientRoutes(app, { db, io, dataDir, publicOrigin, siteById, siteAllows, identitySecret, resolveVisitor, openSession, siteProfile, agentsOnline, saveMessage, imageLimiter, imageBody, upload, ipOf, regionOf, visitors, updateConversation, publishPresence, isKnownOrigin });
  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    if (auth.role === 'admin') {
      if (socketOrigin(socket.request) !== publicOrigin) return next(new Error('来源无效'));
      const user = sessionUser(socket.request);
      if (!user) return next(new Error('登录已过期'));
      socket.data.role = 'admin'; socket.data.userId = user.id; socket.data.sessionHash = hash(cookieToken(socket.request));
    } else {
      if (!uuid(auth.siteId)) return next(new Error('访客凭证无效'));
      const native = !socket.request.headers.origin && !socket.request.headers.referer;
      if (native) { try { clientApi.validIdentity(auth.visitorToken, auth.siteId); } catch { return next(new Error('客户端凭证无效')); } }
      else if (!siteAllows(siteById(auth.siteId), socketOrigin(socket.request))) return next(new Error('来源无效'));
      const c = resolveVisitor(auth.siteId,auth.visitorToken);
      if (!c) return next(new Error('访客凭证无效'));
      socket.data.role = 'visitor'; socket.data.conversationId = c.id; socket.data.siteId = auth.siteId; socket.data.visitorToken = auth.visitorToken;
    }
    next();
  });
  io.on('connection', socket => {
    let identityExpiry;
    const refreshExpiry = () => {
      clearTimeout(identityExpiry);
      if (socket.data.role !== 'visitor' || validToken(socket.data.visitorToken)) return;
      let identity;
      try { identity = verifyIdentity(socket.data.visitorToken, socket.data.siteId, identitySecret(socket.data.siteId)); }
      catch { socket.disconnect(true); return; }
      identityExpiry = setTimeout(() => socket.disconnect(true), Math.max(0, identity.exp * 1000 - Date.now()));
      identityExpiry.unref();
    };
    refreshExpiry();
    if (!socket.connected) return;
    if (socket.data.role === 'admin') {
      socket.join('admins'); admins.add(socket.id); publishAgents();
    } else {
      const id = socket.data.conversationId;
      const ip = ipOf(socket.request);
      db.prepare('UPDATE conversations SET ip=?,region=? WHERE id=?').run(ip,regionOf(ip),id);
      socket.join(`conversation:${id}`);
      if (!visitors.has(id)) visitors.set(id, new Set());
      visitors.get(id).add(socket.id); clientApi.releaseLease(socket.data.visitorToken, id); updateConversation(id);
      publishPresence();
      socket.emit('history', messages(id)); socket.emit('agents:status', { online: agentsOnline() });
    }
    let windowStart = now(), count = 0;
    socket.on('message:send', (data, ack = () => {}) => {
      if (typeof ack !== 'function') return;
      try {
        if (now() - windowStart > 10000) { count = 0; windowStart = now(); }
        if (++count > 20) throw new Error('发送过于频繁，请稍后再试');
        if (socket.data.role === 'admin' && !sessionUser(socket.request)) { socket.disconnect(true); throw new Error('登录已过期'); }
        if (socket.data.role === 'visitor' && !resolveVisitor(socket.data.siteId,socket.data.visitorToken)) { socket.disconnect(true); throw new Error('网站用户身份已过期，请刷新页面'); }
        const id = socket.data.role === 'admin' ? data?.conversationId : socket.data.conversationId;
        if (!uuid(id) || !conversation(id)) throw new Error('会话不存在');
        ack({ ok: true, message: saveMessage(id, socket.data.role === 'admin' ? 'agent' : 'visitor', data) });
      } catch (e) { ack({ ok: false, error: e.message }); }
    });
    socket.on('visitor:identity', (data, ack = () => {}) => {
      if (typeof ack !== 'function' || socket.data.role !== 'visitor') return;
      const c = resolveVisitor(socket.data.siteId,data?.visitorToken);
      if (!c || c.id !== socket.data.conversationId) return ack({ ok: false });
      socket.data.visitorToken = data.visitorToken;
      refreshExpiry();
      ack({ ok: true });
    });
    socket.on('visitor:page', data => {
      if (socket.data.role !== 'visitor' || !resolveVisitor(socket.data.siteId,socket.data.visitorToken)) return;
      const c = conversation(socket.data.conversationId);
      const site = siteById(c.site_id);
      const page = safePage(data?.page);
      if (!page || !siteAllows(site,originOf(page))) return;
      db.prepare('UPDATE conversations SET page=? WHERE id=?').run(page,c.id); updateConversation(c.id);
    });
    socket.on('disconnect', () => {
      clearTimeout(identityExpiry);
      if (socket.data.role === 'admin') { admins.delete(socket.id); publishAgents(); }
      else { const id = socket.data.conversationId; visitors.get(id)?.delete(socket.id); if (!visitors.get(id)?.size) visitors.delete(id); updateConversation(id); publishPresence(); }
    });
  });
  const cleanup = setInterval(() => {
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.role === 'admin' && !sessionUser(socket.request)) socket.disconnect(true);
      if (socket.data.role === 'visitor' && !resolveVisitor(socket.data.siteId,socket.data.visitorToken)) socket.disconnect(true);
    }
  }, 60000);
  cleanup.unref();
  app.get('/widget', (_req,res) => res.sendFile(path.join(publicDir,'widget.html')));
  app.get('/demo', (_req,res) => res.sendFile(path.join(publicDir,'demo.html')));
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  app.use('/api', (_req,res) => res.status(404).json({ error: '接口不存在' }));
  app.use((err, _req, res, _next) => { console.error(err.message); res.status(err.status || 500).json({ error: err.status === 413 ? '请求内容过大' : '请求失败，请稍后再试' }); });
  return { app, server, db, io, close: async () => { clearInterval(cleanup); clientApi.close(); await new Promise(resolve => io.close(resolve)); db.close(); } };
}
