import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';

test('all-websites access, saved replies, automatic replies and restart persistence', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kivo-replies-'));
  const origin = 'http://localhost:31998', external = 'https://any-shop.example', password = 'replies-test-password';
  let service, base;
  const sockets = [];
  async function start() {
    service = createKivo({ dataDir: dir, publicUrl: origin, adminPassword: password });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${service.server.address().port}`;
  }
  await start();
  t.after(async () => { sockets.forEach(s => s.disconnect()); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, cookie, from = origin } = {}) {
    const res = await fetch(base + route, { method, headers: { Origin: from, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { res, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  }
  const login = async () => (await request('/api/login', { method: 'POST', body: { username: 'admin', password } })).res.headers.get('set-cookie').split(';')[0];
  const ready = (s, event) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Timeout ${event}`)), 3000); s.once(event, data => { clearTimeout(timer); resolve(data); }); });
  async function connect(auth, from = origin, cookie, expectError = false) {
    const s = io(base, { auth, autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { Origin: from, ...(cookie ? { Cookie: cookie } : {}) } }); sockets.push(s);
    const event = ready(s, expectError ? 'connect_error' : 'connect'); s.connect(); await event; return s;
  }
  const send = (s, data) => new Promise((resolve, reject) => s.timeout(3000).emit('message:send', { clientId: crypto.randomUUID(), ...data }, (e, ack) => e ? reject(e) : resolve(ack)));
  let cookie = await login();
  // Simulate an existing v1 installation: migration must preserve sites and chat tables.
  const old = (await request('/api/admin/sites', { method: 'POST', cookie, body: { name: '原有网站', origins: ['https://allowed.example'] } })).data.id;
  service.db.exec('DROP TABLE auto_reply_state; DROP TABLE site_replies; DROP TABLE settings; PRAGMA user_version=1;');
  await service.close(); await start(); cookie = await login();
  assert.equal((await request('/api/admin/sites', { cookie })).data[0].id, old);
  assert.equal((await request('/api/admin/sites', { cookie })).data[0].autoReply.firstEnabled, false);
  assert.equal(service.db.prepare('PRAGMA user_version').get().user_version, 4);
  const phrases = [{ label: '配送时间', body: '一般在两天内发出。\n节假日顺延。' }];
  assert.equal((await request('/api/admin/replies')).res.status, 401);
  assert.equal((await request('/api/admin/replies', { method: 'PUT', cookie, body: phrases, from: external })).res.status, 403);
  assert.equal((await request('/api/admin/replies', { method: 'PUT', cookie, body: [{ label: '', body: 'x' }] })).res.status, 400);
  assert.equal((await request('/api/admin/replies', { method: 'PUT', cookie, body: Array(21).fill(phrases[0]) })).res.status, 400);
  assert.equal((await request('/api/admin/replies', { method: 'PUT', cookie, body: [{ label: 'x', body: 'x'.repeat(2001) }] })).res.status, 400);
  const admin = await connect({ role: 'admin' }, origin, cookie);
  const broadcast = ready(admin, 'replies:update');
  assert.equal((await request('/api/admin/replies', { method: 'PUT', cookie, body: phrases })).res.status, 200);
  assert.deepEqual(await broadcast, phrases);
  assert.deepEqual((await request('/api/admin/replies', { cookie })).data, phrases);
  const config = { firstEnabled: true, firstMessage: '你好，已收到你的问题。', offlineEnabled: true, offlineMessage: '客服离线，请留言。' };
  const siteBody = { name: '所有网站', allowAll: true, autoReply: config };
  const site = (await request('/api/admin/sites', { method: 'POST', cookie, body: siteBody })).data.id;
  assert.deepEqual((await request('/api/admin/sites', { cookie })).data.find(s => s.id === site).origins, ['*']);
  assert.equal((await request('/api/admin/sites', { method: 'POST', cookie, body: { name: 'bad', origins: ['*', external] } })).res.status, 400);
  assert.equal((await request(`/api/admin/sites/${site}`, { method: 'PUT', cookie, body: { ...siteBody, autoReply: { firstEnabled: true, firstMessage: '' } } })).res.status, 400);
  const csp = (await request(`/widget?site=${site}`)).res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' http: https:/);
  assert.doesNotMatch((await request(`/widget?site=${old}`)).res.headers.get('content-security-policy'), /http: https:/);
  for (const from of ['http://another-shop.example:8080', external]) {
    const preflight = await request('/api/widget/session', { method: 'OPTIONS', from });
    assert.equal(preflight.res.status, 204); assert.equal(preflight.res.headers.get('access-control-allow-origin'), from);
  }
  assert.equal((await request('/api/widget/session', { method: 'OPTIONS', from: 'null' })).res.status, 403);
  assert.equal((await request('/api/widget/session', { method: 'POST', from: external, body: { siteId: old, page: external } })).res.status, 403);
  assert.equal((await request('/api/login', { method: 'POST', from: external, body: { username: 'admin', password } })).res.status, 403);
  await connect({ role: 'admin' }, external, cookie, true);
  const restrictedSession = (await request('/api/widget/session', { method: 'POST', from: 'https://allowed.example', body: { siteId: old, page: 'https://allowed.example' } })).data;
  await connect({ role: 'visitor', siteId: old, visitorToken: restrictedSession.visitorToken }, external, undefined, true);
  const session = (await request('/api/widget/session', { method: 'POST', from: external, body: { siteId: site, page: external + '/product' } })).data;
  let visitor = await connect({ role: 'visitor', siteId: site, visitorToken: session.visitorToken }, external);
  const id = session.conversationId;
  const history = async () => (await request(`/api/admin/conversations/${id}/messages`, { cookie })).data;
  const firstClientId = crypto.randomUUID();
  assert.equal((await send(visitor, { body: '问题一', clientId: firstClientId })).ok, true);
  let rows = await history(); assert.deepEqual(rows.map(r => r.sender), ['visitor', 'auto']); assert.equal(rows[1].body, config.firstMessage);
  await send(visitor, { body: '问题一', clientId: firstClientId }); assert.equal((await history()).length, 2, 'retry must not repeat either message');
  await send(visitor, { body: '问题二' }); assert.equal((await history()).length, 3, 'no offline reply while an agent is connected');
  const disconnected = ready(admin, 'disconnect'); await request('/api/admin/logout', { method: 'POST', cookie }); await disconnected; cookie = await login();
  await send(visitor, { body: '问题三' }); assert.equal((await history()).length, 4, 'first reply also starts the cooldown');
  service.db.prepare('UPDATE auto_reply_state SET last_sent=? WHERE conversation_id=?').run(Date.now() - 300001, id);
  await send(visitor, { body: '问题四' }); rows = await history(); assert.equal(rows.at(-1).body, config.offlineMessage); assert.equal(rows.at(-1).sender, 'auto');
  await send(visitor, { body: '问题五' }); assert.equal((await history()).filter(r => r.sender === 'auto').length, 2);
  assert.equal((await request('/api/admin/conversations', { cookie })).data.find(c => c.id === id).unread, 5, 'automatic replies do not add unread messages');
  // Restart with live config and cooldown; reconnect alone must not send anything.
  const count = (await history()).length;
  sockets.forEach(s => s.disconnect()); await service.close(); await start(); cookie = await login();
  assert.deepEqual((await request('/api/admin/replies', { cookie })).data, phrases);
  assert.deepEqual((await request('/api/admin/sites', { cookie })).data.find(s => s.id === site).autoReply, config);
  visitor = await connect({ role: 'visitor', siteId: site, visitorToken: session.visitorToken }, external);
  assert.equal((await history()).length, count);
  await send(visitor, { body: '重启后留言' }); assert.equal((await history()).length, count + 1, 'restart must not reset cooldown or first-message state');
  // Disable first-message reply: an offline-only site replies to its first message.
  await request(`/api/admin/sites/${site}`, { method: 'PUT', cookie, body: { ...siteBody, autoReply: { ...config, firstEnabled: false } } });
  const fresh = (await request('/api/widget/session', { method: 'POST', from: external, body: { siteId: site, page: external } })).data;
  const freshVisitor = await connect({ role: 'visitor', siteId: site, visitorToken: fresh.visitorToken }, external);
  await send(freshVisitor, { body: '首次离线留言' });
  assert.equal((await request(`/api/admin/conversations/${fresh.conversationId}/messages`, { cookie })).data.at(-1).body, config.offlineMessage);
  await request('/api/admin/replies', { method: 'PUT', cookie, body: [] }); assert.deepEqual((await request('/api/admin/replies', { cookie })).data, []);
});
