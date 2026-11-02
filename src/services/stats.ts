import type { Queryable } from '../lib/db.js';

export interface StatsWindow {
  from: Date;
  to: Date;
  /** Restrict to one project (slug). Omit for all projects. */
  project?: string;
}

export interface Counts {
  submitted: number;
  /** Accepted by SES: sent + delivered + bounced + complained. */
  accepted: number;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
}

export interface Rates {
  /** delivered / accepted. Needs SES event publishing (SNS webhook) to be non-zero. */
  delivery: number | null;
  bounce: number | null;
  complaint: number | null;
  /** failed / submitted */
  failure: number | null;
}

export interface Latency {
  /** Seconds from API submission to SES acceptance. */
  p50: number | null;
  p95: number | null;
  avg: number | null;
}

export interface Summary {
  window: { from: string; to: string; project: string | null };
  current: Counts;
  previous: Counts;
  rates: Rates;
  latency: Latency;
  queue: { queued: number; sending: number; oldest_queued_seconds: number | null };
}

export interface TimeseriesRow {
  bucket: string;
  project: string;
  submitted: number;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
}

export interface ProjectRow extends Counts {
  slug: string;
  name: string;
  domains: string[];
  rates: Rates;
  last_sent_at: string | null;
  queued: number;
}

export interface ProblemRow {
  id: string;
  project: string;
  status: string;
  to_addresses: string[];
  subject: string;
  last_error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

const COUNT_COLUMNS = `
  count(*)::int                                                       AS submitted,
  count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS accepted,
  count(*) FILTER (WHERE status = 'sent')::int                        AS sent,
  count(*) FILTER (WHERE status = 'delivered')::int                   AS delivered,
  count(*) FILTER (WHERE status = 'bounced')::int                     AS bounced,
  count(*) FILTER (WHERE status = 'complained')::int                  AS complained,
  count(*) FILTER (WHERE status = 'failed')::int                      AS failed,
  count(*) FILTER (WHERE status = 'suppressed')::int                  AS suppressed`;

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function computeRates(c: Counts): Rates {
  return {
    delivery: ratio(c.delivered, c.accepted),
    bounce: ratio(c.bounced, c.accepted),
    complaint: ratio(c.complained, c.accepted),
    failure: ratio(c.failed, c.submitted),
  };
}

/** Previous window of equal length immediately before `w`, for deltas. */
export function previousWindow(w: StatsWindow): StatsWindow {
  const len = w.to.getTime() - w.from.getTime();
  return { from: new Date(w.from.getTime() - len), to: w.from, project: w.project };
}

/** hour buckets up to 3 days, otherwise day buckets. */
export function pickBucket(w: StatsWindow): 'hour' | 'day' {
  return w.to.getTime() - w.from.getTime() <= 3 * 86_400_000 ? 'hour' : 'day';
}

async function counts(db: Queryable, w: StatsWindow): Promise<Counts> {
  const { rows } = await db.query<Counts>(
    `SELECT ${COUNT_COLUMNS}
     FROM messages m
     WHERE m.created_at >= $1 AND m.created_at < $2
       AND ($3::text IS NULL OR m.project_id = (SELECT id FROM projects WHERE slug = $3))`,
    [w.from, w.to, w.project ?? null],
  );
  return rows[0];
}

export async function getSummary(db: Queryable, w: StatsWindow): Promise<Summary> {
  const [current, previous, latencyRes, queueRes] = await Promise.all([
    counts(db, w),
    counts(db, previousWindow(w)),
    db.query<{ p50: number | null; p95: number | null; avg: number | null }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM sent_at - created_at)) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM sent_at - created_at)) AS p95,
              avg(EXTRACT(EPOCH FROM sent_at - created_at)) AS avg
       FROM messages
       WHERE sent_at IS NOT NULL AND created_at >= $1 AND created_at < $2
         AND ($3::text IS NULL OR project_id = (SELECT id FROM projects WHERE slug = $3))`,
      [w.from, w.to, w.project ?? null],
    ),
    db.query<{ queued: number; sending: number; oldest: number | null }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int  AS queued,
              count(*) FILTER (WHERE status = 'sending')::int AS sending,
              EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'queued')) AS oldest
       FROM messages
       WHERE status IN ('queued','sending')
         AND ($1::text IS NULL OR project_id = (SELECT id FROM projects WHERE slug = $1))`,
      [w.project ?? null],
    ),
  ]);
  const lat = latencyRes.rows[0];
  const q = queueRes.rows[0];
  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString(), project: w.project ?? null },
    current,
    previous,
    rates: computeRates(current),
    latency: { p50: num(lat.p50), p95: num(lat.p95), avg: num(lat.avg) },
    queue: { queued: q.queued, sending: q.sending, oldest_queued_seconds: num(q.oldest) },
  };
}

