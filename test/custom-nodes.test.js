import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createKivo } from '../server/app.js';

async function harness(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'kivo-custom-nodes-')), origin = 'http://localhost:31995', password = 'custom-node-test-password';
  let service, base;
  async function start() { service = createKivo({ dataDir, publicUrl: origin, adminPassword: password }); await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + service.server.address().port; }
  await start(); t.after(async () => { await service.close(); rmSync(dataDir, { recursive: true, force: true }); });
  async function request(route, { method = 'GET', body, cookie, from = origin } = {}) {
    const res = await fetch(base + route, { method, headers: { Origin: from, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { res, data: await res.json() };
  }
  const login = async () => (await request('/api/login', { method: 'POST', body: { username: 'admin', password } })).res.headers.get('set-cookie').split(';')[0];
  return { request, login, get db() { return service.db; }, restart: async () => { await service.close(); await start(); } };
}
const values = () => ({ account: 'demo@example.com', nodeNumber: 'VIP-001', startsAt: Date.parse('2026-10-26T09:00:00+08:00'), endsAt: Date.parse('2026-11-26T09:00:00+08:00'), note: '专用节点\n到期联系', node: '  示例节点\n' + '长文本内容'.repeat(9000) + '\n  ' });

test('custom nodes require admin access, validate all fields, preserve long text and reject concurrent overwrites across restart', async t => {
  const h = await harness(t); let cookie = await h.login(); const root = '/api/admin/custom-nodes', input = values();
  assert.equal((await h.request(root)).res.status, 401);
  assert.equal((await h.request(root, { method: 'POST', body: input })).res.status, 401);
  assert.equal((await h.request(root, { method: 'POST', cookie, from: 'https://foreign.example', body: input })).res.status, 403);
  assert.deepEqual((await h.request(root, { cookie })).data.items, []);
  for (const change of [{ account: '' }, { account: [] }, { account: 'x\ny' }, { account: 'x'.repeat(201) }, { nodeNumber: '' }, { nodeNumber: 'x'.repeat(101) }, { note: 'x'.repeat(2001) }, { node: '' }, { node: 'x'.repeat(65537) }, { node: 'nul\u0000' }, { startsAt: '2026-10-26' }, { startsAt: -1 }, { endsAt: input.startsAt }, { endsAt: Number.MAX_SAFE_INTEGER }]) {
    assert.equal((await h.request(root, { method: 'POST', cookie, body: { ...input, ...change } })).res.status, 400);
  }
  const result = await h.request(root, { method: 'POST', cookie, body: input }); assert.equal(result.res.status, 201); const record = result.data;
  assert.equal(record.node, input.node); assert.equal(record.startsAt, input.startsAt); assert.equal(record.endsAt, input.endsAt);
  const list = (await h.request(root, { cookie })).data; assert.equal(list.total, 1); assert.equal(list.items[0].nodePreview.length, 160); assert.equal(list.items[0].node, undefined, 'lists do not send every full node payload');
  assert.equal((await h.request(root + '/' + record.id)).res.status, 401);
  assert.equal((await h.request(root + '/missing', { cookie })).res.status, 404);
  const changed = { ...record, account: 'updated@example.com', node: '修改后的完整节点\n第二行', note: '<img src=x onerror=alert(1)>', nodeNumber: 'VIP-002' };
  assert.equal((await h.request(root + '/' + record.id, { method: 'PUT', cookie, from: 'https://foreign.example', body: changed })).res.status, 403);
  assert.equal((await h.request(root + '/' + record.id, { method: 'PUT', cookie, body: { ...changed, updatedAt: undefined } })).res.status, 400);
  const updated = await h.request(root + '/' + record.id, { method: 'PUT', cookie, body: changed }); assert.equal(updated.res.status, 200); assert.ok(updated.data.updatedAt > record.updatedAt);
  assert.equal((await h.request(root + '/' + record.id, { method: 'PUT', cookie, body: changed })).res.status, 409);
  await h.restart(); cookie = await h.login();
  const persisted = (await h.request(root + '/' + record.id, { cookie })).data;
  assert.equal(persisted.node, changed.node); assert.equal(persisted.account, changed.account); assert.equal(persisted.note, changed.note); assert.equal(persisted.createdAt, record.createdAt);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0, 'node records stay independent from chat');
});

test('custom node search and pagination cover every record and escape user input through bound SQL parameters', async t => {
  const h = await harness(t), cookie = await h.login(), root = '/api/admin/custom-nodes';
  const insert = h.db.prepare('INSERT INTO custom_nodes VALUES(?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 123; i++) insert.run(randomUUID(), i === 0 ? "literal_%' account" : 'demo-' + i, 'NODE-' + i, 1, 2, '', 'node text', i + 1, i + 1);
  const list = async query => (await h.request(root + query, { cookie })).data;
  const first = await list(''); assert.equal(first.total, 123); assert.equal(first.pages, 3); assert.equal(first.items.length, 50); assert.equal(first.items[0].account, 'demo-122');
  const last = await list('?page=3'); assert.equal(last.items.length, 23); assert.equal(last.items.at(-1).nodeNumber, 'NODE-0');
  assert.equal((await list('?page=100')).page, 3);
  assert.equal((await list('?q=' + encodeURIComponent("_%'"))).total, 1);
  assert.equal((await list('?q=NoDe-122')).items[0].account, 'demo-122');
  assert.equal((await list('?q=nobody')).total, 0); assert.equal((await list('?q=nobody')).pages, 1);
  for (const query of ['?page=0', '?page=-1', '?page=1.5', '?q=x&q=y', '?q=' + 'x'.repeat(101)]) assert.equal((await h.request(root + query, { cookie })).res.status, 400);
});

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function ui() {
  const nodes = new Map(), requests = [], messages = [];
  const node = () => ({ value: '', textContent: '', hidden: false, disabled: false, children: [], open: false, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, reset() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, addEventListener(name, fn) { this[name] = fn; } });
  const get = selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); };
  get('#custom-node-form').elements = Object.fromEntries(['account', 'nodeNumber', 'startsAt', 'endsAt', 'note', 'node'].map(name => [name, node()]));
  const context = { window: {}, document: { querySelector: get, createElement: node }, Date, Number, Object, URLSearchParams };
  vm.runInNewContext(readFileSync(new URL('../public/admin-custom-nodes.js', import.meta.url), 'utf8'), context);
  const module = context.window.KivoCustomNodes.create({ api: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })), onChange() {}, onMessage: m => messages.push(m) });
  const submit = () => get('#custom-node-form').onsubmit({ preventDefault() {} });
  return { get, requests, messages, module, submit, fields: get('#custom-node-form').elements };
}
const pageOf = items => ({ items, total: items.length, page: 1, pages: 1 });
const example = () => ({ ...values(), id: 'node-id', node: '节点\n第二行', createdAt: 1, updatedAt: 1, nodePreview: '节点\n第二行' });

