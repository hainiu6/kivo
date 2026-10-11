// Run inside the released image to exercise its actual HTTP upload stack.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createHmac } from 'node:crypto';

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
  const { data: identity } = await json(`/api/admin/sites/${site.id}/identity`, {action:'rotate'}, login.cookie);
  const payload=Buffer.from(JSON.stringify({siteId:site.id,userId:'docker-user',account:'docker@example.com',nickname:'容器测试用户',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+900})).toString('base64url');
  const identityToken=payload+'.'+createHmac('sha256',identity.secret).update(payload).digest('base64url');
  const { data: account } = await json('/api/widget/session',{siteId:site.id,page:'https://shop.example/user',identityToken},'','https://shop.example');
  assert.equal(account.identity.userId,'docker-user');
  const { data: visitor } = await json('/api/widget/session', { siteId: site.id, page: 'https://shop.example/upload', visitorName:'PHP Session 用户' }, '', 'https://shop.example');
  await upload('/api/widget/images', { Authorization: 'Bearer ' + visitor.visitorToken, 'X-Kivo-Site': site.id });
  await upload(`/api/admin/conversations/${visitor.conversationId}/images`, { Cookie: login.cookie });
  await upload('/api/admin/avatar', {}, 401);
}
const db = new DatabaseSync('/app/data/kivo.sqlite', { readOnly: true });
const account=db.prepare('SELECT u.*,i.secret FROM website_users u JOIN site_identity i ON u.site_id=i.site_id WHERE u.user_id=?').get('docker-user');
assert.equal(db.prepare('SELECT name FROM visitor_labels WHERE name=?').get('PHP Session 用户').name,'PHP Session 用户','session display names survive upgrade');
assert.equal(account.account,'docker@example.com');assert.match(account.secret,/^[a-f0-9]{64}$/);
const issued=Math.floor(Date.now()/1000),payload=Buffer.from(JSON.stringify({siteId:account.site_id,userId:account.user_id,account:account.account,nickname:account.nickname,iat:issued,exp:issued+900})).toString('base64url');
const identityToken=payload+'.'+createHmac('sha256',account.secret).update(payload).digest('base64url');
const {data: resumed}=await json('/api/widget/session',{siteId:account.site_id,page:'https://shop.example/user',identityToken},'','https://shop.example');
assert.equal(resumed.conversationId,account.conversation_id,'website account and signing key survive upgrade');
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
console.log('Container multipart upload, account identity, authentication and persisted media passed.');
