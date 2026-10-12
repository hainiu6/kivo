import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { createRegionLookup } from '../server/region.js';
import { createKivo } from '../server/app.js';

test('bundled country data corrects reallocated Brazilian ranges without inventing cities and keeps private/invalid IPs unknown', () => {
  const manifest = JSON.parse(readFileSync(new URL('../server/geo/manifest.json', import.meta.url)));
  assert.equal(createHash('sha256').update(readFileSync(new URL('../server/geo/dbip-country-lite.mmdb.gz', import.meta.url))).digest('hex'), manifest.sha256);
  const region = createRegionLookup();
  for (const ip of ['179.255.146.39', '179.255.158.39', '::ffff:179.255.146.39']) assert.equal(region(ip), '美国');
  assert.match(region('61.230.133.125'), /^台湾/);
  assert.doesNotMatch(region('2001:4860:4860::8888'), /未知/);
  for (const ip of ['172.17.0.1','10.0.0.1','127.0.0.1','::1','fc00::1','203.0.113.1','bad','8.8.8.8, 1.1.1.1',null]) assert.equal(region(ip), '未知 / 内网');
});

test('local City MMDB uses location country rather than registered country; gzip works and corrupt overrides fall back', t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kivo-region-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = readFileSync(new URL('./fixtures/geoip/GeoIP2-City-Test.mmdb', import.meta.url));
  const file = path.join(dir, 'geoip.mmdb'); writeFileSync(file, fixture);
  assert.equal(createRegionLookup({ dataDir: dir })('81.2.69.160'), '英国 · England · London');
  assert.equal(createRegionLookup({ dataDir: dir })('179.255.146.39'), '美国', 'incomplete custom data falls back to current bundled country data');
  rmSync(file); writeFileSync(file + '.gz', gzipSync(fixture));
  assert.equal(createRegionLookup({ dataDir: dir })('81.2.69.160'), '英国 · England · London');
  writeFileSync(file + '.gz', 'invalid database');
  assert.equal(createRegionLookup({ dataDir: dir })('179.255.146.39'), '美国');
});

test('chat and analytics refresh historical region labels without altering PV, UV, messages or stored history', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kivo-region-history-')), origin = 'https://support.example';
  let service, base;
  const start = async () => { service = createKivo({ dataDir: dir, publicUrl: origin, adminPassword: 'region-test-password', trustProxy: 1 }); await new Promise(r => service.server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + service.server.address().port; };
  await start(); t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body, cookie = '') => { const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Real-IP': '179.255.146.39' }, body: body ? JSON.stringify(body) : undefined }); assert.ok(res.ok, route); return res; };
  const login = async () => (await request('/api/login', { username: 'admin', password: 'region-test-password' })).headers.get('set-cookie').split(';')[0];
  let cookie = await login();
  const site = await (await request('/api/admin/sites', { name: '客服测试', origins: ['*'] }, cookie)).json();
  const visitor = await (await request('/api/widget/session', { siteId: site.id, page: origin + '/demo' })).json();
  assert.equal(service.db.prepare('SELECT region FROM conversations WHERE id=?').get(visitor.conversationId).region, '美国');
  const tracking = await (await request('/api/admin/analytics/sites', { name: '统计测试' }, cookie)).json();
  await request('/api/analytics/collect', { siteId: tracking.id, eventId: randomUUID(), visitorId: randomUUID(), page: origin + '/page' });
  assert.equal(service.db.prepare('SELECT region FROM page_views').get().region, '美国');
  service.db.prepare('UPDATE conversations SET region=?').run('巴西 · MS · Corumbá');
  service.db.prepare('UPDATE page_views SET region=?').run('巴西 · MS · Corumbá');
  const verify = async () => {
    const conversations = await (await request('/api/admin/conversations', undefined, cookie)).json();
    assert.equal(conversations[0].region, '美国');
    const detail = await (await request('/api/admin/conversations/' + visitor.conversationId, undefined, cookie)).json(); assert.equal(detail.region, '美国');
    const stats = await (await request('/api/admin/analytics/stats', undefined, cookie)).json();
    assert.equal(stats.visitors.items[0].region, '美国'); assert.equal(stats.summary.pv, 1); assert.equal(stats.summary.uv, 1);
    assert.equal(service.db.prepare('SELECT region FROM page_views').get().region, '巴西 · MS · Corumbá', 'display corrections do not rewrite raw visit history');
    assert.equal(service.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  };
  await verify(); await service.close(); await start(); cookie = await login(); await verify();
});
