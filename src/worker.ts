import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './lib/db.js';
import { backoffSeconds, type Queue, type QueuedJob } from './services/queue.js';
import { SendError, type SesService } from './services/ses.js';
import {
  claimForSending,
  findStaleQueued,
  markFailed,
  markRetry,
  markSent,
  touch,
} from './services/messages.js';

export interface WorkerDeps {
  cfg: Config;
  db: Db;
  queue: Queue;
  ses: SesService;
  log: FastifyBaseLogger;
}

export interface Worker {
  start(): void;
  stop(): Promise<void>;
}

const STALE_SWEEP_INTERVAL_MS = 60_000;
const STALE_AFTER_MINUTES = 10;

/**
 * SQS consumer. One long-poll loop; each batch (up to 10) is processed concurrently.
 * Delivery guarantees:
 *   - a message is sent at most once per claim (DB row lock via UPDATE ... WHERE status)
 *   - transient SES failures are retried with backoff via SQS visibility timeout
 *   - after MAX_SEND_ATTEMPTS the message is marked failed and removed from the queue
 */
export function createWorker(deps: WorkerDeps): Worker {
  const { cfg, db, queue, ses } = deps;
  const log = deps.log.child({ component: 'worker' });
  let running = false;
  let loop: Promise<void> | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;

  async function processJob(q: QueuedJob): Promise<void> {
    const id = q.job.messageId;
    const jlog = log.child({ messageId: id, receiveCount: q.receiveCount });

    const message = await claimForSending(db, id);
    if (!message) {
      jlog.debug('message not claimable (already sent/failed or in flight); dropping job');
      await queue.ack(q);
      return;
    }

    if (message.attempts > cfg.MAX_SEND_ATTEMPTS) {
      await markFailed(db, id, `Gave up after ${message.attempts - 1} attempts: ${message.last_error ?? 'unknown error'}`);
      await queue.ack(q);
      jlog.warn('retries exhausted');
      return;
    }

    const { rows } = await db.query<{ config_set: string; slug: string }>(
      'SELECT config_set, slug FROM projects WHERE id = $1',
      [message.project_id],
    );
    const project = rows[0];
    if (!project) {
      await markFailed(db, id, 'Project no longer exists');
      await queue.ack(q);
      return;
    }

    try {
      const { sesMessageId } = await ses.send({
        from: message.from_address,
        to: message.to_addresses,
        cc: message.cc_addresses,
        bcc: message.bcc_addresses,
        replyTo: message.reply_to,
        subject: message.subject,
        html: message.html ?? undefined,
        text: message.text ?? undefined,
        headers: message.headers,
        configurationSet: project.config_set,
        tags: { emailsvc_message_id: message.id, emailsvc_project: project.slug, ...message.tags },
      });
      await markSent(db, id, sesMessageId);
      await queue.ack(q);
      jlog.info({ sesMessageId, attempt: message.attempts }, 'sent');
    } catch (err) {
      const sendErr = err instanceof SendError ? err : new SendError(String(err), true);
      if (!sendErr.retryable || message.attempts >= cfg.MAX_SEND_ATTEMPTS) {
        await markFailed(db, id, `${sendErr.code ?? 'error'}: ${sendErr.message}`);
        await queue.ack(q);
        jlog.error({ err: sendErr, attempt: message.attempts }, 'send failed permanently');
        return;
      }
      const delay = backoffSeconds(message.attempts);
      await markRetry(db, id, `${sendErr.code ?? 'error'}: ${sendErr.message}`);
      await queue.retryLater(q, delay);
      jlog.warn({ err: sendErr, attempt: message.attempts, retryInSeconds: delay }, 'send failed, will retry');
    }
  }

  async function pollLoop(): Promise<void> {
    while (running) {
      let jobs: QueuedJob[] = [];
      try {
        jobs = await queue.receive();
      } catch (err) {
        log.error({ err }, 'SQS receive failed; backing off');
        await sleep(5_000);
        continue;
      }
      if (jobs.length === 0) continue;
      await Promise.all(
        jobs.map((j) =>
          processJob(j).catch((err) => log.error({ err, messageId: j.job.messageId }, 'unexpected error processing job')),
        ),
      );
    }
  }

  /** Re-enqueue messages that were persisted but never made it to SQS. */
  async function sweepStale(): Promise<void> {
    try {
      const ids = await findStaleQueued(db, STALE_AFTER_MINUTES);
      for (const id of ids) {
        await queue.enqueue({ messageId: id });
        await touch(db, id);
      }
      if (ids.length) log.warn({ count: ids.length }, 're-enqueued stale queued messages');
    } catch (err) {
      log.error({ err }, 'stale sweep failed');
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      log.info({ queue: cfg.SQS_QUEUE_URL, dryRun: cfg.SES_DRY_RUN }, 'worker started');
      loop = pollLoop();
      sweepTimer = setInterval(() => void sweepStale(), STALE_SWEEP_INTERVAL_MS);
      void sweepStale();
    },
    async stop() {
      running = false;
      if (sweepTimer) clearInterval(sweepTimer);
      // The loop exits after the current long-poll (≤ SQS_WAIT_SECONDS) and batch finish.
      await loop;
      log.info('worker stopped');
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
