import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { Config } from '../config.js';

export interface SendJob {
  messageId: string;
}

export interface QueuedJob {
  job: SendJob;
  receiptHandle: string;
  /** How many times SQS has delivered this message (1 on first delivery). */
  receiveCount: number;
}

export interface Queue {
  enqueue(job: SendJob): Promise<void>;
  receive(): Promise<QueuedJob[]>;
  ack(job: QueuedJob): Promise<void>;
  /** Make the job visible again after `delaySeconds` (retry with backoff). */
  retryLater(job: QueuedJob, delaySeconds: number): Promise<void>;
}

export function createQueue(cfg: Config): Queue {
  const client = new SQSClient({
    region: cfg.AWS_REGION,
    ...(cfg.SQS_ENDPOINT ? { endpoint: cfg.SQS_ENDPOINT } : {}),
  });
  const QueueUrl = cfg.SQS_QUEUE_URL;

  return {
    async enqueue(job) {
      await client.send(
        new SendMessageCommand({
          QueueUrl,
          MessageBody: JSON.stringify(job),
          // Deduplicate at the application level via messages.id; a duplicate
          // delivery is harmless because the worker checks status before sending.
        }),
      );
    },

    async receive() {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl,
          MaxNumberOfMessages: cfg.SQS_BATCH_SIZE,
          WaitTimeSeconds: cfg.SQS_WAIT_SECONDS,
          MessageSystemAttributeNames: ['ApproximateReceiveCount'],
        }),
      );
      return (out.Messages ?? []).flatMap((m) => {
        const parsed = parseJob(m);
        return parsed ? [parsed] : [];
      });
    },

    async ack(job) {
      await client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: job.receiptHandle }));
    },

    async retryLater(job, delaySeconds) {
      await client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl,
          ReceiptHandle: job.receiptHandle,
          VisibilityTimeout: Math.min(Math.max(delaySeconds, 0), 43_200),
        }),
      );
    },
  };
}

function parseJob(m: Message): QueuedJob | null {
  if (!m.Body || !m.ReceiptHandle) return null;
  try {
    const body = JSON.parse(m.Body) as Partial<SendJob>;
    if (typeof body.messageId !== 'string') return null;
    return {
      job: { messageId: body.messageId },
      receiptHandle: m.ReceiptHandle,
      receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? '1'),
    };
  } catch {
    return null;
  }
}

/** Exponential backoff: 30s, 60s, 120s, ... capped at 15 minutes. */
export function backoffSeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(attempt - 1, 0), 900);
}
