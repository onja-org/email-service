import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { configSetName } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  addDomain,
  createApiKey,
  createProject,
  getProjectBySlug,
  listApiKeys,
  listDomains,
  listProjects,
  removeDomain,
  revokeApiKey,
} from '../services/projects.js';
import { addSuppression, getSuppression, listSuppressions, removeSuppression } from '../services/suppression.js';
import { getMessage, listEvents, listMessages } from '../services/messages.js';
import { listTemplates } from '../services/templates.js';
import { parseAddress } from '../lib/email.js';
import { serializeMessage } from './emails.js';

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/) });
const domainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'Must be a bare domain like example.com');

/**
 * Management API, protected by ADMIN_TOKEN. Used by whoever operates the service
 * to onboard a project: create it, attach its domain(s), issue API keys.
 */
export const adminRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preValidation', requireAdmin);

  // ---- Projects -------------------------------------------------------------

  app.get('/projects', async () => ({ data: await listProjects(app.db) }));

  app.post(
    '/projects',
    { schema: { body: z.object({ slug: slugParam.shape.slug, name: z.string().min(1).max(200) }) } },
    async (req, reply) => {
      const configSet = configSetName(app.cfg, req.body.slug);
      // Create the SES configuration set first so per-project metrics exist from
      // the first send. Idempotent on the SES side.
      await app.ses.ensureConfigurationSet(configSet);
      const project = await createProject(app.db, { ...req.body, configSet });
      return reply.status(201).send(project);
    },
  );

  app.get('/projects/:slug', { schema: { params: slugParam } }, async (req) => {
    const project = await getProjectBySlug(app.db, req.params.slug);
    const [domains, keys] = await Promise.all([listDomains(app.db, project.id), listApiKeys(app.db, project.id)]);
    return { ...project, domains, api_keys: keys };
  });

  // ---- Domains --------------------------------------------------------------

  /**
   * Attach a domain to a project and register it with SES. Responds with the DNS
   * records the domain owner must add. Call GET afterwards to poll verification.
   */
  app.post(
    '/projects/:slug/domains',
    { schema: { params: slugParam, body: z.object({ domain: domainSchema }) } },
    async (req, reply) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const domain = req.body.domain.toLowerCase();
      await addDomain(app.db, project.id, domain);
      const identity = await app.ses.createDomainIdentity(domain);
      return reply.status(201).send(identity);
    },
  );

  app.get(
    '/projects/:slug/domains/:domain',
    { schema: { params: slugParam.extend({ domain: domainSchema }) } },
    async (req) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const domains = await listDomains(app.db, project.id);
      const domain = req.params.domain.toLowerCase();
      if (!domains.includes(domain)) throw notFound(`Domain "${domain}" on project "${project.slug}"`);
      return app.ses.getDomainIdentity(domain);
    },
  );

  app.delete(
    '/projects/:slug/domains/:domain',
    {
      schema: {
        params: slugParam.extend({ domain: domainSchema }),
        querystring: z.object({ delete_identity: z.enum(['true', 'false']).default('false') }),
      },
    },
    async (req, reply) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const domain = req.params.domain.toLowerCase();
      const ok = await removeDomain(app.db, project.id, domain);
      if (!ok) throw notFound(`Domain "${domain}" on project "${project.slug}"`);
      if (req.query.delete_identity === 'true') await app.ses.deleteDomainIdentity(domain);
      return reply.status(204).send();
    },
  );

  // ---- API keys -------------------------------------------------------------

  app.post(
    '/projects/:slug/keys',
    { schema: { params: slugParam, body: z.object({ name: z.string().min(1).max(100) }) } },
    async (req, reply) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const { key, plaintext } = await createApiKey(app.db, project.id, req.body.name);
      // The plaintext key is returned exactly once.
      return reply.status(201).send({ ...key, key: plaintext });
    },
  );

  app.delete(
    '/projects/:slug/keys/:keyId',
    { schema: { params: slugParam.extend({ keyId: z.string().uuid() }) } },
    async (req, reply) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const ok = await revokeApiKey(app.db, project.id, req.params.keyId);
      if (!ok) throw notFound('API key');
      return reply.status(204).send();
    },
  );

  // ---- Messages and templates (read-only, any project) ----------------------

  app.get(
    '/projects/:slug/emails',
    {
      schema: {
        params: slugParam,
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          before: z.coerce.date().optional(),
          status: z.enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed']).optional(),
          to: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const project = await getProjectBySlug(app.db, req.params.slug);
      const rows = await listMessages(app.db, project.id, req.query);
      return {
        data: rows.map((m) => serializeMessage(m)),
        next_before: rows.length === req.query.limit ? rows[rows.length - 1].created_at : null,
      };
    },
  );

  app.get('/emails/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const m = await getMessage(app.db, req.params.id);
    if (!m) throw notFound('Email');
    return { ...serializeMessage(m, true), events: await listEvents(app.db, m.id) };
  });

  app.get('/projects/:slug/templates', { schema: { params: slugParam } }, async (req) => {
    const project = await getProjectBySlug(app.db, req.params.slug);
    const rows = await listTemplates(app.db, project.id);
    return { data: rows.map((t) => ({ name: t.name, subject: t.subject, has_html: !!t.html, has_text: !!t.text, updated_at: t.updated_at })) };
  });

  // ---- Suppressions (global view) -------------------------------------------

  app.get(
    '/suppressions',
    {
      schema: {
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(500).default(100),
          before: z.coerce.date().optional(),
        }),
      },
    },
    async (req) => {
      const rows = await listSuppressions(app.db, req.query);
      return { data: rows, next_before: rows.length === req.query.limit ? rows[rows.length - 1].created_at : null };
    },
  );

  app.get('/suppressions/:email', { schema: { params: z.object({ email: z.string() }) } }, async (req) => {
    const parsed = parseAddress(req.params.email);
    if (!parsed) throw badRequest('invalid_email', 'Not a valid email address');
    const row = await getSuppression(app.db, parsed.address);
    if (!row) throw notFound('Suppression');
    return row;
  });

  /** Admin-added manual suppression: belongs to no project, so no project can remove it. */
  app.post(
    '/suppressions',
    { schema: { body: z.object({ email: z.string(), note: z.string().max(500).optional() }) } },
    async (req, reply) => {
      const parsed = parseAddress(req.body.email);
      if (!parsed) throw badRequest('invalid_email', 'Not a valid email address');
      await addSuppression(app.db, {
        email: parsed.address,
        reason: 'manual',
        projectId: null,
        note: req.body.note ?? `Added by admin ${req.admin?.username ?? 'token'}`,
      });
      req.log.info({ email: parsed.address }, 'manual suppression added by admin');
      return reply.status(201).send(await getSuppression(app.db, parsed.address));
    },
  );

  app.delete('/suppressions/:email', { schema: { params: z.object({ email: z.string().email() }) } }, async (req, reply) => {
    if (!(await removeSuppression(app.db, req.params.email))) throw badRequest('not_suppressed', 'Address is not suppressed');
    req.log.warn({ email: req.params.email }, 'suppression removed by admin');
    return reply.status(204).send();
  });
};
