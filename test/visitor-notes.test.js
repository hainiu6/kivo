import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { io } from 'socket.io-client';
import { createKivo } from '../server/app.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function editor(api) {
  const node = () => ({ value: '', textContent: '', disabled: false, hidden: false, addEventListener(name, fn) { this[name] = fn; } });
  const controls = { form: node(), input: node(), saveButton: node(), status: node(), count: node(), reloadButton: node() };
  const context = { window: {}, Map, JSON, Number }; vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../public/admin-notes.js', import.meta.url), 'utf8'), context);
  const notes = context.window.KivoVisitorNotes.create({ api, ...controls });
  return { ...controls, notes, type(value) { controls.input.value = value; controls.input.input(); }, save() { return controls.form.submit({ preventDefault() {} }); } };
}

test('private notes persist, synchronize only to admins, reject stale writes and survive history clearing', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kivo-notes-')), origin = 'http://localhost:31997', external = 'https://shop.example', password = 'visitor-note-password';
  let service, base; const sockets = [];
  async function start() { service = createKivo({ dataDir: dir, publicUrl: origin, adminPassword: password }); await new Promise(r => service.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${service.server.address().port}`; }
  await start(); t.after(async () => { sockets.forEach(s => s.disconnect()); await service.close(); rmSync(dir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, cookie, from = origin } = {}) {
    const res = await fetch(base + route, { method, headers: { Origin: from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { res, data: await res.json() };
  }
  const login = async () => (await request('/api/login', { method: 'POST', body: { username: 'admin', password } })).res.headers.get('set-cookie').split(';')[0];
  let cookie = await login();
  const site = (await request('/api/admin/sites', { method: 'POST', cookie, body: { name: '备注测试', allowAll: true } })).data.id;
  const visitor = (await request('/api/widget/session', { method: 'POST', from: external, body: { siteId: site, page: external } })).data;
  const id = visitor.conversationId, route = `/api/admin/conversations/${id}/note`;
  const event = (s, name) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Timeout ${name}`)), 3000); s.once(name, data => { clearTimeout(timer); resolve(data); }); });
  async function connect(auth, cookie, from) {
    const s = io(base, { auth, autoConnect: false, reconnection: false, transports: ['websocket'], extraHeaders: { Origin: from, ...(cookie ? { Cookie: cookie } : {}) } }); sockets.push(s);
    const ready = event(s, auth.role === 'admin' ? 'presence:update' : 'agents:status'); s.connect(); await ready; return s;
  }
  const agent = await connect({ role: 'admin' }, cookie, origin), viewer = await connect({ role: 'visitor', siteId: site, visitorToken: visitor.visitorToken }, undefined, external);
  const visitorEvents = []; viewer.onAny((name, data) => visitorEvents.push({ name, data }));
  assert.equal((await request(route)).res.status, 401);
  assert.equal((await request(route, { method: 'PUT', cookie, from: external, body: { note: 'secret', updatedAt: 0 } })).res.status, 403);
  assert.equal((await request('/api/admin/conversations/missing/note', { cookie })).res.status, 404);
  for (const body of [{ note: 5, updatedAt: 0 }, { note: 'x'.repeat(2001), updatedAt: 0 }, { note: 'test' }, { note: 'test', updatedAt: -1 }]) assert.equal((await request(route, { method: 'PUT', cookie, body })).res.status, 400);
  assert.deepEqual((await request(route, { cookie })).data, { note: '', updatedAt: 0 });
  const before = (await request(`/api/admin/conversations/${id}`, { cookie })).data;
  const update = event(agent, 'conversation:note');
  const saved = (await request(route, { method: 'PUT', cookie, body: { note: '  私人备注\r\n明天跟进  ', updatedAt: 0 } })).data;
  assert.equal(saved.note, '私人备注\n明天跟进'); assert.ok(saved.updatedAt > 0);
  assert.deepEqual(await update, { conversationId: id, ...saved });
  const stale = await request(route, { method: 'PUT', cookie, body: { note: 'stale', updatedAt: 0 } });
  assert.equal(stale.res.status, 409); assert.equal(stale.data.note, saved.note);
  const after = (await request(`/api/admin/conversations/${id}`, { cookie })).data;
  assert.equal(after.updated_at, before.updated_at); assert.equal(after.unread, before.unread); assert.equal(after.status, before.status);
  assert.ok(!JSON.stringify(after).includes('私人备注'));
  const reopened = (await request('/api/widget/session', { method: 'POST', from: external, body: { siteId: site, page: external, visitorToken: visitor.visitorToken } })).data;
  assert.ok(!JSON.stringify(reopened).includes('私人备注'));
  const barrier = event(viewer, 'agents:status'); await request('/api/admin/presence', { method: 'PUT', cookie, body: { availability: 'offline' } }); await barrier;
  assert.ok(!visitorEvents.some(e => e.name === 'conversation:note' || JSON.stringify(e.data).includes('私人备注')));
  await request(`/api/admin/conversations/${id}/messages`, { method: 'DELETE', cookie });
  assert.deepEqual((await request(route, { cookie })).data, saved, 'clearing messages keeps notes');
  sockets.forEach(s => s.disconnect()); await service.close(); await start(); cookie = await login();
  assert.deepEqual((await request(route, { cookie })).data, saved, 'notes survive server restart');
  const empty = (await request(route, { method: 'PUT', cookie, body: { note: '', updatedAt: saved.updatedAt } })).data;
  assert.equal(empty.note, ''); assert.ok(empty.updatedAt > saved.updatedAt);
  await request(`/api/admin/conversations/${id}`, { method: 'DELETE', cookie });
  assert.equal((await request(route, { cookie })).res.status, 404);
  const db = new DatabaseSync(path.join(dir, 'kivo.sqlite'), { readOnly: true }); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visitor_notes').get().n, 0); db.close();
});

