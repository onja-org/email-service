import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFaq, PAGES, renderHead, renderRobots, renderSitemap, type SitePage } from '../site/seo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/routes (tsx) and dist/routes (compiled).
const publicDir = path.resolve(here, '..', '..', 'public');

const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";

/** Binary assets: each prefix serves only names matching its pattern, read as raw bytes. */
const ASSETS: Record<string, { dir: string; pattern: RegExp; types: Record<string, string>; maxAge: number }> = {
  fonts: { dir: 'fonts', pattern: /^[a-z0-9-]+\.woff2$/, types: { woff2: 'font/woff2' }, maxAge: 604_800 },
  og: { dir: 'og', pattern: /^[a-z0-9-]+\.png$/, types: { png: 'image/png' }, maxAge: 86_400 },
  brand: { dir: 'brand', pattern: /^[a-z0-9-]+\.(png|svg)$/, types: { png: 'image/png', svg: 'image/svg+xml' }, maxAge: 86_400 },
};

/**
 * Serves the web pages:
 * - the public site (home, one page per menu section) and the developer guide,
 *   each with its own title, description, canonical URL, Open Graph image and
 *   structured data, plus robots.txt and sitemap.xml;
 * - the admin UI (login page, management SPA, performance dashboard), which is
 *   kept out of search results. Every byte of admin data comes from the /admin/*
 *   API, which requires the session cookie set by /admin/auth/login.
 */
export const uiRoutes: FastifyPluginAsync = async (app) => {
  const dev = app.cfg.NODE_ENV === 'development';
  const origin = app.cfg.PUBLIC_URL;
  const text = new Map<string, string>();
  async function file(name: string): Promise<string> {
    if (!dev && text.has(name)) return text.get(name)!;
    const s = await readFile(path.join(publicDir, name), 'utf8');
    text.set(name, s);
    return s;
  }
  const html = (reply: FastifyReply, body: string, opts: { index: boolean }) => {
    reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', opts.index ? 'public, max-age=300' : 'no-store');
    if (!opts.index) reply.header('x-robots-tag', 'noindex, nofollow');
    return reply.send(body);
  };

  // ---- public site ------------------------------------------------------------

  /** Renders a page once (origin comes from config, never from request headers) and caches it. */
  const rendered = new Map<string, string>();
  async function renderPage(page: SitePage): Promise<string> {
    if (!dev && rendered.has(page.id)) return rendered.get(page.id)!;
    let out: string;
    if (page.fragment) {
      const [layout, body] = await Promise.all([file('site/layout.html'), file(`site/pages/${page.fragment}`)]);
      const faq = page.id === 'faq' ? extractFaq(body) : undefined;
      out = layout
        .replace('{{HEAD}}', () => renderHead(page, origin, { faq }))
        .replace('{{BODY}}', () => body)
        .replace(`data-page="${page.id}"`, `data-page="${page.id}" aria-current="page"`);
    } else {
      // The developer guide keeps its own document; swap in the shared head tags.
      const docs = await file('docs.html');
      out = docs.replace(/<title>[\s\S]*?<\/title>\s*<meta name="description"[^>]*>/, () => renderHead(page, origin));
    }
    rendered.set(page.id, out);
    return out;
  }
  for (const page of PAGES) {
    app.get(page.path, async (_req, reply) => html(reply, await renderPage(page), { index: true }));
  }

  app.get('/site.css', async (_req, reply) =>
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'public, max-age=300').send(await file('site/site.css')));

  const lastmod = new Date().toISOString().slice(0, 10);
  app.get('/robots.txt', async (_req, reply) =>
    reply.header('content-type', 'text/plain; charset=utf-8').header('cache-control', 'public, max-age=3600').send(renderRobots(origin)));
  app.get('/sitemap.xml', async (_req, reply) =>
    reply.header('content-type', 'application/xml; charset=utf-8').header('cache-control', 'public, max-age=3600').send(renderSitemap(origin, lastmod)));

  // ---- binary assets (fonts, share images, icons) --------------------------------

  const bytes = new Map<string, Buffer>();
  async function sendAsset(reply: FastifyReply, kind: string, name: string) {
    const spec = ASSETS[kind];
    const notFound = () => reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } });
    if (!spec || !spec.pattern.test(name)) return notFound();
    const key = `${kind}/${name}`;
    let buf = bytes.get(key);
    if (!buf) {
      try {
        buf = await readFile(path.join(publicDir, spec.dir, name));
      } catch {
        return notFound();
      }
      bytes.set(key, buf);
    }
    return reply
      .header('content-type', spec.types[name.slice(name.lastIndexOf('.') + 1)])
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', `public, max-age=${spec.maxAge}`)
      .send(buf);
  }
  app.get<{ Params: { file: string } }>('/fonts/:file', (req, reply) => sendAsset(reply, 'fonts', req.params.file));
  app.get<{ Params: { file: string } }>('/og/:file', (req, reply) => sendAsset(reply, 'og', req.params.file));
  app.get<{ Params: { file: string } }>('/brand/:file', (req, reply) => sendAsset(reply, 'brand', req.params.file));
  app.get('/favicon.svg', (_req, reply) => sendAsset(reply, 'brand', 'favicon.svg'));
  app.get('/apple-touch-icon.png', (_req, reply) => sendAsset(reply, 'brand', 'apple-touch-icon.png'));

  // ---- admin UI (never indexed; deliberately not blocked in robots.txt so crawlers see the noindex) ----

  app.get('/ui.css', async (_req, reply) =>
    reply.header('content-type', 'text/css; charset=utf-8').header('cache-control', 'no-store').send(await file('ui.css')));
  app.get('/admin/login', async (_req, reply) => html(reply, await file('login.html'), { index: false }));
  app.get('/admin/ui', async (_req, reply) => html(reply, await file('admin.html'), { index: false }));
  app.get('/dashboard', async (_req, reply) => html(reply, await file('dashboard.html'), { index: false }));
};
