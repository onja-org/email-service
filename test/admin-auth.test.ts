import { describe, expect, it } from 'vitest';
import { createSessionToken, parseCookies, sessionCookie, verifySessionToken } from '../src/lib/admin-auth.js';

describe('sessions', () => {
  const secret = 'test-secret';
  it('round-trips a signed token and rejects tampering and expiry', () => {
    const token = createSessionToken(secret, 'alice');
    expect(verifySessionToken(secret, token)?.username).toBe('alice');
    expect(verifySessionToken('other-secret', token)).toBeNull();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'mallory', exp: 4102444800 })).toString('base64url');
    expect(verifySessionToken(secret, `${forged}.${sig}`)).toBeNull();
    expect(verifySessionToken(secret, `${payload}.`)).toBeNull();
    expect(verifySessionToken(secret, undefined)).toBeNull();
    expect(verifySessionToken(secret, token, Date.now() + 13 * 3600_000)).toBeNull();
  });

  it('builds and parses the cookie', () => {
    const set = sessionCookie('abc.def', true);
    expect(set).toContain('emailsvc_admin=abc.def');
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');
    expect(set).toContain('Secure');
    expect(sessionCookie(null, false)).toContain('Max-Age=0');
    expect(parseCookies('a=1; emailsvc_admin=abc.def; b=%20x')).toEqual({ a: '1', emailsvc_admin: 'abc.def', b: ' x' });
  });
});
