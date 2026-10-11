import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKivo } from '../server/app.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

test('admin cookie and server session keep login for 30 days, renew valid older sessions and reject expiration/logout',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'kivo-session-')),origin='https://chat.example';
  const service=createKivo({dataDir:dir,publicUrl:origin,adminPassword:'session-test-password'});
  t.after(async()=>{await service.close();rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${service.server.address().port}`;
  let clock=Date.now();t.mock.method(Date,'now',()=>clock);
  const login=()=>fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'session-test-password'})});
  const response=await login(),header=response.headers.get('set-cookie'),cookie=header.split(';')[0],hash=createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  assert.match(header,/Max-Age=2592000/);assert.match(header,/HttpOnly/);assert.match(header,/Secure/);assert.match(header,/SameSite=Lax/);
  assert.equal(service.db.prepare('SELECT expires FROM sessions WHERE token=?').get(hash).expires,clock+30*86400000);
  clock+=8*86400000;
  const restored=await fetch(base+'/api/admin/me',{headers:{Cookie:cookie}});assert.equal(restored.status,200);assert.match(restored.headers.get('set-cookie'),/Max-Age=2592000/);
  service.db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(clock+1000,hash);
  assert.equal((await fetch(base+'/api/admin/me',{headers:{Cookie:cookie}})).status,200);
  assert.equal(service.db.prepare('SELECT expires FROM sessions WHERE token=?').get(hash).expires,clock+30*86400000,'upgrade renews a still-valid older login');
  clock+=31*86400000;const expired=await fetch(base+'/api/admin/me',{headers:{Cookie:cookie}});assert.equal(expired.status,401);assert.equal(expired.headers.get('set-cookie'),null);
  const fresh=await login(),freshCookie=fresh.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base+'/api/admin/logout',{method:'POST',headers:{Origin:origin,Cookie:freshCookie}})).status,200);
  assert.equal((await fetch(base+'/api/admin/me',{headers:{Cookie:freshCookie}})).status,401);
});
