/**
 * HTTP-level smoke test. Postgres, SQS and SES are replaced with in-memory fakes
 * so the Fastify wiring (auth, validation, error format, send pipeline) is exercised
 * end-to-end without infrastructure.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/lib/db.js';
import { generateApiKey } from '../src/lib/keys.js';
import type { Queue, SendJob } from '../src/services/queue.js';
import type { SesService } from '../src/services/ses.js';

const cfg: Config = {
  NODE_ENV: 'test',
  MODE: 'api',
  PORT: 0,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unused',
  AWS_REGION: 'eu-west-1',
  SQS_QUEUE_URL: 'http://unused',
  SQS_WAIT_SECONDS: 0,
  SQS_BATCH_SIZE: 1,
  MAX_SEND_ATTEMPTS: 3,
  SES_DRY_RUN: true,
  SES_CONFIG_SET_PREFIX: 'emailsvc',
  ADMIN_TOKEN: 'test-admin-token-0123456789',
};

const key = generateApiKey();
const project = { id: '00000000-0000-0000-0000-000000000001', slug: 'billing', name: 'Billing', config_set: 'emailsvc-billing', created_at: new Date() };
const otherProjectId = '00000000-0000-0000-0000-000000000002';
/** email -> suppression row (only the fields the routes read). */
const suppressions = new Map<string, { email: string; reason: string; project_id: string | null }>([
  ['blocked@example.com', { email: 'blocked@example.com', reason: 'bounce', project_id: otherProjectId }],
  ['complainer@example.com', { email: 'complainer@example.com', reason: 'complaint', project_id: project.id }],
  ['other-manual@example.com', { email: 'other-manual@example.com', reason: 'manual', project_id: otherProjectId }],
  ['own-manual@example.com', { email: 'own-manual@example.com', reason: 'manual', project_id: project.id }],
]);
const inserted: Record<string, unknown>[] = [];
const enqueued: SendJob[] = [];