export async function getTimeseries(
  db: Queryable,
  w: StatsWindow,
  bucket: 'hour' | 'day',
): Promise<{ bucket: 'hour' | 'day'; rows: TimeseriesRow[] }> {
  const { rows } = await db.query<TimeseriesRow>(
    `SELECT date_trunc($4, m.created_at) AS bucket, p.slug AS project,
            count(*)::int AS submitted,
            count(*) FILTER (WHERE status IN ('sent','delivered','bounced','complained'))::int AS accepted,
            count(*) FILTER (WHERE status = 'delivered')::int  AS delivered,
            count(*) FILTER (WHERE status = 'bounced')::int    AS bounced,
            count(*) FILTER (WHERE status = 'complained')::int AS complained,
            count(*) FILTER (WHERE status = 'failed')::int     AS failed
     FROM messages m JOIN projects p ON p.id = m.project_id
     WHERE m.created_at >= $1 AND m.created_at < $2
       AND ($3::text IS NULL OR p.slug = $3)
     GROUP BY 1, 2
     ORDER BY 1, 2`,
    [w.from, w.to, w.project ?? null, bucket],
  );
  return { bucket, rows: rows.map((r) => ({ ...r, bucket: new Date(r.bucket).toISOString() })) };
}

export async function getProjectStats(db: Queryable, w: StatsWindow): Promise<ProjectRow[]> {
  const { rows } = await db.query<Omit<ProjectRow, 'rates'>>(
    `SELECT p.slug, p.name,
            COALESCE((SELECT array_agg(domain ORDER BY domain) FROM project_domains d WHERE d.project_id = p.id), '{}') AS domains,
            ${COUNT_COLUMNS.replace(/\bstatus\b/g, 'm.status')},
            max(m.sent_at) AS last_sent_at,
            (SELECT count(*)::int FROM messages q WHERE q.project_id = p.id AND q.status = 'queued') AS queued
     FROM projects p
     LEFT JOIN messages m ON m.project_id = p.id AND m.created_at >= $1 AND m.created_at < $2
     GROUP BY p.id
     ORDER BY submitted DESC, p.slug`,
    [w.from, w.to],
  );
  return rows.map((r) => ({
    ...r,
    last_sent_at: r.last_sent_at ? new Date(r.last_sent_at).toISOString() : null,
    rates: computeRates(r),
  }));
}

export async function getProblems(db: Queryable, w: StatsWindow, limit: number): Promise<ProblemRow[]> {
  const { rows } = await db.query<ProblemRow>(
    `SELECT m.id, p.slug AS project, m.status, m.to_addresses, m.subject, m.last_error, m.attempts,
            m.created_at, m.updated_at
     FROM messages m JOIN projects p ON p.id = m.project_id
     WHERE m.status IN ('failed','bounced','complained')
       AND m.created_at >= $1 AND m.created_at < $2
       AND ($3::text IS NULL OR p.slug = $3)
     ORDER BY m.updated_at DESC
     LIMIT $4`,
    [w.from, w.to, w.project ?? null, limit],
  );
  return rows;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
