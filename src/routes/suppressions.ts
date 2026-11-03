import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parseAddress } from '../lib/email.js';
import {
  addSuppression,
  findSuppressed,
  getSuppression,
  removeOwnManualSuppression,
} from '../services/suppression.js';

/**
 * Project-facing suppression endpoints. The list is global (shared across projects)
 * because reputation is shared: projects can check any address and add manual
 * entries, but may only remove manual entries they added themselves. Bounce and
 * complaint suppressions can only be lifted via the admin API.
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
    const projectId = req.auth!.project.id;
    if (!(await removeOwnManualSuppression(app.db, parsed.address, projectId))) {
      const existing = await getSuppression(app.db, parsed.address);
      if (!existing) throw notFound('Suppression');
      throw forbidden(
        'suppression_not_removable',
        existing.reason === 'manual'
          ? 'This address was suppressed by another project; ask an admin to remove it'
          : `This address is suppressed because of a ${existing.reason}; only an admin can remove it`,
      );
    }
    req.log.warn({ email: parsed.address }, 'manual suppression removed by project');
    return reply.status(204).send();
  });
};
