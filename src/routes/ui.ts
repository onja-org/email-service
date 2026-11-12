import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/routes (tsx) and dist/routes (compiled).
const publicDir = path.resolve(here, '..', '..', 'public');

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/**
 * Serves the admin web UI: login page, management SPA and the performance
 * dashboard. All three are static HTML; every byte of data they show comes from
 * the /admin/* API, which requires the session cookie set by /admin/auth/login.
 */
export const uiRoutes: FastifyPluginAsync = async (app) => {
  const cache = new Map<string, string>();
  async function page(name: string): Promise<string> {
    if (app.cfg.NODE_ENV !== 'development' && cache.has(name)) return cache.get(name)!;
    const html = await readFile(path.join(publicDir, name), 'utf8');
    cache.set(name, html);
    return html;
  }
  const serve = (name: string) => async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .send(await page(name));

  app.get('/ui.css', async (_req, reply) =>
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'no-store').send(await page('ui.css')));
  app.get('/admin/login', serve('login.html'));
  app.get('/admin/ui', serve('admin.html'));
  app.get('/dashboard', serve('dashboard.html'));
  app.get('/', async (_req, reply) => reply.redirect('/admin/ui'));
};
