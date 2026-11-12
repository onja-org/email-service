import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { HttpError, unauthorized } from '../lib/errors.js';
import { createSessionToken, safeEqual, sessionCookie } from '../lib/admin-auth.js';
import { requireAdmin } from '../lib/auth.js';

const LOCKOUT_AFTER = 5;
const LOCKOUT_MS = 60_000;

/**
 * Login/logout for the admin web UI. The credential is ADMIN_TOKEN itself; a
 * successful login swaps it for the signed session cookie that `requireAdmin`
 * accepts, so the token never has to live in the browser.
 */
export const adminAuthRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const secure = app.cfg.NODE_ENV === 'production';
  /** Failed attempts per client IP: a small brake on online guessing. */
  const failures = new Map<string, { count: number; until: number }>();

  app.post('/login', { schema: { body: z.object({ token: z.string().min(1).max(1024) }) } }, async (req, reply) => {
    const f = failures.get(req.ip);
    if (f && f.count >= LOCKOUT_AFTER && f.until > Date.now()) {
      throw new HttpError(429, 'too_many_attempts', 'Too many failed logins; try again in a minute');
    }

    if (!safeEqual(req.body.token, app.cfg.ADMIN_TOKEN)) {
      const next = { count: (f?.count ?? 0) + 1, until: Date.now() + LOCKOUT_MS };
      failures.set(req.ip, next);
      req.log.warn({ failures: next.count }, 'admin login failed');
      throw unauthorized('Wrong admin token');
    }

    failures.delete(req.ip);
    req.log.info('admin login');
    return reply
      .header('set-cookie', sessionCookie(createSessionToken(app.sessionSecret, 'admin'), secure))
      .send({ username: 'admin' });
  });

  app.post('/logout', async (_req, reply) => reply.header('set-cookie', sessionCookie(null, secure)).status(204).send());

  app.get('/me', { preValidation: requireAdmin }, async (req) => ({
    username: req.admin?.username ?? null,
    via: req.admin?.via ?? 'token',
  }));
};
