import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/routes (tsx) and dist/routes (compiled).
const htmlPath = path.resolve(here, '..', '..', 'public', 'dashboard.html');

/**
 * Serves the performance dashboard, a single static HTML page. The page itself
 * is public (it contains no data); everything it shows comes from /admin/stats/*,
 * which requires the admin token the viewer enters in the page.
 */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  let cached: string | null = null;

  app.get('/dashboard', async (_req, reply) => {
    if (cached === null || app.cfg.NODE_ENV === 'development') {
      cached = await readFile(htmlPath, 'utf8');
    }
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:")
      .send(cached);
  });

  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
};
