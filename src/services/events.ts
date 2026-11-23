import type { Db } from '../lib/db.js';
import { withTransaction } from '../lib/db.js';
import { advanceStatus, findBySesMessageId, recordEvent, type MessageStatus } from './messages.js';
import { addSuppression } from './suppression.js';

/**
 * Shape of the SES "event publishing" payload delivered through SNS.
 * Only the fields we use are typed. See:
 * https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html
 */
export interface SesEvent {
  eventType?: string;
  /** Older "notification" format uses notificationType instead of eventType. */
  notificationType?: string;
  mail?: {
    messageId?: string;
    tags?: Record<string, string[]>;
  };
  bounce?: {
    bounceType?: 'Permanent' | 'Transient' | 'Undetermined';
    bounceSubType?: string;
    bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: { emailAddress: string }[];
  };
  reject?: { reason?: string };
  failure?: { errorMessage?: string };
}

export interface Interpretation {
  type: string;
  sesMessageId: string | null;
  /** Our own message id if SES echoed the tag back (fallback for lookup). */
  taggedMessageId: string | null;
  newStatus: MessageStatus | null;
  suppress: { email: string; reason: 'bounce' | 'complaint'; note: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure translation of an SES event into the state changes it implies. */
export function interpretSesEvent(ev: SesEvent): Interpretation {
  const type = (ev.eventType ?? ev.notificationType ?? 'Unknown').toString();
  const sesMessageId = ev.mail?.messageId ?? null;
  const tagged = ev.mail?.tags?.emailsvc_message_id?.[0];
  // Only trust the tag when it is shaped like our ids; a malformed value would make the uuid lookup throw.
  const taggedMessageId = tagged && UUID_RE.test(tagged) ? tagged : null;
  const out: Interpretation = { type, sesMessageId, taggedMessageId, newStatus: null, suppress: [] };

  switch (type) {
    case 'Delivery':
      out.newStatus = 'delivered';
      break;
    case 'Bounce': {
      const permanent = ev.bounce?.bounceType === 'Permanent';
      out.newStatus = permanent ? 'bounced' : null;
      if (permanent) {
        for (const r of ev.bounce?.bouncedRecipients ?? []) {
          out.suppress.push({
            email: r.emailAddress,
            reason: 'bounce',
            note: [ev.bounce?.bounceSubType, r.diagnosticCode].filter(Boolean).join(': ') || 'Permanent bounce',
          });
        }
      }
      break;
    }
    case 'Complaint':
      out.newStatus = 'complained';
      for (const r of ev.complaint?.complainedRecipients ?? []) {
        out.suppress.push({
          email: r.emailAddress,
          reason: 'complaint',
          note: ev.complaint?.complaintFeedbackType ?? 'Spam complaint',
        });
      }
      break;
    case 'Reject':
    case 'RenderingFailure':
      out.newStatus = 'failed';
      break;
    default:
      // Send, Open, Click, DeliveryDelay, Subscription: recorded, no status change.
      break;
  }
  return out;
}

/** Applies an SES event to the database. Unknown message ids are still logged. */
export async function applySesEvent(db: Db, ev: SesEvent): Promise<Interpretation> {
  const it = interpretSesEvent(ev);

  await withTransaction(db, async (tx) => {
    let message = it.sesMessageId ? await findBySesMessageId(tx, it.sesMessageId) : null;
    if (!message && it.taggedMessageId) {
      const { rows } = await tx.query('SELECT * FROM messages WHERE id = $1', [it.taggedMessageId]);
      message = rows[0] ?? null;
    }

    await recordEvent(tx, message?.id ?? null, it.type, ev);

    if (message && it.newStatus) {
      await advanceStatus(tx, message.id, it.newStatus);
    }
    for (const s of it.suppress) {
      await addSuppression(tx, {
        email: s.email,
        reason: s.reason,
        projectId: message?.project_id ?? null,
        messageId: message?.id ?? null,
        note: s.note,
      });
    }
  });

  return it;
}

// ---- Public (project API) view of events -----------------------------------------

/** Removes the sending provider's name from text shown to projects. */
export function neutralize(text: string): string;
export function neutralize(text: string | null): string | null;
export function neutralize(text: string | null): string | null {
  if (text == null) return text;
  return text
    .replace(/\bAmazon\s+(Simple\s+Email\s+Service|SES)\b/gi, 'Pigeon')
    .replace(/\bAmazon\b|\bAWS\b/gi, '')
    .replace(/\bSES\b/g, 'Pigeon')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface ProviderEventPayload extends SesEvent {
  delivery?: { recipients?: string[] };
  deliveryDelay?: { delayType?: string; delayedRecipients?: { emailAddress: string }[] };
}

export interface PublicEvent {
  id: string;
  event_type: string;
  created_at: Date;
  /** A provider-neutral summary of what happened. Never the raw notification. */
  details: Record<string, unknown>;
}

/**
 * What a project sees for a delivery event: the type, when, and the facts it
 * needs (who, bounce kind, reason), without the provider's raw notification.
 */
export function toPublicEvent(row: { id: string; event_type: string; payload: unknown; created_at: Date }): PublicEvent {
  const p = (row.payload ?? {}) as ProviderEventPayload;
  let details: Record<string, unknown> = {};
  switch (row.event_type) {
    case 'Delivery':
      details = { recipients: p.delivery?.recipients ?? [] };
      break;
    case 'Bounce':
      details = {
        bounce_type: p.bounce?.bounceType?.toLowerCase() ?? null,
        bounce_subtype: p.bounce?.bounceSubType ?? null,
        recipients: (p.bounce?.bouncedRecipients ?? []).map((r) => ({
          email: r.emailAddress,
          diagnostic: neutralize(r.diagnosticCode ?? null),
        })),
      };
      break;
    case 'Complaint':
      details = {
        feedback_type: p.complaint?.complaintFeedbackType ?? null,
        recipients: (p.complaint?.complainedRecipients ?? []).map((r) => r.emailAddress),
      };
      break;
    case 'DeliveryDelay':
      details = {
        delay_type: p.deliveryDelay?.delayType ?? null,
        recipients: (p.deliveryDelay?.delayedRecipients ?? []).map((r) => r.emailAddress),
      };
      break;
    case 'Reject':
      details = { reason: neutralize(p.reject?.reason ?? null) };
      break;
    case 'RenderingFailure':
      details = { error: neutralize(p.failure?.errorMessage ?? null) };
      break;
    default:
      break;
  }
  return { id: String(row.id), event_type: row.event_type, created_at: row.created_at, details };
}
