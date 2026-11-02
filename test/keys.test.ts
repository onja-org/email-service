import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey } from '../src/lib/keys.js';

describe('api keys', () => {
  it('generates unique prefixed keys whose hash round-trips', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.plaintext.startsWith('es_live_')).toBe(true);
    expect(a.prefix).toBe(a.plaintext.slice(0, 14));
    expect(hashApiKey(a.plaintext)).toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('recognises key-shaped strings', () => {
    expect(looksLikeApiKey(generateApiKey().plaintext)).toBe(true);
    expect(looksLikeApiKey('es_live_short')).toBe(false);
    expect(looksLikeApiKey('Bearer whatever')).toBe(false);
  });
});
