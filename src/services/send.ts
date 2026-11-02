import type { Db } from '../lib/db.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { invalidAddresses, isAllowedSender, parseAddress, parseAddressList } from '../lib/email.js';
import type { AuthContext } from './projects.js';
import type { Queue } from './queue.js';
import { getTemplate, renderTemplate } from './templates.js';
import { findSuppressed } from './suppression.js';
import { insertMessage, type MessageRow } from './messages.js';

export interface SendInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject?: string;
  html?: string;
  text?: string;
  template?: string;
  template_data?: Record<string, unknown>;
  headers?: Record<string, string>;
  tags?: Record<string, string>;
  idempotency_key?: string;
}

/** Headers the caller may not override; SES sets these from the structured fields. */
const RESERVED_HEADERS = new Set([
  'from', 'to', 'cc', 'bcc', 'subject', 'reply-to', 'return-path', 'date', 'message-id',
  'mime-version', 'content-type', 'content-transfer-encoding', 'dkim-signature', 'received',
]);

export interface PreparedEmail {
  from: string;
  fromDomain: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  headers: Record<string, string>;
  tags: Record<string, string>;
}

/**
 * Validates addresses, sender ownership and headers. Pure: no DB access, so it
 * is unit-tested directly. Throws HttpError on invalid input.
 */
export function prepareEmail(input: SendInput, auth: AuthContext): PreparedEmail {
  const from = parseAddress(input.from);
  if (!from) throw badRequest('invalid_from', `"${input.from}" is not a valid email address`);

  if (!isAllowedSender(from.domain, auth.domains)) {
    throw forbidden(
      'sender_domain_not_allowed',
      `Project "${auth.project.slug}" may not send from "${from.domain}". Allowed domains: ${
        auth.domains.length ? auth.domains.join(', ') : '(none configured)'
      }`,
    );
  }

  const bad = [
    ...invalidAddresses(input.to),
    ...invalidAddresses(input.cc),
    ...invalidAddresses(input.bcc),
    ...invalidAddresses(input.reply_to),
  ];
  if (bad.length) throw badRequest('invalid_recipient', 'Invalid email address(es)', { addresses: bad });

  const to = parseAddressList(input.to).map((a) => a.raw);
  if (to.length === 0) throw badRequest('missing_recipient', 'At least one "to" recipient is required');

  const totalRecipients = to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
  if (totalRecipients > 50) throw badRequest('too_many_recipients', 'SES allows at most 50 recipients per message');

  if (!input.template) {
    if (!input.subject?.trim()) throw badRequest('missing_subject', '"subject" is required when no template is used');
    if (!input.html && !input.text) {
      throw badRequest('missing_body', 'Either "html" or "text" is required when no template is used');
    }
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw badRequest('reserved_header', `Header "${name}" cannot be set directly`);
    }
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) {
      throw badRequest('invalid_header', `Header "${name}" is malformed`);
    }
    headers[name] = value;
  }

  return {
    from: from.raw,
    fromDomain: from.domain,
    to,
    cc: parseAddressList(input.cc).map((a) => a.raw),
    bcc: parseAddressList(input.bcc).map((a) => a.raw),
    replyTo: parseAddressList(input.reply_to).map((a) => a.raw),
    headers,
    tags: input.tags ?? {},
  };
}

export interface SubmitResult {
  message: MessageRow;
  /** False when an idempotency key matched an existing message. */
  created: boolean;
}

/**
 * Full send pipeline for the API: validate, render template, drop suppressed
 * recipients, persist, enqueue. Returns the stored message (status "queued" or
 * "suppressed").
 */
export async function submitEmail(
  deps: { db: Db; queue: Queue },
  auth: AuthContext,
  input: SendInput,
): Promise<SubmitResult> {
  const prepared = prepareEmail(input, auth);

  // Resolve content now so queued messages are immune to later template edits
  // and the stored row shows exactly what was sent.
  let subject = input.subject?.trim() ?? '';
  let html = input.html;
  let text = input.text;
  if (input.template) {
    const tpl = await getTemplate(deps.db, auth.project.id, input.template);
    const rendered = renderTemplate(tpl, input.template_data ?? {});
    subject = input.subject?.trim() || rendered.subject;
    html = rendered.html ?? html;
    text = rendered.text ?? text;
    if (!html && !text) throw badRequest('empty_template', `Template "${tpl.name}" has no html or text body`);
  }

  const bare = (list: string[]) => list.map((r) => parseAddress(r)!.address);
  const suppressedSet = await findSuppressed(deps.db, [
    ...bare(prepared.to),
    ...bare(prepared.cc),
    ...bare(prepared.bcc),
  ]);
  const keep = (list: string[]) => list.filter((r) => !suppressedSet.has(parseAddress(r)!.address));
  const to = keep(prepared.to);
  const cc = keep(prepared.cc);
  const bcc = keep(prepared.bcc);
  const suppressed = [...suppressedSet];

  const status = to.length === 0 ? 'suppressed' : 'queued';

  const { message, created } = await insertMessage(deps.db, {
    projectId: auth.project.id,
    idempotencyKey: input.idempotency_key,
    status,
    from: prepared.from,
    replyTo: prepared.replyTo,
    to,
    cc,
    bcc,
    suppressed,
    subject,
    html,
    text,
    templateName: input.template,
    templateData: input.template_data,
    headers: prepared.headers,
    tags: prepared.tags,
  });

  if (created && status === 'queued') {
    try {
      await deps.queue.enqueue({ messageId: message.id });
    } catch (err) {
      // Leave it "queued": the worker's stale sweep will re-enqueue it. Record why.
      const reason = err instanceof Error ? err.message : String(err);
      await deps.db
        .query('UPDATE messages SET last_error = $2 WHERE id = $1', [message.id, `enqueue failed: ${reason}`])
        .catch(() => undefined);
    }
  }

  return { message, created };
}
