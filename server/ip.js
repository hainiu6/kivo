import { isIP } from 'node:net';

const normalize = value => typeof value === 'string' && isIP(value.replace(/^::ffff:/, '')) ? value.replace(/^::ffff:/, '') : '';

export function visitorIP(req, trustProxy) {
  // The trusted proxy must overwrite X-Real-IP or append its observed peer to
  // X-Forwarded-For. Only the nearest hop is trusted, never a client-supplied prefix.
  if (trustProxy === 1) {
    const forwarded = normalize(req.headers['x-forwarded-for']?.split(',').at(-1)?.trim());
    if (forwarded) return forwarded;
    const real = normalize(req.headers['x-real-ip']);
    if (real) return real;
  }
  return normalize(req.socket.remoteAddress);
}