test('node editor creates and edits complete records with explicit Beijing times and safely rendered text', async () => {
  const h = ui(); h.module.activate(); h.requests[0].resolve(pageOf([])); await flush();
  h.get('#custom-node-add').onclick(); assert.equal(h.get('#custom-node-dialog').open, true);
  Object.assign(h.fields.account, { value: 'new account' }); h.fields.nodeNumber.value = 'N-1'; h.fields.startsAt.value = '2026-10-26T09:00'; h.fields.endsAt.value = '2026-11-26T09:00'; h.fields.note.value = '备注'; h.fields.node.value = '第一行\n第二行';
  const saving = h.submit(); const request = h.requests[1]; assert.equal(request.options.method, 'POST'); assert.equal(JSON.parse(request.options.body).startsAt, Date.parse('2026-10-26T01:00:00Z')); assert.equal(JSON.parse(request.options.body).node, '第一行\n第二行');
  h.submit(); assert.equal(h.requests.length, 2, 'double submits do not create duplicate records');
  request.resolve(example()); await flush(); h.requests[2].resolve(pageOf([example()])); await saving;
  assert.equal(h.get('#custom-node-dialog').open, false); const row = h.get('#custom-node-rows').children[0]; row.children[6].children[0].onclick(); h.requests[3].resolve(example()); await flush();
  assert.equal(h.fields.node.value, '节点\n第二行'); assert.equal(h.fields.startsAt.value, '2026-10-26T09:00');
  h.fields.note.value = '<script>demo</script>'; const editing = h.submit(); assert.equal(h.requests[4].options.method, 'PUT'); assert.equal(JSON.parse(h.requests[4].options.body).updatedAt, 1);
  h.requests[4].resolve(example()); await flush(); h.requests[5].resolve(pageOf([{ ...example(), note: '<script>demo</script>' }])); await editing;
  assert.equal(h.get('#custom-node-rows').children[0].children[4].textContent, '<script>demo</script>'); assert.equal(h.get('#custom-node-rows').children[0].children[4].children.length, 0);
});

test('node editor rejects reversed dates, preserves drafts on conflicts, and explicitly reloads the latest record', async () => {
  const h = ui(); h.module.activate(); h.requests[0].resolve(pageOf([example()])); await flush(); h.get('#custom-node-rows').children[0].children[6].children[0].onclick(); h.requests[1].resolve(example()); await flush();
  h.fields.endsAt.value = h.fields.startsAt.value; await h.submit(); assert.equal(h.requests.length, 2); assert.match(h.get('#custom-node-form-error').textContent, /晚于/);
  h.fields.endsAt.value = '2026-12-26T09:00'; h.fields.node.value = '未保存草稿'; const save = h.submit(); const error = new Error('其他客服已修改'); error.status = 409; h.requests[2].reject(error); await save;
  assert.equal(h.fields.node.value, '未保存草稿'); assert.equal(h.get('#custom-node-save').disabled, true); assert.equal(h.get('#custom-node-reload').hidden, false);
  h.get('#custom-node-reload').onclick(); h.requests[3].resolve({ ...example(), node: '最新内容', updatedAt: 2 }); await flush(); assert.equal(h.fields.node.value, '最新内容'); assert.equal(h.get('#custom-node-save').disabled, false);
});

test('node search and editor ignore stale responses after navigation, logout or a newer edit selection', async () => {
  const h = ui(); h.module.setFilters({ nodeQuery: 'N-1' }); h.module.activate(); assert.match(h.requests[0].url, /q=N-1/);
  h.get('#custom-node-search').value = 'new'; h.get('#custom-node-search-form').onsubmit({ preventDefault() {} }); h.requests[1].resolve(pageOf([example()])); await flush(); h.requests[0].resolve(pageOf([])); await flush(); assert.equal(h.get('#custom-node-rows').children.length, 1);
  h.get('#custom-node-rows').children[0].children[6].children[0].onclick(); h.get('#custom-node-add').onclick(); h.requests[2].resolve(example()); await flush(); assert.equal(h.fields.account.value, '', 'late detail cannot replace an add dialog');
  h.get('#custom-node-refresh').onclick(); h.module.reset(); h.requests[3].resolve(pageOf([example()])); await flush(); assert.equal(h.get('#custom-node-rows').children.length, 0); assert.equal(h.get('#custom-node-dialog').open, false);
});
