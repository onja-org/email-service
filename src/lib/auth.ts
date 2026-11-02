import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { looksLikeApiKey } from './keys.js';
import { unauthorized } from './errors.js';
import { authenticateApiKey, type AuthContext } from '../services/projects.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const [scheme, token] = h.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

/** preHandler: resolves `Authorization: Bearer es_live_...` to a project. */
export async function requireApiKey(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  if (!token || !looksLikeApiKey(token)) throw unauthorized();
  const auth = await authenticateApiKey(req.server.db, token);
  if (!auth) throw unauthorized();
  req.auth = auth;
  req.log = req.log.child({ project: auth.project.slug });
}

/** preHandler: checks the static ADMIN_TOKEN for management routes. */
export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearer(req);
  const expected = req.server.cfg.ADMIN_TOKEN;
  if (!token || !safeEqual(token, expected)) throw unauthorized('Missing or invalid admin token');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
