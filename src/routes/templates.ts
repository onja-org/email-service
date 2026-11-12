import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  renderTemplate,
  upsertTemplate,
  type Template,
} from '../services/templates.js';

const nameParam = z.object({ name: z.string().min(1).max(100) });

const templateBody = z
  .object({
    subject: z.string().min(1).max(998),
    html: z.string().max(5_000_000).nullable().optional(),
    text: z.string().max(5_000_000).nullable().optional(),
  })
  .refine((t) => t.html || t.text, { message: 'Either html or text is required' });

const serialize = (t: Template) => ({
  name: t.name,
  subject: t.subject,
  html: t.html,
  text: t.text,
  created_at: t.created_at,
  updated_at: t.updated_at,
});

export const templateRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preValidation', requireApiKey);

  app.get('/templates', async (req) => ({
    data: (await listTemplates(app.db, req.auth!.project.id)).map(serialize),
  }));

  app.get('/templates/:name', { schema: { params: nameParam } }, async (req) =>
    serialize(await getTemplate(app.db, req.auth!.project.id, req.params.name)),
  );

  app.put('/templates/:name', { schema: { params: nameParam, body: templateBody } }, async (req) => {
    try {
      const t = await upsertTemplate(app.db, req.auth!.project.id, { name: req.params.name, ...req.body });
      return serialize(t);
    } catch (err) {
      if (err instanceof Error && /Parse error|Expecting/.test(err.message)) {
        throw badRequest('template_syntax', `Template does not compile: ${err.message}`);
      }
      throw err;
    }
  });

  app.delete('/templates/:name', { schema: { params: nameParam } }, async (req, reply) => {
    const ok = await deleteTemplate(app.db, req.auth!.project.id, req.params.name);
    if (!ok) throw notFound(`Template "${req.params.name}"`);
    return reply.status(204).send();
  });

  /** Preview a template with sample data without sending anything. */
  app.post(
    '/templates/:name/render',
    { schema: { params: nameParam, body: z.object({ data: z.record(z.unknown()).default({}) }) } },
    async (req) => {
      const t = await getTemplate(app.db, req.auth!.project.id, req.params.name);
      return renderTemplate(t, req.body.data);
    },
  );
};
