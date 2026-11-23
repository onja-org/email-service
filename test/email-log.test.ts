import { describe, expect, it } from 'vitest';
import type { Queryable } from '../src/lib/db.js';
import {
  attachmentDisposition,
  buildPreview,
  hasRemoteImages,
  previewCsp,
  purgeExpired,
  searchLog,
} from '../src/services/email-log.js';

describe('buildPreview', () => {
  it('embeds inline cid: images as data URIs and leaves unknown cids alone', () => {
    const doc = buildPreview(
      { html: '<img src="cid:Logo"><img src="cid:missing">', text: null },
      [{ contentId: 'logo', contentType: 'image/png', content: Buffer.from([1, 2, 3]) }],
    );
    expect(doc).toContain('<img src="data:image/png;base64,AQID">');
    expect(doc).toContain('<img src="cid:missing">');
  });

  it('neutralises links and referrers', () => {
    const doc = buildPreview({ html: '<a href="https://x.test/unsubscribe">u</a>', text: null }, []);
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('escapes text-only emails instead of rendering them as HTML', () => {
    const doc = buildPreview({ html: null, text: 'a < b & <script>x</script>' }, []);
    expect(doc).toContain('a &lt; b &amp; &lt;script&gt;x&lt;/script&gt;');
    expect(doc).not.toContain('<script>');
  });
});

describe('preview headers', () => {
  it('sandboxes the preview and only allows remote images when asked', () => {
    const strict = previewCsp(false);
    expect(strict.split('; ')[0]).toBe('sandbox');
    expect(strict).toContain("default-src 'none'");
    expect(strict).toContain('img-src data:;');
    expect(strict).toContain("frame-ancestors 'self'");
    expect(strict).not.toContain('script-src');
    expect(previewCsp(true)).toContain('img-src data: https: http:');
  });

  it('detects remote images', () => {
    expect(hasRemoteImages('<p><IMG alt="x" src="https://cdn.test/a.png"></p>')).toBe(true);
    expect(hasRemoteImages('<img src="cid:logo"> <a href="https://x.test">x</a>')).toBe(false);
    expect(hasRemoteImages(null)).toBe(false);
    expect(hasRemoteImages('<div style="background-image:url(\'https://cdn.test/bg.png\')">')).toBe(true);
    expect(hasRemoteImages('<td background="http://cdn.test/bg.png">')).toBe(true);
  });

  it('builds a safe Content-Disposition for any filename', () => {
    expect(attachmentDisposition('report "final".pdf')).toBe(
      `attachment; filename="report _final_.pdf"; filename*=UTF-8''report%20%22final%22.pdf`,
    );
    expect(attachmentDisposition('facture-été.pdf')).toContain("filename*=UTF-8''facture-%C3%A9t%C3%A9.pdf");
  });
});

/** Records SQL and params; returns canned results. */
function recordingDb(results: { rows: unknown[]; rowCount?: number }[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      return results.shift() ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe('searchLog', () => {
  it('binds every filter as a parameter and pages by (created_at, id)', async () => {
    const { db, calls } = recordingDb([{ rows: [{ id: 'a' }, { id: 'b' }] }]);
    const since = new Date('2026-11-01T00:00:00Z');
    const until = new Date('2026-11-02T00:00:00Z');
    const out = await searchLog(
      db,
      { since, until, projectSlug: 'billing', domain: 'Acme.io', status: 'bounced', recipient: 'ada', subject: '50%_off' },
      { limit: 2, cursor: '11111111-1111-1111-1111-111111111111' },
    );
    expect(out.nextCursor).toBe('b');
    const { sql, params } = calls[0];
    expect(params).toEqual([since, until, 'billing', 'acme.io', 'bounced', 'ada', '50%_off', '11111111-1111-1111-1111-111111111111', 2]);
    expect(sql).toContain("(m.from_domain = $4 OR m.from_domain LIKE '%.' || $4)");
    expect(sql).toContain('strpos(lower(m.subject), lower($7)) > 0');
    expect(sql).toContain('(m.created_at, m.id) < (SELECT created_at, id FROM messages WHERE id = $8)');
    expect(sql).toContain('ORDER BY m.created_at DESC, m.id DESC LIMIT $9');
  });

  it('returns no cursor on the last page', async () => {
    const { db } = recordingDb([{ rows: [{ id: 'a' }] }]);
    expect((await searchLog(db, {}, { limit: 50 })).nextCursor).toBeNull();
  });
});

describe('purgeExpired', () => {
  it('deletes in batches until a short batch, then purges orphan events', async () => {
    const { db, calls } = recordingDb([{ rows: [], rowCount: 2 }, { rows: [], rowCount: 1 }, { rows: [], rowCount: 0 }]);
    expect(await purgeExpired(db, 90, 2)).toEqual({ messages: 3, orphanEvents: 0 });
    expect(calls.map((c) => c.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'DELETE FROM messages',
      'DELETE FROM messages',
      'DELETE FROM message_events',
    ]);
    expect(calls[0].params).toEqual([90, 2]);
  });
});