test('note drafts stay with their visitor and delayed loads cannot overwrite another visitor', async () => {
  const pending = new Map();
  const h = editor(url => new Promise(resolve => pending.set(url, resolve)));
  h.notes.select('a'); h.notes.select('b');
  pending.get('/api/admin/conversations/a/note')({ note: 'A', updatedAt: 1 }); await flush(); assert.equal(h.input.value, '');
  pending.get('/api/admin/conversations/b/note')({ note: 'B', updatedAt: 2 }); await flush();
  h.type('B draft'); h.notes.select('a'); assert.equal(h.input.value, 'A');
  h.notes.select('b'); assert.equal(h.input.value, 'B draft');
  pending.get('/api/admin/conversations/b/note')({ note: 'B', updatedAt: 2 }); await flush();
  assert.equal(h.input.value, 'B draft'); assert.equal(h.saveButton.disabled, false);
  h.notes.select('b'); assert.equal(h.input.value, 'B draft');
  h.notes.reset(); assert.equal(h.input.value, ''); assert.equal(h.input.disabled, true);
  pending.get('/api/admin/conversations/a/note')({ note: 'late private data', updatedAt: 99 }); await flush(); assert.equal(h.input.value, '');
});

test('note saves preserve edits typed in flight and remote changes require explicit reload', async () => {
  let stored = { note: '', updatedAt: 0 }, complete;
  const h = editor(async (_url, options) => {
    if (options?.method === 'PUT') return new Promise(resolve => { complete = resolve; });
    return stored;
  });
  h.notes.select('a'); await flush(); h.type('saved'); const saving = h.save();
  h.type('new typing'); stored = { note: 'saved', updatedAt: 1 };
  h.notes.receive({ conversationId: 'a', ...stored }); complete(stored); await saving;
  assert.equal(h.input.value, 'new typing'); assert.equal(h.saveButton.disabled, false);
  stored = { note: 'another agent', updatedAt: 2 }; h.notes.receive({ conversationId: 'a', ...stored });
  assert.equal(h.input.value, 'new typing'); assert.equal(h.saveButton.disabled, true); assert.equal(h.reloadButton.hidden, false);
  h.reloadButton.click(); await flush(); assert.equal(h.input.value, 'another agent');
  h.notes.receive({ conversationId: 'a', note: 'old', updatedAt: 1 }); assert.equal(h.input.value, 'another agent');
  h.type(''); const clearing = h.save(); stored = { note: '', updatedAt: 3 }; complete(stored); await clearing;
  assert.equal(h.input.value, ''); assert.match(h.status.textContent, /已保存/);
});

test('failed and conflicting note saves keep drafts; deletion and logout invalidate pending responses', async () => {
  let mode = 'normal', complete;
  const h = editor(async (_url, options) => {
    if (options?.method === 'PUT') {
      const error = new Error(mode === 'conflict' ? 'conflict' : 'network error'); error.status = mode === 'conflict' ? 409 : 503; throw error;
    }
    if (mode === 'pending') return new Promise(resolve => { complete = resolve; });
    return { note: mode === 'conflict' ? 'remote' : '', updatedAt: mode === 'conflict' ? 1 : 0 };
  });
  h.notes.select('a'); await flush(); h.type('draft'); mode = 'failed'; await h.save();
  assert.equal(h.input.value, 'draft'); assert.match(h.status.textContent, /network error/);
  mode = 'conflict'; await h.save(); assert.equal(h.input.value, 'draft'); assert.equal(h.saveButton.disabled, true);
  h.reloadButton.click(); await flush(); assert.equal(h.input.value, 'remote');
  mode = 'pending'; h.notes.select('b'); h.notes.remove('b'); complete({ note: 'deleted note', updatedAt: 2 }); await flush(); assert.equal(h.input.value, '');
  h.notes.select('c'); h.notes.reset(); complete({ note: 'logged-out note', updatedAt: 3 }); await flush(); assert.equal(h.input.value, ''); assert.equal(h.saveButton.disabled, true);
});
