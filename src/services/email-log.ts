/**
 * The admin email log: search every project's messages by time window, project,
 * sender domain, status, recipient and subject; render a safe preview; and purge
 * messages past the retention period.
 */
import type { Queryable } from '../lib/db.js';
import type { MessageRow, MessageStatus } from './messages.js';

export interface LogFilters {
  /** Inclusive lower bound on created_at. */
  since?: Date;
  /** Exclusive upper bound on created_at. */
  until?: Date;
  projectSlug?: string;
  /** Matches this domain and its subdomains. Must already be validated as a bare domain. */
  domain?: string;
  status?: MessageStatus;
  /** Substring of any to/cc/bcc address, case-insensitive. */
  recipient?: string;
  /** Substring of the subject, case-insensitive. */
  subject?: string;
}

export interface LogRow {
  id: string;
  project_slug: string;
  status: MessageStatus;
  from_address: string;
  from_domain: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  suppressed: string[];
  subject: string;
  template_name: string | null;
  attempts: number;
  last_error: string | null;
  attachment_count: number;
  created_at: Date;
  sent_at: Date | null;
}

/** Builds the WHERE clause; `skipStatus` lets status counts ignore the status filter. */
function where(f: LogFilters, params: unknown[], skipStatus = false): string {
  const parts: string[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (f.since) parts.push(`m.created_at >= ${p(f.since)}`);
  if (f.until) parts.push(`m.created_at < ${p(f.until)}`);
  if (f.projectSlug) parts.push(`p.slug = ${p(f.projectSlug)}`);
  if (f.domain) {
    const d = p(f.domain.toLowerCase());
    // Validated as a bare domain upstream, so it holds no LIKE wildcards.
    parts.push(`(m.from_domain = ${d} OR m.from_domain LIKE '%.' || ${d})`);
  }
  if (f.status && !skipStatus) parts.push(`m.status = ${p(f.status)}::message_status`);
  if (f.recipient) {
    parts.push(
      `EXISTS (SELECT 1 FROM unnest(m.to_addresses || m.cc_addresses || m.bcc_addresses) r
               WHERE strpos(lower(r), lower(${p(f.recipient)})) > 0)`,
    );
  }
  if (f.subject) parts.push(`strpos(lower(m.subject), lower(${p(f.subject)})) > 0`);
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

/**
 * One page of the log, newest first. `cursor` is the id of the last row of the
 * previous page; ordering by (created_at, id) makes pages stable even when many
 * messages share a timestamp.
 */
export async function searchLog(
  db: Queryable,
  f: LogFilters,
  opts: { limit: number; cursor?: string },
): Promise<{ rows: LogRow[]; nextCursor: string | null }> {
  const params: unknown[] = [];
  let clause = where(f, params);
  if (opts.cursor) {
    params.push(opts.cursor);
    const c = `(m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $${params.length})`;
    clause = clause ? `${clause} AND ${c}` : `WHERE ${c}`;
  }
  params.push(opts.limit);
  const { rows } = await db.query<LogRow>(
    `SELECT m.id, p.slug AS project_slug, m.status, m.from_address, m.from_domain,
            m.to_addresses, m.cc_addresses, m.bcc_addresses, m.suppressed, m.subject, m.template_name,
            m.attempts, m.last_error, m.created_at, m.sent_at,
            (SELECT count(*)::int FROM message_attachments a WHERE a.message_id = m.id) AS attachment_count
     FROM messages m JOIN projects p ON p.id = m.project_id
     ${clause}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${params.length}`,
    params,
  );
  return { rows, nextCursor: rows.length === opts.limit ? rows[rows.length - 1].id : null };
}

/** Messages per status for the same filters, ignoring the status filter itself. */
export async function logStatusCounts(db: Queryable, f: LogFilters): Promise<Record<string, number>> {
  const params: unknown[] = [];
  const { rows } = await db.query<{ status: string; n: number }>(
    `SELECT m.status, count(*)::int AS n
     FROM messages m JOIN projects p ON p.id = m.project_id
     ${where(f, params, true)}
     GROUP BY m.status`,
    params,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

// ---- Preview -----------------------------------------------------------------

export interface InlineImage {
  contentId: string;
  contentType: string;
  content: Buffer;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A standalone HTML document showing the email as a recipient would see it.
 * Inline (cid:) images are embedded as data: URIs, because the preview runs in a
 * sandboxed, opaque-origin frame that cannot send the admin session cookie.
 * `<base target="_blank">` turns every link into a popup, which the frame's
 * sandbox blocks: clicking an unsubscribe or tracking link in a preview must
 * never act on the recipient's behalf.
 */
export function buildPreview(m: Pick<MessageRow, 'html' | 'text'>, inline: InlineImage[]): string {
  const head =
    '<meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">' +
    '<style>html{background:#fff;color:#111}</style>';
  if (m.html) {
    const byId = new Map(inline.map((i) => [i.contentId.toLowerCase(), i]));
    const html = m.html.replace(/cid:([^"'\s)>]+)/gi, (match, id: string) => {
      const img = byId.get(decodeURIComponentSafe(id).toLowerCase());
      return img ? `data:${img.contentType};base64,${img.content.toString('base64')}` : match;
    });
    return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  }
  const text = m.text ?? '';
  return (
    `<!doctype html><html><head>${head}</head><body>` +
    `<pre style="white-space:pre-wrap;word-break:break-word;font:14px/1.5 ui-monospace,Menlo,monospace;margin:16px">` +
    `${escapeHtml(text)}</pre></body></html>`
  );
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * CSP for the preview document. `sandbox` (no tokens) gives it an opaque origin
 * with scripts, forms, popups and top navigation all disabled. Remote images stay
 * blocked unless asked for: loading them tells senders' trackers the email was opened.
 */
export function previewCsp(remoteImages: boolean): string {
  return [
    'sandbox',
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${remoteImages ? ' https: http:' : ''}`,
    `font-src data:${remoteImages ? ' https:' : ''}`,
    "frame-ancestors 'self'",
  ].join('; ');
}

/** True if the HTML references remote images, so the UI can offer to load them. */
export function hasRemoteImages(html: string | null): boolean {
  if (!html) return false;
  return (
    /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(html) || // <img src="https://…">
    /\bbackground\s*=\s*["']?\s*https?:/i.test(html) || // <td background="https://…">
    /url\(\s*["']?\s*https?:/i.test(html) // CSS background-image: url(https://…)
  );
}

/** RFC 6266/5987 Content-Disposition for a download, safe for any filename. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---- Retention ---------------------------------------------------------------

/**
 * Deletes messages created more than `days` ago, with their events and
 * attachments (ON DELETE CASCADE), plus SES events that never matched a message.
 * Works in batches so no single statement holds locks for long. Suppressions are
 * kept: they protect the shared sender reputation and only lose their message link.
 */
export async function purgeExpired(
  db: Queryable,
  days: number,
  batchSize = 1000,
): Promise<{ messages: number; orphanEvents: number }> {
  let messages = 0;
  for (;;) {
    const res = await db.query(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE created_at < now() - make_interval(days => $1) LIMIT $2)`,
      [days, batchSize],
    );
    messages += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batchSize) break;
  }
  let orphanEvents = 0;
  for (;;) {
    const res = await db.query(
      `DELETE FROM message_events WHERE id IN (
         SELECT id FROM message_events
         WHERE message_id IS NULL AND created_at < now() - make_interval(days => $1) LIMIT $2)`,
      [days, batchSize],
    );
    orphanEvents += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < batchSize) break;
  }
  return { messages, orphanEvents };
}
