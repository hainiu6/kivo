// Run inside the released image to exercise its actual HTTP upload stack.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const base = 'http://127.0.0.1:3000';
const origin = process.env.PUBLIC_URL;
const json = async (route, body, cookie = '', requestOrigin = origin) => {
  const response = await fetch(base + route, {
    method: 'POST', headers: { Origin: requestOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
};
const login = await json('/api/login', { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD });
if (process.argv[2] !== 'verify') {
  const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#0f766e' } }).png().toBuffer();
  const upload = async (route, headers, expected = 201) => {
    const body = new FormData();
    body.append('image', new Blob([png], { type: 'image/png' }), '中文截图📸.png');
    const response = await fetch(base + route, { method: 'POST', headers: { Origin: origin, ...headers }, body });
    assert.equal(response.status, expected, route);
    return response.json();
  };
  const avatar = await upload('/api/admin/avatar', { Cookie: login.cookie });
  const { data: site } = await json('/api/admin/sites', { name: 'Docker 上传测试', origins: ['*'], avatarId: avatar.id }, login.cookie);
  const { data: visitor } = await json('/api/widget/session', { siteId: site.id, page: 'https://shop.example/upload' }, '', 'https://shop.example');
  await upload('/api/widget/images', { Authorization: 'Bearer ' + visitor.visitorToken, 'X-Kivo-Site': site.id });
  await upload(`/api/admin/conversations/${visitor.conversationId}/images`, { Cookie: login.cookie });
  await upload('/api/admin/avatar', {}, 401);
}
const db = new DatabaseSync('/app/data/kivo.sqlite', { readOnly: true });
const media = db.prepare('SELECT id, kind, bytes FROM media').all();
assert.equal(media.length, 3, 'avatar and both chat uploads survive upgrade');
for (const item of media) {
  const response = await fetch(base + (item.kind === 'avatar' ? '/avatars/' : '/api/media/') + item.id, { headers: { Cookie: login.cookie } });
  assert.equal(response.status, 200);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(downloaded.length, item.bytes);
  assert.deepEqual(downloaded, await readFile('/app/data/media/' + item.id + '.webp'));
}
db.close();
console.log('Container multipart upload, authentication and persisted media passed.');
