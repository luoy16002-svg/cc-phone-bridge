// Pairing: a six-digit code shown on the PC (or on a phone that is already paired) buys a device a long token.
import crypto from 'node:crypto';

const CODE_MS = 10 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;

export const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export class Pairing {
  constructor() {
    this.code = null;
    this.expires = 0;
    this.fails = new Map();
    this.codeFails = 0;
  }

  current() {
    if (!this.code || Date.now() > this.expires) this.rotate();
    return { code: this.code, expires: this.expires };
  }

  rotate() {
    this.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    this.expires = Date.now() + CODE_MS;
    this.codeFails = 0;
    return this.current();
  }

  attempt(ip, code) {
    const now = Date.now();
    const recent = (this.fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= 6) return { ok: false, error: 'too_many' };
    const given = Buffer.from(String(code || '').replace(/\D/g, '').padEnd(6, 'x').slice(0, 6));
    const want = Buffer.from(this.code && now <= this.expires ? this.code : 'expired');
    const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
    if (!ok) {
      recent.push(now);
      this.fails.set(ip, recent);
      // a code that keeps being guessed at is thrown away
      if (++this.codeFails >= 12) this.code = null;
      return { ok: false, error: this.code ? 'bad_code' : 'expired' };
    }
    this.code = null;
    this.fails.delete(ip);
    return { ok: true };
  }
}

export function newDevice(name, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  const device = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || '手机').slice(0, 40),
    hash: hashToken(token),
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    lastIp: ip,
  };
  return { token, device };
}

export function findDevice(devices, token) {
  if (!token) return null;
  const h = Buffer.from(hashToken(token), 'hex');
  for (const d of devices) {
    const dh = Buffer.from(d.hash, 'hex');
    if (dh.length === h.length && crypto.timingSafeEqual(dh, h)) return d;
  }
  return null;
}