/** Tiny SQL-pattern router standing in for pg. */
const fakeDb = {
  async query(sql: string, params: unknown[] = []) {
    const s = sql.replace(/\s+/g, ' ');
    if (s === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (s.includes('FROM api_keys k')) {
      return params[0] === key.hash
        ? { rows: [{ ...project, api_key_id: 'k1', domains: ['billing.example.com'] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('UPDATE api_keys SET last_used_at')) return { rows: [], rowCount: 1 };
    if (s.includes('FROM suppressions WHERE email = ANY')) {
      const hits = (params[0] as string[]).filter((e) => suppressions.has(e)).map((email) => ({ email }));
      return { rows: hits, rowCount: hits.length };
    }
    if (s === "DELETE FROM suppressions WHERE email = $1 AND reason = 'manual' AND project_id = $2") {
      const row = suppressions.get(params[0] as string);
      const ok = !!row && row.reason === 'manual' && row.project_id === params[1];
      if (ok) suppressions.delete(params[0] as string);
      return { rows: [], rowCount: ok ? 1 : 0 };
    }
    if (s === 'SELECT * FROM suppressions WHERE email = $1') {
      const row = suppressions.get(params[0] as string);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('INSERT INTO messages')) {
      const row = {
        id: `00000000-0000-0000-0000-${String(inserted.length + 1).padStart(12, '0')}`,
        project_id: params[0],
        idempotency_key: params[1],
        status: params[2],
        from_address: params[3],
        reply_to: params[4],
        to_addresses: params[5],
        cc_addresses: params[6],
        bcc_addresses: params[7],
        suppressed: params[8],
        subject: params[9],
        html: params[10],
        text: params[11],
        template_name: params[12],
        template_data: params[13],
        headers: JSON.parse(params[14] as string),
        tags: JSON.parse(params[15] as string),
        ses_message_id: null,
        attempts: 0,
        last_error: null,
        created_at: new Date(),
        updated_at: new Date(),
        sent_at: null,
      };
      inserted.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM messages WHERE id = $1')) {
      const row = inserted.find((m) => m.id === params[0] && m.project_id === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`fakeDb: unexpected query: ${s}`);
  },
} as unknown as Db;

const fakeQueue: Queue = {
  async enqueue(job) {
    enqueued.push(job);
  },
  async receive() {
    return [];
  },
  async ack() {},
  async retryLater() {},
};

const fakeSes = {} as SesService;

let app: App;
beforeAll(async () => {
  app = await buildApp({ cfg, db: fakeDb, queue: fakeQueue, ses: fakeSes, log: pino({ level: 'silent' }) }, { fullApi: true });
  await app.ready();
});
afterAll(() => app.close());

const auth = { authorization: `Bearer ${key.plaintext}` };
const validBody = {
  from: 'Billing <no-reply@billing.example.com>',
  to: ['ada@example.com'],
  subject: 'Hello',
  text: 'Hi',
};

describe('health', () => {
  it('GET /health and /ready', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });
});

describe('auth', () => {
  it('rejects missing and unknown keys with 401', async () => {
    const none = await app.inject({ method: 'POST', url: '/v1/emails', payload: validBody });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');

    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: { authorization: `Bearer ${generateApiKey().plaintext}` },
      payload: validBody,
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('protects /admin with the admin token', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/projects', headers: auth })).statusCode).toBe(401);
  });
});

describe('POST /v1/emails', () => {
  it('queues a valid email and enqueues a job', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: auth, payload: validBody });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('queued');
    expect(body.from).toBe(validBody.from);
    expect(body.html).toBeUndefined(); // list/summary shape omits bodies
    expect(enqueued).toEqual([{ messageId: body.id }]);

    const detail = await app.inject({ method: 'GET', url: `/v1/emails/${body.id}`, headers: auth });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().text).toBe('Hi');
  });

  it('returns 400 with validation details for a malformed body', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/emails', headers: auth, payload: { to: 'not-an-array' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('returns 403 when sending from a domain the project does not own', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: auth,
      payload: { ...validBody, from: 'ceo@gmail.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('sender_domain_not_allowed');
  });

  it('drops suppressed recipients and marks fully-suppressed messages', async () => {
    const before = enqueued.length;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: auth,
      payload: { ...validBody, to: ['blocked@example.com'] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('suppressed');
    expect(res.json().suppressed_recipients).toEqual(['blocked@example.com']);
    expect(enqueued.length).toBe(before); // nothing queued

    const mixed = await app.inject({
      method: 'POST',
      url: '/v1/emails',
      headers: auth,
      payload: { ...validBody, to: ['blocked@example.com', 'ok@example.com'] },
    });
    expect(mixed.json().status).toBe('queued');
    expect(mixed.json().to).toEqual(['ok@example.com']);
  });

  it('serves the dashboard page and protects the stats API', async () => {
    const page = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<title>Email delivery</title>');
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(302);

    const noToken = await app.inject({ method: 'GET', url: '/admin/stats/summary' });
    expect(noToken.statusCode).toBe(401);
    const badWindow = await app.inject({
      method: 'GET',
      url: '/admin/stats/summary?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      headers: { authorization: `Bearer ${cfg.ADMIN_TOKEN}` },
    });
    expect(badWindow.statusCode).toBe(400);
    expect(badWindow.json().error.code).toBe('invalid_window');
  });

  it('404s for another project\'s message id and unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/emails/00000000-0000-0000-0000-00000000ffff', headers: auth });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/nope' })).json().error.code).toBe('not_found');
  });
});

describe('DELETE /v1/suppressions/:email', () => {
  const del = (email: string) =>
    app.inject({ method: 'DELETE', url: `/v1/suppressions/${encodeURIComponent(email)}`, headers: auth });

  it('removes a manual suppression the project added itself', async () => {
    expect((await del('own-manual@example.com')).statusCode).toBe(204);
    expect(suppressions.has('own-manual@example.com')).toBe(false);
  });

  it('refuses to lift bounce and complaint suppressions', async () => {
    const bounce = await del('blocked@example.com');
    expect(bounce.statusCode).toBe(403);
    expect(bounce.json().error.code).toBe('suppression_not_removable');

    // Even when the complaint came from this project's own mail.
    expect((await del('complainer@example.com')).statusCode).toBe(403);
    expect(suppressions.has('blocked@example.com')).toBe(true);
    expect(suppressions.has('complainer@example.com')).toBe(true);
  });

  it("refuses to remove another project's manual suppression", async () => {
    expect((await del('other-manual@example.com')).statusCode).toBe(403);
    expect(suppressions.has('other-manual@example.com')).toBe(true);
  });

  it('404s for an address that is not suppressed', async () => {
    expect((await del('nobody@example.com')).statusCode).toBe(404);
  });
});
