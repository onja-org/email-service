import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { withTransaction } from '../lib/db.js';
import { configSetName } from '../config.js';
import { badRequest, notFound } from '../lib/errors.js';
import {
  addDomain,
  configSetInUse,
  createApiKey,
  createProject,
  deleteProject,
  getProjectBySlug,
  listApiKeys,
  listDomains,
  listProjects,
  removeDomain,
  revokeApiKey,
  updateProject,
} from '../services/projects.js';
import { addSuppression, getSuppression, listSuppressions, removeSuppression } from '../services/suppression.js';
import {
  getAttachment,
  getMessage,
  listAttachmentMeta,
  listEvents,
  listMessages,
  loadInlineImages,
} from '../services/messages.js';
import {
  attachmentDisposition,
  buildPreview,
  hasRemoteImages,
  logStatusCounts,
  previewCsp,
  searchLog,
  type LogRow,
} from '../services/email-log.js';
import { listTemplates } from '../services/templates.js';
import { parseAddress } from '../lib/email.js';
import { serializeMessage } from './emails.js';

const slugParam = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/) });
const STATUSES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed'] as const;
const MAX_LOG_WINDOW_DAYS = 400;

const logQuery = z.object({
  /** ISO timestamps: since is inclusive, until exclusive. The UI sends the viewer's local day boundaries. */
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
  domain: z
    .string()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, 'Must be a bare domain like example.com')
    .optional(),
  status: z.enum(STATUSES).optional(),
  recipient: z.string().trim().min(1).max(320).optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Id of the last email on the previous page. */
  cursor: z.string().uuid().optional(),
});

