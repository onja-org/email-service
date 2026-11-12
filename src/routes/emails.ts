import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { submitEmail } from '../services/send.js';
import { getMessage, listEvents, listMessages, type MessageRow } from '../services/messages.js';

const addressList = z.array(z.string().min(3).max(320)).max(50);

/** SES message tags: ASCII letters, digits, underscore, dash; ≤256 chars; ≤50 per message (2 are ours). */
const tagToken = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'Only letters, digits, "_" and "-" (max 256 chars)');
const tagsSchema = z
  .record(tagToken, tagToken)
  .refine((t) => Object.keys(t).length <= 48, { message: 'At most 48 tags' })
  .refine((t) => !Object.keys(t).some((k) => k.startsWith('emailsvc_')), { message: 'Tag names starting with "emailsvc_" are reserved' });

export const sendBodySchema = z.object({
  from: z.string().min(3).max(320),
  to: addressList.min(1),
  cc: addressList.optional(),
  bcc: addressList.optional(),
  reply_to: z.array(z.string().min(3).max(320)).max(10).optional(),
  subject: z.string().max(998).optional(),
  html: z.string().max(5_000_000).optional(),
  text: z.string().max(5_000_000).optional(),
  template: z.string().min(1).max(100).optional(),
  template_data: z.record(z.unknown()).optional(),
  headers: z.record(z.string().max(1000)).optional(),
  tags: tagsSchema.optional(),
  idempotency_key: z.string().min(1).max(255).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
  status: z
    .enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed'])
    .optional(),
  to: z.string().optional(),
});

/** Public representation of a message: omits bodies by default to keep lists small. */
export function serializeMessage(m: MessageRow, includeBody = false) {
  return {
    id: m.id,
    status: m.status,
    from: m.from_address,
    to: m.to_addresses,
    cc: m.cc_addresses,
    bcc: m.bcc_addresses,
    reply_to: m.reply_to,
    suppressed_recipients: m.suppressed,
    subject: m.subject,
    template: m.template_name,
    tags: m.tags,
    ses_message_id: m.ses_message_id,
    attempts: m.attempts,
    last_error: m.last_error,
    idempotency_key: m.idempotency_key,
    created_at: m.created_at,
    sent_at: m.sent_at,
    updated_at: m.updated_at,
    ...(includeBody ? { html: m.html, text: m.text, headers: m.headers, template_data: m.template_data } : {}),
  };
}

export const emailRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preValidation', requireApiKey);

  app.post('/emails', { schema: { body: sendBodySchema } }, async (req, reply) => {
    const { message, created } = await submitEmail({ db: app.db, queue: app.queue }, req.auth!, req.body);
    req.log.info(
      { messageId: message.id, status: message.status, to: message.to_addresses.length, created },
      'email submitted',
    );
    return reply.status(created ? 202 : 200).send({ ...serializeMessage(message), idempotent_replay: !created });
  });

  app.get('/emails', { schema: { querystring: listQuerySchema } }, async (req) => {
    const rows = await listMessages(app.db, req.auth!.project.id, req.query);
    return {
      data: rows.map((m) => serializeMessage(m)),
      next_before: rows.length === req.query.limit ? rows[rows.length - 1].created_at : null,
    };
  });

  app.get('/emails/:id', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const m = await getMessage(app.db, req.params.id, req.auth!.project.id);
    if (!m) throw notFound('Email');
    return serializeMessage(m, true);
  });

  app.get('/emails/:id/events', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const m = await getMessage(app.db, req.params.id, req.auth!.project.id);
    if (!m) throw notFound('Email');
    return { data: await listEvents(app.db, m.id) };
  });
};
