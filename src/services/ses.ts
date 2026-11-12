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
  /** Fully qualified record name, e.g. "abc._domainkey.example.com". */
  name: string;
  /**
   * The name relative to the domain, e.g. "abc._domainkey" or "@" for the root:
   * what registrar panels (Namecheap, GoDaddy, Cloudflare…) expect in their
   * "Host" field, since they append the domain themselves. Entering the full
   * name there silently creates "abc._domainkey.example.com.example.com".
   */
  host: string;
  value: string;
  purpose: string;
}

/** "abc._domainkey.example.com" within "example.com" → "abc._domainkey"; the root → "@". */
export function relativeHost(name: string, domain: string): string {
  const n = name.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase();
  if (n === d) return '@';
  return n.endsWith(`.${d}`) ? n.slice(0, -(d.length + 1)) : name;
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
              ...(Object.keys(email.headers).length
                ? { Headers: Object.entries(email.headers).map(([Name, Value]) => ({ Name, Value })) }
                : {}),
            },
          },
        }),
      );
      if (!out.MessageId) throw new SendError('SES returned no MessageId', true);
      return { sesMessageId: out.MessageId };
    } catch (err) {
      throw classifySendError(err);
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
    const rec = (type: DnsRecord['type'], name: string, value: string, purpose: string): DnsRecord => ({
      type,
      name,
      host: relativeHost(name, domain),
      value,
      purpose,
    });
    const dnsRecords: DnsRecord[] = dkimTokens.map((t) =>
      rec('CNAME', `${t}._domainkey.${domain}`, `${t}.dkim.amazonses.com`, 'DKIM signing (required for verification)'),
    );
    if (mailFrom?.MailFromDomain) {
      dnsRecords.push(
        rec('MX', mailFrom.MailFromDomain, `10 feedback-smtp.${cfg.AWS_REGION}.amazonses.com`, 'Custom MAIL FROM (bounce handling)'),
        rec('TXT', mailFrom.MailFromDomain, 'v=spf1 include:amazonses.com ~all', 'SPF for MAIL FROM domain'),
      );
    }
    dnsRecords.push(
      rec('TXT', `_dmarc.${domain}`, 'v=DMARC1; p=none;', 'DMARC policy: skip if one already exists (a domain must have exactly one)'),
    );
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

export function classifySendError(err: unknown): SendError {
  if (err instanceof SendError) return err;
  if (err instanceof MessageRejected) {
    // "Email address is not verified" is usually permanent, but SES also reports it
    // for a short while after an identity is created or changed (seen right after
    // attaching an already-verified domain). Retrying with backoff covers that window;
    // a genuinely unverified sender still ends up failed after MAX_SEND_ATTEMPTS.
    const transientlyUnverified = /not verified/i.test(err.message);
    return new SendError(err.message, transientlyUnverified, err.name);
  }
  if (err instanceof SESv2ServiceException) {
    const status = err.$metadata.httpStatusCode ?? 500;
    // Account-level pause (SES or an operator switched sending off) clears without
    // touching the message, so keep retrying rather than failing every email.
    if (err.name === 'SendingPausedException') return new SendError(err.message, true, err.name);
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
