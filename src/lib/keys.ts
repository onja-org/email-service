import { createHash, randomBytes } from 'node:crypto';

const KEY_PREFIX = 'es_live_';

export interface GeneratedKey {
  /** Full plaintext key. Shown to the caller once and never stored. */
  plaintext: string;
  /** First characters of the key, stored so keys can be identified in the UI. */
  prefix: string;
  /** SHA-256 hex digest stored in the database. */
  hash: string;
}

export function generateApiKey(): GeneratedKey {
  const secret = randomBytes(24).toString('base64url');
  const plaintext = `${KEY_PREFIX}${secret}`;
  return { plaintext, prefix: plaintext.slice(0, KEY_PREFIX.length + 6), hash: hashApiKey(plaintext) };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(KEY_PREFIX) && value.length > KEY_PREFIX.length + 16;
}
