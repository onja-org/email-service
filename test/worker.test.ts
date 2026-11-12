/**
 * Worker job handling with in-memory fakes: the claim/ack/retry decisions that
 * decide whether a message can be lost or sent twice.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Config } from '../src/config.js';
import type { Db } from '../src/lib/db.js';
import type { Queue, QueuedJob } from '../src/services/queue.js';
import { SendError, type SesService } from '../src/services/ses.js';
import type { MessageRow } from '../src/services/messages.js';
import { createWorker } from '../src/worker.js';

const cfg = { MAX_SEND_ATTEMPTS: 3, SES_DRY_RUN: true, SQS_QUEUE_URL: 'http://unused' } as Config;
const project = { id: 'p1', slug: 'billing', config_set: 'emailsvc-billing' };

function row(over: Partial<MessageRow>): MessageRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    project_id: project.id,
    idempotency_key: null,
    status: 'queued',
    from_address: 'no-reply@billing.example.com',
    reply_to: [],
    to_addresses: ['ada@example.com'],
    cc_addresses: [],
    bcc_addresses: [],
    suppressed: [],
    subject: 'Hi',
    html: null,
    text: 'Hi',
    template_name: null,
    template_data: null,
    headers: {},
    tags: { emailsvc_message_id: 'spoofed', invoice: '42' },
    ses_message_id: null,
    attempts: 0,
    last_error: null,
    created_at: new Date(),
    updated_at: new Date(),
    sent_at: null,
    ...over,
  };
}

/** Minimal state machine standing in for the messages table. */
function fakeDb(initial: MessageRow) {
  let m = initial;
  const calls: string[] = [];
  const db = {
    async query(sql: string) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push(s.split(' ').slice(0, 3).join(' '));
      if (s.startsWith('UPDATE messages SET status = \'sending\'')) {
        const stale = m.status === 'sending' && Date.now() - m.updated_at.getTime() > 5 * 60_000;
        if (m.status !== 'queued' && !stale) return { rows: [], rowCount: 0 };
        m = { ...m, status: 'sending', attempts: m.attempts + 1, updated_at: new Date() };
        return { rows: [m], rowCount: 1 };
      }
      if (s.startsWith('SELECT * FROM messages WHERE id = $1')) return { rows: [m], rowCount: 1 };
      if (s.startsWith('SELECT config_set, slug FROM projects')) return { rows: [project], rowCount: 1 };
      if (s.includes("THEN 'sent'")) {
        m = { ...m, status: m.status === 'sending' ? 'sent' : m.status, ses_message_id: 'ses-1', sent_at: new Date() };
        return { rows: [], rowCount: 1 };
      }
      if (s.includes("SET status = 'queued'")) { m = { ...m, status: 'queued' }; return { rows: [], rowCount: 1 }; }
      if (s.includes("SET status = 'failed'")) { m = { ...m, status: 'failed' }; return { rows: [], rowCount: 1 }; }
      throw new Error(`fakeDb: unexpected query: ${s}`);
    },
  } as unknown as Db;
  return { db, current: () => m, calls };
}

function fakeQueue() {
  const acked: string[] = [];
  const retried: { id: string; delay: number }[] = [];
  const queue: Queue = {
    async enqueue() {},
    async receive() { return []; },
    async ack(j) { acked.push(j.job.messageId); },
    async retryLater(j, delay) { retried.push({ id: j.job.messageId, delay }); },
  };
  return { queue, acked, retried };
}

const job = (id: string): QueuedJob => ({ job: { messageId: id }, receiptHandle: 'rh', receiveCount: 1 });

/** Drive one job through the worker by having receive() yield it exactly once. */
async function runOnce(db: Db, q: ReturnType<typeof fakeQueue>, ses: SesService, j: QueuedJob) {
  let served = false;
  q.queue.receive = async () => {
    if (served) { await worker.stop(); return []; }
    served = true;
    return [j];
  };
  const worker = createWorker({ cfg, db, queue: q.queue, ses, log: pino({ level: 'silent' }) });
  worker.start();
  await worker.stop();
}

describe('worker.processJob', () => {
  it('claims, sends with our correlation tags winning, marks sent and acks', async () => {
    const m = row({});
    const { db, current } = fakeDb(m);
    const q = fakeQueue();
    const ses = { send: vi.fn(async () => ({ sesMessageId: 'ses-1' })) } as unknown as SesService;

    await runOnce(db, q, ses, job(m.id));

    expect(ses.send).toHaveBeenCalledTimes(1);
    const sent = (ses.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as { tags: Record<string, string> };
    expect(sent.tags).toEqual({ invoice: '42', emailsvc_message_id: m.id, emailsvc_project: 'billing' });
    expect(current().status).toBe('sent');
    expect(q.acked).toEqual([m.id]);
    expect(q.retried).toEqual([]);
  });

  it('keeps the job (hidden for > the lease) when another worker is mid-send', async () => {
    const m = row({ status: 'sending', attempts: 1, updated_at: new Date() });
    const { db, current } = fakeDb(m);
    const q = fakeQueue();
    const ses = { send: vi.fn() } as unknown as SesService;

    await runOnce(db, q, ses, job(m.id));

    expect(ses.send).not.toHaveBeenCalled();
    expect(q.acked).toEqual([]);
    expect(q.retried).toEqual([{ id: m.id, delay: 330 }]);
    expect(current().status).toBe('sending');
  });

  it('re-claims a message whose worker died mid-send once the lease has expired', async () => {
    const m = row({ status: 'sending', attempts: 1, updated_at: new Date(Date.now() - 6 * 60_000) });
    const { db, current } = fakeDb(m);
    const q = fakeQueue();
    const ses = { send: vi.fn(async () => ({ sesMessageId: 'ses-2' })) } as unknown as SesService;

    await runOnce(db, q, ses, job(m.id));

    expect(ses.send).toHaveBeenCalledTimes(1);
    expect(current()).toMatchObject({ status: 'sent', attempts: 2 });
    expect(q.acked).toEqual([m.id]);
  });

  it('drops duplicate deliveries of a finished message without calling SES', async () => {
    const m = row({ status: 'sent', attempts: 1 });
    const { db } = fakeDb(m);
    const q = fakeQueue();
    const ses = { send: vi.fn() } as unknown as SesService;

    await runOnce(db, q, ses, job(m.id));

    expect(ses.send).not.toHaveBeenCalled();
    expect(q.acked).toEqual([m.id]);
    expect(q.retried).toEqual([]);
  });

  it('retries transient failures with backoff and fails permanent ones', async () => {
    const transient = row({});
    const t = fakeDb(transient);
    const tq = fakeQueue();
    await runOnce(t.db, tq, { send: vi.fn(async () => { throw new SendError('throttled', true, 'TooManyRequestsException'); }) } as unknown as SesService, job(transient.id));
    expect(t.current().status).toBe('queued');
    expect(tq.retried).toEqual([{ id: transient.id, delay: 30 }]);
    expect(tq.acked).toEqual([]);

    const permanent = row({});
    const p = fakeDb(permanent);
    const pq = fakeQueue();
    await runOnce(p.db, pq, { send: vi.fn(async () => { throw new SendError('rejected', false, 'MessageRejected'); }) } as unknown as SesService, job(permanent.id));
    expect(p.current().status).toBe('failed');
    expect(pq.acked).toEqual([permanent.id]);
  });
});
