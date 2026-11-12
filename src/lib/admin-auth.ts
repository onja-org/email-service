/**
 * Signed-cookie sessions for the admin web UI. Logging in means presenting
 * ADMIN_TOKEN once; afterwards the browser holds a session cookie instead of
 * the token. Sessions are stateless: base64url(JSON{u, exp}) + "." + HMAC-SHA256,
 * so any replica can verify them and nothing is stored server-side.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'emailsvc_admin';
export const SESSION_TTL_SECONDS = 12 * 3600;
/** Header the UI sends on every request; browsers only add custom headers same-origin, which blocks CSRF. */
export const UI_HEADER = 'x-requested-with';
export const UI_HEADER_VALUE = 'emailsvc-ui';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ---- sessions ---------------------------------------------------------------

export interface Session {
  username: string;
  expiresAt: number;
}

export function createSessionToken(secret: string, username: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySessionToken(secret: string, token: string | undefined, now = Date.now()): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, sign(secret, payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u?: unknown; exp?: unknown };
    if (typeof parsed.u !== 'string' || typeof parsed.exp !== 'number') return null;
    if (parsed.exp * 1000 <= now) return null;
    return { username: parsed.u, expiresAt: parsed.exp * 1000 };
  } catch {
    return null;
  }
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookie(token: string | null, secure: boolean): string {
  const base = `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${SESSION_TTL_SECONDS}` : `${base}; Max-Age=0`;
}
