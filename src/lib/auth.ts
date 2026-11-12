import type { FastifyReply, FastifyRequest } from 'fastify';
import { looksLikeApiKey } from './keys.js';
import { forbidden, unauthorized } from './errors.js';
import { authenticateApiKey, type AuthContext } from '../services/projects.js';
import { parseCookies, safeEqual, SESSION_COOKIE, UI_HEADER, UI_HEADER_VALUE, verifySessionToken } from './admin-auth.js';

export interface AdminContext {
  /** Admin UI user, or "token" for ADMIN_TOKEN automation. */
  username: string;
  via: 'token' | 'session';
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    admin?: AdminContext;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

/** preValidation hook (runs before schema validation, so unauthenticated callers never see schema details): resolves `Authorization: Bearer es_live_...` to a project. */
export async function requireApiKey(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  if (!token || !looksLikeApiKey(token)) throw unauthorized();
  const auth = await authenticateApiKey(req.server.db, token);
  if (!auth) throw unauthorized();
  req.auth = auth;
  req.log = req.log.child({ project: auth.project.slug });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * preValidation hook for management routes. Accepts either the static
 * ADMIN_TOKEN as a bearer token (scripts, automation) or the admin UI's signed
 * session cookie. Cookie-authenticated writes must carry the UI's custom header:
 * browsers never attach custom headers cross-origin without CORS consent, so a
 * foreign page cannot forge a state change with the user's cookie.
 */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  if (token) {
    if (!safeEqual(token, req.server.cfg.ADMIN_TOKEN)) throw unauthorized('Missing or invalid admin token');
    req.admin = { username: 'token', via: 'token' };
    return;
  }
  const session = verifySessionToken(req.server.sessionSecret, parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) throw unauthorized('Missing or invalid admin token');
  if (!SAFE_METHODS.has(req.method) && req.headers[UI_HEADER] !== UI_HEADER_VALUE) {
    throw forbidden('csrf_header_missing', `Cookie-authenticated writes require the ${UI_HEADER}: ${UI_HEADER_VALUE} header`);
  }
  req.admin = { username: session.username, via: 'session' };
  req.log = req.log.child({ admin: session.username });
}
