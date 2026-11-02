import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  GetEmailIdentityCommand,
  MessageRejected,
  PutEmailIdentityMailFromAttributesCommand,
  SendEmailCommand,
  SESv2Client,
  SESv2ServiceException,
  type EventType,
} from '@aws-sdk/client-sesv2';
import type { Config } from '../config.js';
import { HttpError } from '../lib/errors.js';

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  configurationSet: string;
  /** Tags appear in SES events, used to correlate events back to our message id. */
  tags: Record<string, string>;
}

export interface SendResult {
  sesMessageId: string;
}

export class SendError extends Error {
  constructor(
    message: string,
    /** Transient errors (throttling, 5xx) are retried; permanent ones fail the message. */
    public readonly retryable: boolean,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'SendError';
  }
}

export interface DnsRecord {
  type: 'CNAME' | 'MX' | 'TXT';
  name: string;
  value: string;
  purpose: string;
}

export interface DomainIdentity {
  domain: string;
  verified: boolean;
  dkimStatus: string;
  mailFromStatus?: string;
  dnsRecords: DnsRecord[];
}

export interface SesService {
  send(email: OutgoingEmail): Promise<SendResult>;
  ensureConfigurationSet(name: string): Promise<void>;
  createDomainIdentity(domain: string): Promise<DomainIdentity>;
  getDomainIdentity(domain: string): Promise<DomainIdentity>;
  deleteDomainIdentity(domain: string): Promise<void>;
}

const EVENT_TYPES: EventType[] = ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT', 'REJECT', 'RENDERING_FAILURE'];

export function createSesService(cfg: Config, log: { info: (o: unknown, m?: string) => void }): SesService {
  const client = new SESv2Client({ region: cfg.AWS_REGION });

  async function send(email: OutgoingEmail): Promise<SendResult> {
    if (cfg.SES_DRY_RUN) {
      log.info({ dryRun: true, to: email.to, subject: email.subject, from: email.from }, 'SES dry run');
      return { sesMessageId: `dry-run-${crypto.randomUUID()}` };
    }
    try {
      const out = await client.send(
        new SendEmailCommand({
          FromEmailAddress: email.from,
          Destination: { ToAddresses: email.to, CcAddresses: email.cc, BccAddresses: email.bcc },
          ReplyToAddresses: email.replyTo.length ? email.replyTo : undefined,
          ConfigurationSetName: email.configurationSet,
          EmailTags: Object.entries(email.tags).map(([Name, Value]) => ({ Name, Value: sanitizeTag(Value) })),
          Content: {
            Simple: {
              Subject: { Data: email.subject, Charset: 'UTF-8' },
              Body: {
                ...(email.html ? { Html: { Data: email.html, Charset: 'UTF-8' } } : {}),
                ...(email.text ? { Text: { Data: email.text, Charset: 'UTF-8' } } : {}),
              },
              Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })),
            },
          },
        }),
      );
      if (!out.MessageId) throw new SendError('SES returned no MessageId', true);
      return { sesMessageId: out.MessageId };
    } catch (err) {
      throw classify(err);
    }
  }

  async function ensureConfigurationSet(name: string): Promise<void> {
    if (cfg.SES_DRY_RUN) {
      log.info({ dryRun: true, configurationSet: name }, 'SES dry run: skipping configuration set');
      return;
    }
    try {
      await client.send(
        new CreateConfigurationSetCommand({
          ConfigurationSetName: name,
          ReputationOptions: { ReputationMetricsEnabled: true },
          SendingOptions: { SendingEnabled: true },
        }),
      );
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    if (!cfg.SNS_EVENTS_TOPIC_ARN) return;
    try {
      await client.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: name,
          EventDestinationName: 'emailsvc-sns',
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: EVENT_TYPES,
            SnsDestination: { TopicArn: cfg.SNS_EVENTS_TOPIC_ARN },
          },
        }),
      );
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  async function createDomainIdentity(domain: string): Promise<DomainIdentity> {
    if (cfg.SES_DRY_RUN) return dryRunIdentity(domain);
    try {
      await client.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: domain,
          DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' },
        }),
      );
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
    // Custom MAIL FROM aligns the Return-Path with the sender domain, which is
    // what makes SPF pass DMARC alignment. Non-fatal if it cannot be set.
    await client
      .send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: domain,
          MailFromDomain: `bounce.${domain}`,
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        }),
      )
      .catch(() => undefined);
    return getDomainIdentity(domain);
  }

  async function getDomainIdentity(domain: string): Promise<DomainIdentity> {
    if (cfg.SES_DRY_RUN) return dryRunIdentity(domain);
    const out = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    const dkimTokens = out.DkimAttributes?.Tokens ?? [];
    const mailFrom = out.MailFromAttributes;
    const dnsRecords: DnsRecord[] = dkimTokens.map((t) => ({
      type: 'CNAME',
      name: `${t}._domainkey.${domain}`,
      value: `${t}.dkim.amazonses.com`,
      purpose: 'DKIM signing',
    }));
    if (mailFrom?.MailFromDomain) {
      dnsRecords.push(
        {
          type: 'MX',
          name: mailFrom.MailFromDomain,
          value: `10 feedback-smtp.${cfg.AWS_REGION}.amazonses.com`,
          purpose: 'Custom MAIL FROM (bounce handling)',
        },
        {
          type: 'TXT',
          name: mailFrom.MailFromDomain,
          value: 'v=spf1 include:amazonses.com ~all',
          purpose: 'SPF for MAIL FROM domain',
        },
      );
    }
    dnsRecords.push({
      type: 'TXT',
      name: `_dmarc.${domain}`,
      value: 'v=DMARC1; p=none;',
      purpose: 'DMARC policy (start with p=none, tighten once sending is verified)',
    });
    return {
      domain,
      verified: out.VerifiedForSendingStatus === true,
      dkimStatus: out.DkimAttributes?.Status ?? 'UNKNOWN',
      mailFromStatus: mailFrom?.MailFromDomainStatus,
      dnsRecords,
    };
  }

  async function deleteDomainIdentity(domain: string): Promise<void> {
    if (cfg.SES_DRY_RUN) return;
    await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain })).catch((err) => {
      if (!(err instanceof SESv2ServiceException && err.name === 'NotFoundException')) throw err;
    });
  }

  function dryRunIdentity(domain: string): DomainIdentity {
    log.info({ dryRun: true, domain }, 'SES dry run: domain identity not created');
    return { domain, verified: true, dkimStatus: 'DRY_RUN', dnsRecords: [] };
  }

  return { send, ensureConfigurationSet, createDomainIdentity, getDomainIdentity, deleteDomainIdentity };
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof SESv2ServiceException && err.name === 'AlreadyExistsException';
}

function classify(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof MessageRejected) {
    return new SendError(err.message, false, err.name);
  }
  if (err instanceof SESv2ServiceException) {
    const status = err.$metadata.httpStatusCode ?? 500;
    const permanent =
      err.name === 'MailFromDomainNotVerifiedException' ||
      err.name === 'AccountSuspendedException' ||
      err.name === 'BadRequestException' ||
      err.name === 'NotFoundException' ||
      (status >= 400 && status < 500 && err.name !== 'TooManyRequestsException' && err.name !== 'LimitExceededException');
    return new SendError(err.message, !permanent, err.name);
  }
  if (err instanceof HttpError) return new SendError(err.message, false, err.code);
  const msg = err instanceof Error ? err.message : String(err);
  return new SendError(msg, true);
}

/** SES tag values allow only ASCII letters, digits, underscores and dashes, up to 256 chars. */
function sanitizeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
}
