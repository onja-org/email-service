import type { FastifyPluginAsync } from 'fastify';
import MessageValidator from 'sns-validator';
import { badRequest } from '../lib/errors.js';
import { applySesEvent, type SesEvent } from '../services/events.js';

interface SnsEnvelope {
  Type: 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  SubscribeURL?: string;
  Timestamp: string;
  Signature: string;
  SigningCertURL: string;
}

const validator = new MessageValidator();

function verifySns(body: unknown): Promise<SnsEnvelope> {
  return new Promise((resolve, reject) => {
    validator.validate(body as Record<string, unknown>, (err, message) => {
      if (err) reject(badRequest('invalid_sns_signature', `SNS signature validation failed: ${err.message}`));
      else resolve(message as unknown as SnsEnvelope);
    });
  });
}

/**
 * Receives SES events via SNS HTTPS subscription:
 *   SES configuration set -> event destination (SNS topic) -> POST /webhooks/ses
 * Every request's signature is verified against Amazon's signing certificate, so
 * this endpoint needs no shared secret.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post('/ses', async (req, reply) => {
    if (typeof req.body !== 'object' || req.body === null) throw badRequest('invalid_body', 'Expected SNS JSON');
    const env = await verifySns(req.body);

    if (app.cfg.SNS_EVENTS_TOPIC_ARN && env.TopicArn !== app.cfg.SNS_EVENTS_TOPIC_ARN) {
      req.log.warn({ topic: env.TopicArn }, 'SNS message from unexpected topic');
      throw badRequest('unexpected_topic', 'Message is not from the configured SNS topic');
    }

    if (env.Type === 'SubscriptionConfirmation') {
      const url = new URL(env.SubscribeURL ?? '');
      if (!url.hostname.endsWith('.amazonaws.com')) throw badRequest('bad_subscribe_url', 'Refusing non-AWS SubscribeURL');
      const res = await fetch(url);
      req.log.info({ topic: env.TopicArn, status: res.status }, 'confirmed SNS subscription');
      return reply.status(200).send({ confirmed: res.ok });
    }

    if (env.Type === 'Notification') {
      let event: SesEvent;
      try {
        event = JSON.parse(env.Message) as SesEvent;
      } catch {
        // Not an SES event (e.g. a plain-text test publish). Acknowledge so SNS stops retrying.
        req.log.warn({ snsMessageId: env.MessageId }, 'ignoring non-JSON SNS notification');
        return reply.status(200).send({ ignored: true });
      }
      const result = await applySesEvent(app.db, event);
      req.log.info(
        { type: result.type, sesMessageId: result.sesMessageId, status: result.newStatus, suppressed: result.suppress.length },
        'SES event processed',
      );
      return reply.status(200).send({ processed: true, type: result.type });
    }

    return reply.status(200).send({ ignored: true });
  });
};
