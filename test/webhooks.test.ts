/**
 * POST /webhooks/ses with the SNS signature check mocked out, so the topic guard,
 * subscription handshake and event application are exercised over HTTP.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { buildApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { Db } from '../src/lib/db.js';
import type { Queue } from '../src/services/queue.js';
import type { SesService } from '../src/services/ses.js';

// Signature verification needs Amazon's certificate; stand in with "valid unless Signature === 'bad'".
vi.mock('sns-validator', () => ({
  default: class {
    validate(hash: Record<string, unknown>, cb: (err: Error | null, message?: Record<string, unknown>) => void) {
      if (hash.Signature === 'bad') cb(new Error('The message signature is invalid.'));
      else cb(null, hash);
    }
  },
}));

const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:emailsvc-events';
const baseCfg = {
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
} satisfies Config;

const message = {
  id: '11111111-1111-1111-1111-111111111111',
  project_id: '00000000-0000-0000-0000-000000000001',
  status: 'sent',
  ses_message_id: 'ses-123',
};

/** Records what the webhook writes: events, status transitions, suppressions. */
function fakeDb() {
  const events: { messageId: string | null; type: string }[] = [];
  const statusUpdates: { id: string; to: string }[] = [];
  const suppressions: { email: string; reason: string; messageId: string | null }[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK' || s === 'SELECT 1') return { rows: [], rowCount: 0 };
      if (s.startsWith('SELECT * FROM messages WHERE ses_message_id')) {
        return params[0] === message.ses_message_id ? { rows: [message], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.startsWith('SELECT * FROM messages WHERE id = $1')) {
        return params[0] === message.id ? { rows: [message], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (s.startsWith('INSERT INTO message_events')) {
        events.push({ messageId: params[0] as string | null, type: params[1] as string });
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('UPDATE messages SET status = $2')) {
        statusUpdates.push({ id: params[0] as string, to: params[1] as string });
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('INSERT INTO suppressions')) {
        suppressions.push({ email: params[0] as string, reason: params[1] as string, messageId: params[3] as string | null });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fakeDb: unexpected query: ${s}`);
    },
    release() {},
  };
  const db = { query: client.query, connect: async () => client } as unknown as Db;
  return { db, events, statusUpdates, suppressions };
}

const noQueue = { async enqueue() {}, async receive() { return []; }, async ack() {}, async retryLater() {} } as Queue;

async function build(cfg: Config) {
  const state = fakeDb();
  const app = await buildApp({ cfg, db: state.db, queue: noQueue, ses: {} as SesService, log: pino({ level: 'silent' }) }, { fullApi: true });
  await app.ready();
  return { app, ...state };
}

function envelope(over: Record<string, unknown>) {
  return {
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: TOPIC,
    Timestamp: new Date().toISOString(),
    Signature: 'ok',
    SigningCertURL: 'https://sns.eu-west-1.amazonaws.com/cert.pem',
    ...over,
  };
}

const post = (app: App, payload: unknown) =>
  app.inject({ method: 'POST', url: '/webhooks/ses', headers: { 'content-type': 'text/plain' }, payload: JSON.stringify(payload) });

describe('POST /webhooks/ses', () => {
  let configured: Awaited<ReturnType<typeof build>>;
  let unconfigured: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    configured = await build({ ...baseCfg, SNS_EVENTS_TOPIC_ARN: TOPIC });
    unconfigured = await build({ ...baseCfg });
  });
  afterAll(async () => {
    await configured.app.close();
    await unconfigured.app.close();
  });

  it('refuses to act when no topic ARN is configured', async () => {
    const res = await post(unconfigured.app, envelope({ Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'ses-123' } }) }));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('webhook_not_configured');
    expect(unconfigured.events).toEqual([]);
  });

  it('rejects bad signatures and messages from other topics', async () => {
    const bad = await post(configured.app, envelope({ Signature: 'bad', Message: '{}' }));
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_sns_signature');

    const other = await post(configured.app, envelope({ TopicArn: TOPIC.replace('emailsvc', 'someone-else'), Message: '{}' }));
    expect(other.statusCode).toBe(400);
    expect(other.json().error.code).toBe('unexpected_topic');
    expect(configured.events).toEqual([]);
  });

  it('confirms subscriptions only via AWS-hosted URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    try {
      const ok = await post(configured.app, envelope({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=t' }));
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ confirmed: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const evil = await post(configured.app, envelope({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.example.com/steal' }));
      expect(evil.statusCode).toBe(400);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('applies a permanent bounce: records the event, advances status, suppresses the recipient', async () => {
    const res = await post(
      configured.app,
      envelope({
        Message: JSON.stringify({
          eventType: 'Bounce',
          mail: { messageId: 'ses-123', tags: { emailsvc_message_id: [message.id] } },
          bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'Gone@Example.com' }] },
        }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: true, type: 'Bounce' });
    expect(configured.events).toEqual([{ messageId: message.id, type: 'Bounce' }]);
    expect(configured.statusUpdates).toEqual([{ id: message.id, to: 'bounced' }]);
    expect(configured.suppressions).toEqual([{ email: 'gone@example.com', reason: 'bounce', messageId: message.id }]);
  });

  it('still records events for messages it cannot match, and ignores non-JSON notifications', async () => {
    const before = configured.events.length;
    const unknown = await post(configured.app, envelope({ Message: JSON.stringify({ eventType: 'Delivery', mail: { messageId: 'not-ours' } }) }));
    expect(unknown.statusCode).toBe(200);
    expect(configured.events[before]).toEqual({ messageId: null, type: 'Delivery' });

    const plain = await post(configured.app, envelope({ Message: 'hello from the SNS console' }));
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toEqual({ ignored: true });
  });
});
