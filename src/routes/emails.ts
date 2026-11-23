import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireApiKey } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { submitEmail } from '../services/send.js';
import { neutralize, toPublicEvent } from '../services/events.js';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '../lib/attachments.js';
import {
  getMessage,
  listAttachmentMeta,
  listEvents,
  listMessages,
  type AttachmentMeta,
  type MessageRow,
} from '../services/messages.js';

const addressList = z.array(z.string().min(3).max(320)).max(50);

/** SES message tags: ASCII letters, digits, underscore, dash; ≤256 chars; ≤50 per message (2 are ours). */
const tagToken = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, 'Only letters, digits, "_" and "-" (max 256 chars)');
const tagsSchema = z
  .record(tagToken, tagToken)
  .refine((t) => Object.keys(t).length <= 48, { message: 'At most 48 tags' })
  .refine((t) => !Object.keys(t).some((k) => k.startsWith('emailsvc_')), { message: 'Tag names starting with "emailsvc_" are reserved' });

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  // Base64. Sizes are enforced on the decoded bytes in prepareAttachments.
  content: z.string().min(1).max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1_000_000),
  content_type: z.string().max(255).optional(),
  content_id: z.string().max(102).optional(),
});

/**
 * POST /emails carries base64 attachments (≤10 MB decoded ≈ 13.7 MB encoded) on top
 * of html/text bodies, so it gets a larger body limit than the rest of the API.
 */
const SEND_BODY_LIMIT = 25 * 1024 * 1024;

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
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
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

/**
 * Public representation of a message: omits bodies by default to keep lists small.
 * Provider-specific fields (the provider's message id, raw notifications) are left
 * out; admin routes add them back.
 */
export function serializeMessage(m: MessageRow, includeBody = false, attachments?: AttachmentMeta[]) {
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
    attempts: m.attempts,
    last_error: neutralize(m.last_error),
    idempotency_key: m.idempotency_key,
    created_at: m.created_at,
    sent_at: m.sent_at,
    updated_at: m.updated_at,
    ...(includeBody ? { html: m.html, text: m.text, headers: m.headers, template_data: m.template_data } : {}),
    ...(attachments
      ? {
          attachments: attachments.map((a) => ({
            filename: a.filename,
            content_type: a.content_type,
            content_id: a.content_id,
            size: a.size_bytes,
          })),
        }
      : {}),
  };
}

export const emailRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preValidation', requireApiKey);

  app.post('/emails', { bodyLimit: SEND_BODY_LIMIT, schema: { body: sendBodySchema } }, async (req, reply) => {
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
    return serializeMessage(m, true, await listAttachmentMeta(app.db, m.id));
  });

  app.get('/emails/:id/events', { schema: { params: z.object({ id: z.string().uuid() }) } }, async (req) => {
    const m = await getMessage(app.db, req.params.id, req.auth!.project.id);
    if (!m) throw notFound('Email');
    return { data: (await listEvents(app.db, m.id)).map(toPublicEvent) };
  });
};
