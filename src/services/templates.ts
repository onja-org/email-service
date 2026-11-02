import Handlebars from 'handlebars';
import type { Queryable } from '../lib/db.js';
import { notFound } from '../lib/errors.js';

export interface Template {
  id: string;
  project_id: string;
  name: string;
  subject: string;
  html: string | null;
  text: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RenderedTemplate {
  subject: string;
  html?: string;
  text?: string;
}

// Templates are compiled per render. Handlebars compilation is fast and this keeps
// multi-process deployments (API + worker) from serving stale compiled templates.
const hbs = Handlebars.create();

/**
 * Renders subject/html/text with Handlebars. HTML output escapes `{{var}}` by
 * default; use `{{{var}}}` in a template to insert trusted raw HTML.
 */
export function renderTemplate(
  tpl: Pick<Template, 'subject' | 'html' | 'text'>,
  data: Record<string, unknown> = {},
): RenderedTemplate {
  const opts = { strict: false, noEscape: false };
  const subject = hbs.compile(tpl.subject, { ...opts, noEscape: true })(data).trim();
  const html = tpl.html ? hbs.compile(tpl.html, opts)(data) : undefined;
  const text = tpl.text ? hbs.compile(tpl.text, { ...opts, noEscape: true })(data) : undefined;
  return { subject, html, text };
}

/** Throws a descriptive error if the template source does not parse. */
export function validateTemplateSource(tpl: Pick<Template, 'subject' | 'html' | 'text'>): void {
  hbs.precompile(tpl.subject);
  if (tpl.html) hbs.precompile(tpl.html);
  if (tpl.text) hbs.precompile(tpl.text);
}

export async function getTemplate(db: Queryable, projectId: string, name: string): Promise<Template> {
  const { rows } = await db.query<Template>(
    'SELECT * FROM templates WHERE project_id = $1 AND name = $2',
    [projectId, name],
  );
  if (!rows[0]) throw notFound(`Template "${name}"`);
  return rows[0];
}

export async function listTemplates(db: Queryable, projectId: string): Promise<Template[]> {
  const { rows } = await db.query<Template>(
    'SELECT * FROM templates WHERE project_id = $1 ORDER BY name',
    [projectId],
  );
  return rows;
}

export async function upsertTemplate(
  db: Queryable,
  projectId: string,
  input: { name: string; subject: string; html?: string | null; text?: string | null },
): Promise<Template> {
  validateTemplateSource({ subject: input.subject, html: input.html ?? null, text: input.text ?? null });
  const { rows } = await db.query<Template>(
    `INSERT INTO templates (project_id, name, subject, html, text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, name) DO UPDATE
       SET subject = EXCLUDED.subject, html = EXCLUDED.html, text = EXCLUDED.text, updated_at = now()
     RETURNING *`,
    [projectId, input.name, input.subject, input.html ?? null, input.text ?? null],
  );
  return rows[0];
}

export async function deleteTemplate(db: Queryable, projectId: string, name: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM templates WHERE project_id = $1 AND name = $2', [
    projectId,
    name,
  ]);
  return (rowCount ?? 0) > 0;
}
