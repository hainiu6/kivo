// Run inside the released image to exercise its actual HTTP upload stack.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createHmac, randomUUID } from 'node:crypto';
import { createRegionLookup } from '/app/server/region.js';

const region = createRegionLookup({ dataDir: '/app/data' });
for (const ip of ['179.255.146.39', '179.255.158.39']) assert.equal(region(ip), '美国', 'released image includes current country data');
assert.equal(region('172.17.0.1'), '未知 / 内网');

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
  await json('/api/admin/custom-nodes', { account:'docker-node-account',nodeNumber:'DEPLOY-001',startsAt:Date.now(),endsAt:Date.now()+86400000,note:'备份与升级保留测试',node:'docker节点\n'.repeat(6000) }, login.cookie);
  const { data: tracking } = await json('/api/admin/analytics/sites', { name: 'Docker 访问统计测试' }, login.cookie);
  const browserId = randomUUID();
  for (const page of ['https://any-domain.example/', 'https://another-domain.example/products']) {
    const collected = await fetch(base + '/api/analytics/collect', { method: 'POST', headers: { Origin: new URL(page).origin, 'Content-Type': 'text/plain' }, body: JSON.stringify({ siteId: tracking.id, eventId: randomUUID(), visitorId: browserId, page, title: '容器统计页面' }) });
    assert.equal(collected.status, 204);
  }
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
  const nativeResponse = await fetch(base + '/api/client/v1/tokens', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+identity.secret}, body:JSON.stringify({siteId:site.id,user:{userId:'docker-native',account:'native@example.com',nickname:'容器客户端',attributes:{等级:'VIP'}}}) });
  assert.equal(nativeResponse.status,201); const nativeProof=await nativeResponse.json();
  const nativeSession=await fetch(base+'/api/client/v1/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({siteId:site.id,identityToken:nativeProof.token,client:{platform:'Android',version:'1.0'},screen:'账户'})});
  assert.equal(nativeSession.status,200);
  const nativeHeaders={'Content-Type':'application/json',Authorization:'Bearer '+nativeProof.token,'X-Kivo-Site':site.id};
  assert.equal((await fetch(base+'/api/client/v1/messages',{method:'POST',headers:nativeHeaders,body:JSON.stringify({body:'客户端升级保留测试',clientId:randomUUID()})})).status,200);
  const receiptDb=new DatabaseSync('/app/data/kivo.sqlite');
  const nativeId=receiptDb.prepare("SELECT conversation_id FROM website_users WHERE user_id='docker-native'").get().conversation_id;
  const outgoing=receiptDb.prepare("INSERT INTO messages(conversation_id,sender,body,client_id,created_at) VALUES(?,'agent','Read receipt probe',?,?)").run(nativeId,randomUUID(),Date.now()).lastInsertRowid;
  receiptDb.close();
  const noteResponse = await fetch(base+`/api/admin/conversations/${nativeId}/note`, { method:'PUT', headers:{Origin:origin,Cookie:login.cookie,'Content-Type':'application/json'}, body:JSON.stringify({note:'Docker 访客备注',updatedAt:0}) });
  assert.equal(noteResponse.status,200);
  assert.equal((await noteResponse.json()).note,'Docker 访客备注');
  assert.equal((await fetch(base+'/api/client/v1/read',{method:'POST',headers:nativeHeaders,body:JSON.stringify({lastId:Number(outgoing)})})).status,200);
  const revoked=await(await fetch(base+'/api/client/v1/tokens',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+identity.secret},body:JSON.stringify({siteId:site.id,user:{userId:'docker-native',account:'native@example.com'}})})).json();
  assert.equal((await fetch(base+'/api/client/v1/session',{method:'DELETE',headers:{Authorization:'Bearer '+revoked.token,'X-Kivo-Site':site.id}})).status,200);
  const payload=Buffer.from(JSON.stringify({siteId:site.id,userId:'docker-user',account:'docker@example.com',nickname:'容器测试用户',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+900})).toString('base64url');
  const identityToken=payload+'.'+createHmac('sha256',identity.secret).update(payload).digest('base64url');
  const { data: account } = await json('/api/widget/session',{siteId:site.id,page:'https://shop.example/user',identityToken},'','https://shop.example');
  assert.equal(account.identity.userId,'docker-user');
  const { data: visitor } = await json('/api/widget/session', { siteId: site.id, page: 'https://shop.example/upload', visitorName:'PHP Session 用户' }, '', 'https://shop.example');
  await upload('/api/widget/images', { Authorization: 'Bearer ' + visitor.visitorToken, 'X-Kivo-Site': site.id });
  await upload(`/api/admin/conversations/${visitor.conversationId}/images`, { Cookie: login.cookie });
  await upload('/api/admin/avatar', {}, 401);
  const {data: disposable}=await json('/api/widget/session',{siteId:site.id,page:'https://shop.example/cleanup'},'','https://shop.example');
  const removable=await upload(`/api/admin/conversations/${disposable.conversationId}/images`,{Cookie:login.cookie});
  const remove=route=>fetch(base+route,{method:'DELETE',headers:{Origin:origin,Cookie:login.cookie}});
  assert.equal((await remove(`/api/admin/conversations/${disposable.conversationId}/messages`)).status,200);
  assert.equal((await fetch(base+'/api/media/'+removable.id,{headers:{Cookie:login.cookie}})).status,404);
  await assert.rejects(readFile('/app/data/media/'+removable.id+'.webp'),{code:'ENOENT'});
  assert.equal((await remove(`/api/admin/conversations/${disposable.conversationId}`)).status,200);
  assert.equal((await fetch(base+`/api/admin/conversations/${disposable.conversationId}/messages`,{headers:{Cookie:login.cookie}})).status,404);
}
const db = new DatabaseSync('/app/data/kivo.sqlite', { readOnly: true });
const customNode=db.prepare('SELECT * FROM custom_nodes WHERE account=?').get('docker-node-account');
assert.equal(customNode.note,'备份与升级保留测试');assert.equal(customNode.node_text,'docker节点\n'.repeat(6000),'long custom node content survives upgrade');
const customResponse=await fetch(base+'/api/admin/custom-nodes/'+customNode.id,{headers:{Cookie:login.cookie}});
assert.equal(customResponse.status,200);assert.equal((await customResponse.json()).node,customNode.node_text);
const native=db.prepare('SELECT * FROM website_users WHERE user_id=?').get('docker-native');
assert.equal(JSON.parse(db.prepare('SELECT info FROM client_profiles WHERE conversation_id=?').get(native.conversation_id).info).platform,'Android','client profiles survive upgrade');
assert.equal(JSON.parse(db.prepare('SELECT attributes FROM client_profiles WHERE conversation_id=?').get(native.conversation_id).attributes).等级,'VIP');
assert.equal(db.prepare("SELECT body FROM messages WHERE conversation_id=? AND sender='visitor'").get(native.conversation_id).body,'客户端升级保留测试');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_revocations').get().n,1,'revocations survive upgrade');
assert.ok(db.prepare("SELECT read_at FROM messages WHERE conversation_id=? AND sender='agent'").get(native.conversation_id).read_at,'read receipts survive upgrade');
assert.equal(db.prepare('SELECT note FROM visitor_notes WHERE conversation_id=?').get(native.conversation_id).note,'Docker 访客备注','notes survive upgrade and rollback');
const persistedNote=await fetch(base+`/api/admin/conversations/${native.conversation_id}/note`,{headers:{Cookie:login.cookie}});
assert.equal(persistedNote.status,200);assert.equal((await persistedNote.json()).note,'Docker 访客备注');
assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);
const tracking = db.prepare('SELECT id FROM analytics_sites WHERE name=?').get('Docker 访问统计测试');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM page_views WHERE site_id=?').get(tracking.id).n, 2, 'analytics sites and visits survive upgrade');
const trafficResponse = await fetch(base + '/api/admin/analytics/stats?site=' + tracking.id, { headers: { Cookie: login.cookie } });
assert.equal(trafficResponse.status, 200);
const traffic = await trafficResponse.json();
assert.equal(traffic.summary.pv, 2); assert.equal(traffic.summary.uv, 1); assert.equal(traffic.domains.length, 2);
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
console.log('Container custom nodes, private notes, analytics persistence, uploads, history deletion, account identity, authentication and persisted media passed.');