function serializeLogRow(r: LogRow) {
  return {
    id: r.id,
    project: r.project_slug,
    status: r.status,
    from: r.from_address,
    from_domain: r.from_domain,
    to: r.to_addresses,
    cc: r.cc_addresses,
    bcc: r.bcc_addresses,
    suppressed_recipients: r.suppressed,
    subject: r.subject,
    template: r.template_name,
    attempts: r.attempts,
    last_error: r.last_error,
    attachment_count: r.attachment_count,
    created_at: r.created_at,
    sent_at: r.sent_at,
  };
}

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
      let configSet = configSetName(app.cfg, req.body.slug);
      // A renamed project keeps its original configuration set, so this slug's
      // default name may already belong to someone else. Never share one.
      if (await configSetInUse(app.db, configSet)) configSet = `${configSet}-${randomBytes(3).toString('hex')}`;
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

  /** Rename a project and/or change its slug. API keys keep working; URLs using the old slug stop. */
  app.patch(
    '/projects/:slug',
    {
      schema: {
        params: slugParam,
        body: z
          .object({ name: z.string().trim().min(1).max(200).optional(), slug: slugParam.shape.slug.optional() })
          .refine((b) => b.name !== undefined || b.slug !== undefined, 'Provide a name or a slug to change'),
      },
    },
    async (req) => updateProject(app.db, req.params.slug, req.body),
  );

  /**
   * Delete a project and everything it owns (domains, API keys, templates, emails).
   * Irreversible, so the caller must repeat the slug in `confirm`. The project's SES
   * configuration set is removed too; its domain identities only on request, since
   * the same domain may be re-attached to another project.
   */
  app.delete(
    '/projects/:slug',
    {
      schema: {
        params: slugParam,
        querystring: z.object({
          confirm: z.string().optional(),
          delete_identities: z.enum(['true', 'false']).default('false'),
        }),
      },
    },
    async (req) => {
      const { slug } = req.params;
      if (req.query.confirm !== slug) {
        throw badRequest('confirmation_required', `Deleting a project is permanent. Repeat its slug: ?confirm=${slug}`);
      }
      const removed = await withTransaction(app.db, (tx) => deleteProject(tx, slug));
      req.log.warn({ project: slug, counts: removed.counts, domains: removed.domains }, 'project deleted');

      // Provider clean-up is best effort: the project is already gone, so report
      // what could not be removed instead of failing the request.
      const warnings: string[] = [];
      const { config_set: configSet } = removed.project;
      try {
        if (!(await configSetInUse(app.db, configSet))) await app.ses.deleteConfigurationSet(configSet);
      } catch (err) {
        req.log.warn({ err, configSet }, 'could not delete SES configuration set');
        warnings.push(`Configuration set "${configSet}" could not be deleted: ${(err as Error).message}`);
      }
      if (req.query.delete_identities === 'true') {
        for (const domain of removed.domains) {
          try {
            await app.ses.deleteDomainIdentity(domain);
          } catch (err) {
            req.log.warn({ err, domain }, 'could not delete SES domain identity');
            warnings.push(`Identity for "${domain}" could not be deleted: ${(err as Error).message}`);
          }
        }
      }
      return {
        deleted: removed.project.slug,
        domains: removed.domains,
        emails: removed.counts.emails,
        templates: removed.counts.templates,
        api_keys: removed.counts.api_keys,
        warnings,
      };
    },
  );

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

  // ---- Email log (every project) ---------------------------------------------

  app.get('/emails', { schema: { querystring: logQuery } }, async (req) => {
    const { limit, cursor, ...filters } = req.query;
    const { since, until } = filters;
    if (since && until && since >= until) throw badRequest('invalid_window', '"since" must be before "until"');
    if (since && (until ?? new Date()).getTime() - since.getTime() > MAX_LOG_WINDOW_DAYS * 86_400_000) {
      throw badRequest('window_too_large', `Window may not exceed ${MAX_LOG_WINDOW_DAYS} days`);
    }
    const f = {
      since,
      until,
      projectSlug: filters.project,
      domain: filters.domain,
      status: filters.status,
      recipient: filters.recipient,
      subject: filters.subject,
    };
    const [{ rows, nextCursor }, counts] = await Promise.all([
      searchLog(app.db, f, { limit, cursor }),
      logStatusCounts(app.db, f),
    ]);
    return {
      data: rows.map(serializeLogRow),
      next_cursor: nextCursor,
      // Per status for the same filters minus the status filter; total is their sum.
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      retention_days: app.cfg.RETENTION_DAYS,
    };
  });

  app.get('/emails/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const m = await getMessage(app.db, req.params.id);
    if (!m) throw notFound('Email');
    const { rows } = await app.db.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [m.project_id]);
    return {
      ...serializeMessage(m, true, await listAttachmentMeta(app.db, m.id)),
      // Operators see the raw provider details the project API hides.
      last_error: m.last_error,
      ses_message_id: m.ses_message_id,
      project: rows[0]?.slug ?? null,
      from_domain: m.from_domain,
      has_remote_images: hasRemoteImages(m.html),
      events: await listEvents(app.db, m.id),
    };
  });

  /**
   * The email rendered as a standalone document, for a sandboxed <iframe> in the
   * admin UI. Never served with the admin page's own CSP: see previewCsp.
   */
  app.get(
    '/emails/:id/preview',
    {
      schema: {
        params: z.object({ id: z.string().uuid() }),
        querystring: z.object({ remote_images: z.enum(['0', '1']).default('0') }),
      },
    },
    async (req, reply) => {
      const m = await getMessage(app.db, req.params.id);
      if (!m) throw notFound('Email');
      const inline = m.html ? await loadInlineImages(app.db, m.id) : [];
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('content-security-policy', previewCsp(req.query.remote_images === '1'))
        .header('referrer-policy', 'no-referrer')
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(buildPreview(m, inline));
    },
  );

  app.get(
    '/emails/:id/attachments/:position',
    { schema: { params: z.object({ id: z.string().uuid(), position: z.coerce.number().int().min(0).max(100) }) } },
    async (req, reply) => {
      const a = await getAttachment(app.db, req.params.id, req.params.position);
      if (!a) throw notFound('Attachment');
      return reply
        .header('content-type', a.content_type ?? 'application/octet-stream')
        .header('content-disposition', attachmentDisposition(a.filename))
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(a.content);
    },
  );

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
