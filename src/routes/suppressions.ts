import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parseAddress } from '../lib/email.js';
import { addSuppression, findSuppressed, removeSuppression } from '../services/suppression.js';

/**
 * Project-facing suppression endpoints. The list is global (shared across projects)
 * because reputation is shared, but projects can check and manage individual addresses.
 */
export const suppressionRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', requireApiKey);

  app.get('/suppressions/:email', { schema: { params: z.object({ email: z.string() }) } }, async (req) => {
    const parsed = parseAddress(req.params.email);
    if (!parsed) throw badRequest('invalid_email', 'Not a valid email address');
    const found = await findSuppressed(app.db, [parsed.address]);
    return { email: parsed.address, suppressed: found.has(parsed.address) };
  });

  app.post(
    '/suppressions',
    { schema: { body: z.object({ email: z.string(), note: z.string().max(500).optional() }) } },
    async (req, reply) => {
      const parsed = parseAddress(req.body.email);
      if (!parsed) throw badRequest('invalid_email', 'Not a valid email address');
      await addSuppression(app.db, {
        email: parsed.address,
        reason: 'manual',
        projectId: req.auth!.project.id,
        note: req.body.note ?? `Added via API by project ${req.auth!.project.slug}`,
      });
      return reply.status(201).send({ email: parsed.address, suppressed: true });
    },
  );

  app.delete('/suppressions/:email', { schema: { params: z.object({ email: z.string() }) } }, async (req, reply) => {
    const parsed = parseAddress(req.params.email);
    if (!parsed) throw badRequest('invalid_email', 'Not a valid email address');
    const ok = await removeSuppression(app.db, parsed.address);
    if (!ok) throw notFound('Suppression');
    req.log.warn({ email: parsed.address }, 'suppression removed by project');
    return reply.status(204).send();
  });
};
