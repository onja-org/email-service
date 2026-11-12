import { describe, expect, it } from 'vitest';
import { domainMatches, invalidAddresses, isAllowedSender, parseAddress, parseAddressList } from '../src/lib/email.js';

describe('parseAddress', () => {
  it('parses a bare address', () => {
    expect(parseAddress('User@Example.com')).toEqual({
      raw: 'User@Example.com',
      address: 'user@example.com',
      domain: 'example.com',
      name: undefined,
    });
  });

  it('parses a display-name address', () => {
    const a = parseAddress('"Acme Support" <support@acme.io>');
    expect(a?.name).toBe('Acme Support');
    expect(a?.address).toBe('support@acme.io');
    expect(a?.domain).toBe('acme.io');
    expect(a?.raw).toBe('"Acme Support" <support@acme.io>');
  });

  it('rejects header-injection characters anywhere in the address', () => {
    expect(parseAddress('Ada\r\nBcc: x@y.z <ada@example.com>')).toBeNull();
    expect(parseAddress('Ada\r <ada@example.com>')).toBeNull();
    expect(parseAddress('ada@example.com\n')).not.toBeNull(); // trailing whitespace is trimmed, not an injection
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'nope', 'a@b', 'a @b.com', '<a@b.com', 'a@b.com>', 'x@y@z.com']) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe('address lists', () => {
  it('filters invalid entries and reports them', () => {
    const input = ['ok@example.com', 'bad', 'Also OK <two@example.org>'];
    expect(parseAddressList(input).map((a) => a.address)).toEqual(['ok@example.com', 'two@example.org']);
    expect(invalidAddresses(input)).toEqual(['bad']);
    expect(invalidAddresses(undefined)).toEqual([]);
  });
});

describe('domain matching', () => {
  it('matches exact and subdomains, case-insensitively', () => {
    expect(domainMatches('example.com', 'Example.COM')).toBe(true);
    expect(domainMatches('mail.example.com', 'example.com')).toBe(true);
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
    expect(domainMatches('example.com', 'mail.example.com')).toBe(false);
  });

  it('isAllowedSender checks any allowed domain', () => {
    expect(isAllowedSender('app.acme.io', ['other.com', 'acme.io'])).toBe(true);
    expect(isAllowedSender('acme.io', [])).toBe(false);
  });
});
