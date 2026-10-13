import { createHmac, timingSafeEqual } from 'node:crypto';

// Two base64url segments: JSON payload and HMAC-SHA256 of the first segment.
// The 64-character site secret is used verbatim, not decoded from hex.
export function verifyIdentity(token, siteId, secret, seconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== 'string' || token.length > 8192) throw new Error('用户身份无效，请检查后端对接密钥');
  const segments = token.split('.');
  if (segments.length !== 2 || !segments.every(s => /^[A-Za-z0-9_-]+$/.test(s))) throw new Error('网站用户身份格式无效');
  const expected = createHmac('sha256', secret).update(segments[0]).digest();
  const supplied = Buffer.from(segments[1], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('网站用户身份签名无效，请检查 PHP 对接密钥');
  let value;
  try { value = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8')); } catch { throw new Error('网站用户身份格式无效'); }
  if (!value || value.siteId !== siteId || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || value.iat > seconds + 30 || value.iat < seconds - 900 || value.exp <= seconds || value.exp <= value.iat || value.exp > value.iat + 900) throw new Error('网站用户身份已过期或不属于此网站，请刷新页面');
  for (const [key, limit, required] of [['userId',128,true],['account',128,true],['nickname',80,false]]) {
    if (typeof value[key] !== 'string' || value[key].length > limit || (required && !value[key].trim()) || /[\u0000-\u001f\u007f]/.test(value[key])) throw new Error('网站用户信息无效');
  }
  return { userId: value.userId.trim(), account: value.account.trim(), nickname: value.nickname.trim(), exp: value.exp, client: value.aud === 'kivo-client', attributes: userAttributes(value.attributes) };
}

export function userAttributes(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5) throw new Error('自定义资料最多 5 项');
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => !key.trim() || key.length > 32 || typeof item !== 'string' || item.length > 128 || /[\u0000-\u001f\u007f]/.test(key + item))) throw new Error('自定义资料名称最多 32 字符，内容最多 128 字符，不含控制字符');
  return Object.fromEntries(entries.map(([key, item]) => [key.trim(), item.trim()]));
}

export function signClientIdentity(siteId, secret, user, ttl = 900, nonce) {
  const issued = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ siteId, userId: user?.userId, account: user?.account, nickname: user?.nickname ?? '', attributes: userAttributes(user?.attributes), aud: 'kivo-client', nonce, iat: issued, exp: issued + ttl })).toString('base64url');
  const token = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  const identity = verifyIdentity(token, siteId, secret, issued);
  return { token, expiresAt: identity.exp };
}
