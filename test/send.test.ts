import { describe, expect, it } from 'vitest';
import { prepareEmail } from '../src/services/send.js';
import { HttpError } from '../src/lib/errors.js';
import type { AuthContext } from '../src/services/projects.js';

const auth: AuthContext = {
  project: { id: 'p1', slug: 'billing', name: 'Billing', config_set: 'emailsvc-billing', created_at: new Date() },
  apiKeyId: 'k1',
  domains: ['acme.io'],
};

function errorOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('prepareEmail', () => {
  it('accepts a valid message from an allowed (sub)domain', () => {
    const out = prepareEmail(
      {
        from: 'Billing <no-reply@mail.acme.io>',
        to: ['Ada <ada@example.com>'],
        cc: ['cc@example.com'],
        reply_to: ['help@acme.io'],
        subject: 'Invoice',
        text: 'Hello',
        headers: { 'X-Entity-Ref-ID': 'abc' },
        tags: { invoice: '42' },
      },
      auth,
    );
    expect(out.fromDomain).toBe('mail.acme.io');
    expect(out.to).toEqual(['Ada <ada@example.com>']);
    expect(out.cc).toEqual(['cc@example.com']);
    expect(out.bcc).toEqual([]);
    expect(out.replyTo).toEqual(['help@acme.io']);
    expect(out.headers).toEqual({ 'X-Entity-Ref-ID': 'abc' });
    expect(out.tags).toEqual({ invoice: '42' });
  });

  it('rejects senders outside the project domains with 403', () => {
    const err = errorOf(() => prepareEmail({ from: 'x@gmail.com', to: ['a@b.co'], subject: 's', text: 't' }, auth));
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('sender_domain_not_allowed');
    expect(err.message).toContain('acme.io');
  });

  it('rejects look-alike domains', () => {
    const err = errorOf(() => prepareEmail({ from: 'x@notacme.io', to: ['a@b.co'], subject: 's', text: 't' }, auth));
    expect(err.code).toBe('sender_domain_not_allowed');
  });

  it('reports every invalid recipient', () => {
    const err = errorOf(() =>
      prepareEmail({ from: 'x@acme.io', to: ['ok@b.co', 'bad'], cc: ['also bad'], subject: 's', text: 't' }, auth),
    );
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('invalid_recipient');
    expect(err.details).toEqual({ addresses: ['bad', 'also bad'] });
  });

  it('requires subject and a body unless a template is used', () => {
    expect(errorOf(() => prepareEmail({ from: 'x@acme.io', to: ['a@b.co'], text: 't' }, auth)).code).toBe('missing_subject');
    expect(errorOf(() => prepareEmail({ from: 'x@acme.io', to: ['a@b.co'], subject: 's' }, auth)).code).toBe('missing_body');
    expect(() => prepareEmail({ from: 'x@acme.io', to: ['a@b.co'], template: 'welcome' }, auth)).not.toThrow();
  });

  it('blocks reserved and malformed headers', () => {
    const base = { from: 'x@acme.io', to: ['a@b.co'], subject: 's', text: 't' };
    expect(errorOf(() => prepareEmail({ ...base, headers: { From: 'evil@x.com' } }, auth)).code).toBe('reserved_header');
    expect(errorOf(() => prepareEmail({ ...base, headers: { 'X-Ok': 'a\r\nBcc: b@c.d' } }, auth)).code).toBe('invalid_header');
    expect(errorOf(() => prepareEmail({ ...base, headers: { 'X Bad': 'v' } }, auth)).code).toBe('invalid_header');
  });

  it('enforces the SES 50-recipient limit', () => {
    const to = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`);
    expect(errorOf(() => prepareEmail({ from: 'x@acme.io', to, subject: 's', text: 't' }, auth)).code).toBe(
      'too_many_recipients',
    );
  });
});
