/**
 * Small, dependency-free helpers for email addresses.
 * Accepts both "user@example.com" and "Display Name <user@example.com>".
 */

const ADDRESS_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface ParsedAddress {
  /** Original string as supplied (used verbatim in the outgoing message). */
  raw: string;
  /** Lower-cased bare address, e.g. "user@example.com". */
  address: string;
  /** Lower-cased domain part, e.g. "example.com". */
  domain: string;
  name?: string;
}

export function parseAddress(input: string): ParsedAddress | null {
  const raw = input.trim();
  if (!raw) return null;

  let name: string | undefined;
  let bare = raw;

  const m = raw.match(/^(.*)<([^<>]+)>$/);
  if (m) {
    name = m[1].trim().replace(/^"(.*)"$/, '$1') || undefined;
    bare = m[2].trim();
  }

  if (!ADDRESS_RE.test(bare)) return null;

  const address = bare.toLowerCase();
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return { raw, address, domain, name };
}

export function parseAddressList(inputs: string[] | undefined): ParsedAddress[] {
  if (!inputs) return [];
  return inputs.map(parseAddress).filter((a): a is ParsedAddress => a !== null);
}

/** Returns the inputs that could not be parsed as email addresses. */
export function invalidAddresses(inputs: string[] | undefined): string[] {
  if (!inputs) return [];
  return inputs.filter((i) => parseAddress(i) === null);
}

/**
 * True if `fromDomain` is `allowed` or a subdomain of it.
 * A project that owns "example.com" may send from "mail.example.com".
 */
export function domainMatches(fromDomain: string, allowed: string): boolean {
  const a = allowed.toLowerCase();
  const f = fromDomain.toLowerCase();
  return f === a || f.endsWith(`.${a}`);
}

export function isAllowedSender(fromDomain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((d) => domainMatches(fromDomain, d));
}
