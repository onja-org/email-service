import type { Queryable } from '../lib/db.js';

export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'suppressed'
  | 'failed';

export interface MessageRow {
  id: string;
  project_id: string;
  idempotency_key: string | null;
  status: MessageStatus;
  from_address: string;
  reply_to: string[];
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  suppressed: string[];
  subject: string;
  html: string | null;
  text: string | null;
  template_name: string | null;
  template_data: Record<string, unknown> | null;
  headers: Record<string, string>;
  tags: Record<string, string>;
  ses_message_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

export interface NewMessage {
  projectId: string;
  idempotencyKey?: string;
  status: 'queued' | 'suppressed';
  from: string;
  replyTo: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  suppressed: string[];
  subject: string;
  html?: string;
  text?: string;
  templateName?: string;
  templateData?: Record<string, unknown>;
  headers: Record<string, string>;
  tags: Record<string, string>;
}

/**
 * Inserts a message. If the (project, idempotency_key) pair already exists the
 * existing row is returned and `created` is false, so retries by clients are safe.
 */
export async function insertMessage(
  db: Queryable,
  m: NewMessage,
): Promise<{ message: MessageRow; created: boolean }> {
  const params = [
    m.projectId,
    m.idempotencyKey ?? null,
    m.status,
    m.from,
    m.replyTo,
    m.to,
    m.cc,
    m.bcc,
    m.suppressed,
    m.subject,
    m.html ?? null,
    m.text ?? null,
    m.templateName ?? null,
    m.templateData ? JSON.stringify(m.templateData) : null,
    JSON.stringify(m.headers),
    JSON.stringify(m.tags),
  ];
  const { rows } = await db.query<MessageRow>(
    `INSERT INTO messages (project_id, idempotency_key, status, from_address, reply_to, to_addresses,
       cc_addresses, bcc_addresses, suppressed, subject, html, text, template_name, template_data, headers, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (project_id, idempotency_key) DO NOTHING
     RETURNING *`,
    params,
  );
  if (rows[0]) return { message: rows[0], created: true };

  const existing = await db.query<MessageRow>(
    'SELECT * FROM messages WHERE project_id = $1 AND idempotency_key = $2',
    [m.projectId, m.idempotencyKey],
  );
  return { message: existing.rows[0], created: false };
}

export async function getMessage(db: Queryable, id: string, projectId?: string): Promise<MessageRow | null> {
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM messages WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2)`,
    [id, projectId ?? null],
  );
  return rows[0] ?? null;
}

export async function listMessages(
  db: Queryable,
  projectId: string,
  opts: { limit: number; before?: Date; status?: MessageStatus; to?: string },
): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `SELECT * FROM messages
     WHERE project_id = $1
       AND ($2::timestamptz IS NULL OR created_at < $2)
       AND ($3::message_status IS NULL OR status = $3)
       AND ($4::text IS NULL OR $4 = ANY(to_addresses))
     ORDER BY created_at DESC
     LIMIT $5`,
    [projectId, opts.before ?? null, opts.status ?? null, opts.to?.toLowerCase() ?? null, opts.limit],
  );
  return rows;
}

/**
 * Atomically claims a queued message for sending. Returns null if another worker
 * already claimed it or it is no longer queued (duplicate SQS delivery).
 * A message stuck in "sending" for over 5 minutes (worker crashed mid-send) may be
 * re-claimed; SES will not have been called twice in that window.
 */
export async function claimForSending(db: Queryable, id: string): Promise<MessageRow | null> {
  const { rows } = await db.query<MessageRow>(
    `UPDATE messages
     SET status = 'sending', attempts = attempts + 1, updated_at = now()
     WHERE id = $1
       AND (status = 'queued' OR (status = 'sending' AND updated_at < now() - interval '5 minutes'))
     RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Messages that have sat in "queued" for a long time were probably inserted but
 * never reached SQS (enqueue failed) or their SQS message was lost; messages
 * stuck in "sending" that long belong to a worker that died mid-send. The worker
 * periodically re-enqueues both; duplicate deliveries are harmless (see claim).
 */
export async function findStale(db: Queryable, olderThanMinutes: number, limit = 100): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM messages
     WHERE status IN ('queued', 'sending') AND updated_at < now() - ($1 || ' minutes')::interval
     ORDER BY updated_at LIMIT $2`,
    [String(olderThanMinutes), limit],
  );
  return rows.map((r) => r.id);
}

/** Marks a queued row as freshly re-enqueued. Never touches "sending": that would extend a dead worker's lease. */
export async function touch(db: Queryable, id: string): Promise<void> {
  await db.query("UPDATE messages SET updated_at = now() WHERE id = $1 AND status = 'queued'", [id]);
}

/**
 * Records the SES acceptance. The status only moves to "sent" if nothing has
 * overtaken it: an SES event (Delivery, Bounce) can arrive via the webhook before
 * this write lands, and must not be rolled back.
 */
export async function markSent(db: Queryable, id: string, sesMessageId: string): Promise<void> {
  await db.query(
    `UPDATE messages
     SET status = CASE WHEN status = 'sending' THEN 'sent'::message_status ELSE status END,
         ses_message_id = $2, sent_at = now(), last_error = NULL, updated_at = now()
     WHERE id = $1`,
    [id, sesMessageId],
  );
}

/** Puts the message back to queued so a later SQS redelivery retries it. */
export async function markRetry(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(`UPDATE messages SET status = 'queued', last_error = $2, updated_at = now() WHERE id = $1`, [
    id,
    error,
  ]);
}

export async function markFailed(db: Queryable, id: string, error: string): Promise<void> {
  await db.query(`UPDATE messages SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`, [
    id,
    error,
  ]);
}

export async function findBySesMessageId(db: Queryable, sesMessageId: string): Promise<MessageRow | null> {
  const { rows } = await db.query<MessageRow>('SELECT * FROM messages WHERE ses_message_id = $1', [sesMessageId]);
  return rows[0] ?? null;
}

export async function recordEvent(
  db: Queryable,
  messageId: string | null,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await db.query('INSERT INTO message_events (message_id, event_type, payload) VALUES ($1, $2, $3)', [
    messageId,
    eventType,
    JSON.stringify(payload),
  ]);
}

/**
 * Only move a message's status "forward". A late Delivery event must not
 * overwrite an earlier Bounce/Complaint.
 */
const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  suppressed: 3,
  failed: 3,
  bounced: 4,
  complained: 5,
};

export async function advanceStatus(db: Queryable, id: string, to: MessageStatus): Promise<void> {
  const allowedFrom = (Object.keys(STATUS_RANK) as MessageStatus[]).filter((s) => STATUS_RANK[s] < STATUS_RANK[to]);
  await db.query(
    `UPDATE messages SET status = $2, updated_at = now() WHERE id = $1 AND status = ANY($3::message_status[])`,
    [id, to, allowedFrom],
  );
}

export async function listEvents(db: Queryable, messageId: string) {
  const { rows } = await db.query<{ id: string; event_type: string; payload: unknown; created_at: Date }>(
    'SELECT id, event_type, payload, created_at FROM message_events WHERE message_id = $1 ORDER BY id',
    [messageId],
  );
  return rows;
}
