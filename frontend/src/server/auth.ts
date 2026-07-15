// Single-user auth. A password (APP_PASSWORD) is exchanged for a signed,
// httpOnly session cookie; every data route verifies the signature + expiry.
// No DB, no user table — there is exactly one user. node:crypto is available on
// both the Vercel Node runtime and the Vite dev server.
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import type { ApiRequest, SetCookie } from './http.js';

const COOKIE_NAME = 'ft_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// Signing key: SESSION_SECRET if set, else derived deterministically from
// APP_PASSWORD so the documented env surface stays DATABASE_URL + APP_PASSWORD.
// Deriving via a labeled hash means the raw password is never itself the HMAC key.
function signingKey(): Buffer {
  const explicit = process.env.SESSION_SECRET;
  if (explicit && explicit.length > 0) return Buffer.from(explicit, 'utf8');
  const pw = process.env.APP_PASSWORD;
  if (!pw) throw new Error('APP_PASSWORD (or SESSION_SECRET) must be set');
  return createHash('sha256').update(`ft-session-key:${pw}`).digest();
}

function sign(payload: string): string {
  return b64url(createHmac('sha256', signingKey()).update(payload).digest());
}

// True only in real deployments; over plain-http localhost a Secure cookie would
// never be stored, so dev must not set it.
function isSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function createSessionCookie(nowSeconds: number): SetCookie {
  const exp = nowSeconds + SESSION_TTL_SECONDS;
  const payload = `${nowSeconds}.${exp}`;
  const token = `${payload}.${sign(payload)}`;
  return {
    name: COOKIE_NAME,
    value: token,
    maxAge: SESSION_TTL_SECONDS,
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'Lax',
    path: '/',
  };
}

export function clearSessionCookie(): SetCookie {
  return {
    name: COOKIE_NAME,
    value: '',
    maxAge: 0,
    httpOnly: true,
    secure: isSecure(),
    sameSite: 'Lax',
    path: '/',
  };
}

// Verify a token: correct HMAC (timing-safe) and not expired.
export function verifyToken(token: string | undefined, nowSeconds: number): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [iat, exp, mac] = parts;
  const expected = sign(`${iat}.${exp}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum <= nowSeconds) return false;
  return true;
}

export function isAuthenticated(ctx: ApiRequest, nowSeconds: number): boolean {
  return verifyToken(ctx.cookies[COOKIE_NAME], nowSeconds);
}

// Constant-time password check against APP_PASSWORD. Hashing both sides first
// makes the compare fixed-length so it leaks neither length nor content timing.
export function checkPassword(input: unknown): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected) throw new Error('APP_PASSWORD must be set');
  if (typeof input !== 'string') return false;
  const a = createHash('sha256').update(input).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export { COOKIE_NAME, SESSION_TTL_SECONDS };
