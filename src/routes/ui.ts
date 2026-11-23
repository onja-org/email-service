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
 * Serves the web pages: the public developer guide at / (and /docs), and the
 * admin UI (login page, management SPA, performance dashboard). All are static
 * HTML; every byte of admin data comes from the /admin/* API, which requires
 * the session cookie set by /admin/auth/login.
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

  // Self-hosted brand fonts (Fraunces, Instrument Sans, IBM Plex Mono; OFL licences alongside).
  // Read as raw bytes: page() decodes UTF-8, which would corrupt woff2.
  const fonts = new Map<string, Buffer>();
  app.get<{ Params: { file: string } }>('/fonts/:file', async (req, reply) => {
    const { file } = req.params;
    if (!/^[a-z0-9-]+\.woff2$/.test(file)) return reply.status(404).send({ error: { code: 'not_found', message: 'Font not found' } });
    let bytes = fonts.get(file);
    if (!bytes) {
      try {
        bytes = await readFile(path.join(publicDir, 'fonts', file));
      } catch {
        return reply.status(404).send({ error: { code: 'not_found', message: 'Font not found' } });
      }
      fonts.set(file, bytes);
    }
    return reply
      .header('content-type', 'font/woff2')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'public, max-age=604800')
      .send(bytes);
  });

  app.get('/ui.css', async (_req, reply) =>
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'no-store').send(await page('ui.css')));
  app.get('/admin/login', serve('login.html'));
  app.get('/admin/ui', serve('admin.html'));
  app.get('/dashboard', serve('dashboard.html'));
  // Public marketing page, and the developer guide for projects integrating with the API.
  app.get('/', serve('home.html'));
  app.get('/docs', serve('docs.html'));
};
