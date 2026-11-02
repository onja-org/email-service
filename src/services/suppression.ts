import type { Queryable } from '../lib/db.js';

export type SuppressionReason = 'bounce' | 'complaint' | 'manual';

export interface Suppression {
  email: string;
  reason: SuppressionReason;
  project_id: string | null;
  message_id: string | null;
  note: string | null;
  created_at: Date;
}

/** Returns the subset of `emails` (lower-cased) that are on the suppression list. */
export async function findSuppressed(db: Queryable, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
  const { rows } = await db.query<{ email: string }>(
    'SELECT email FROM suppressions WHERE email = ANY($1::text[])',
    [lowered],
  );
  return new Set(rows.map((r) => r.email));
}

export async function addSuppression(
  db: Queryable,
  input: {
    email: string;
    reason: SuppressionReason;
    projectId?: string | null;
    messageId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  // First reason wins; a later complaint does not downgrade/overwrite an earlier record.
  await db.query(
    `INSERT INTO suppressions (email, reason, project_id, message_id, note)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING`,
    [input.email.toLowerCase(), input.reason, input.projectId ?? null, input.messageId ?? null, input.note ?? null],
  );
}

export async function removeSuppression(db: Queryable, email: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM suppressions WHERE email = $1', [email.toLowerCase()]);
  return (rowCount ?? 0) > 0;
}

export async function listSuppressions(
  db: Queryable,
  opts: { limit: number; before?: Date },
): Promise<Suppression[]> {
  const { rows } = await db.query<Suppression>(
    `SELECT * FROM suppressions
     WHERE ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC
     LIMIT $1`,
    [opts.limit, opts.before ?? null],
  );
  return rows;
}
