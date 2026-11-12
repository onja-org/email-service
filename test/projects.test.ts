import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/lib/db.js';
import { reconcileConfigurationSets } from '../src/services/projects.js';

describe('reconcileConfigurationSets', () => {
  it('ensures every project\'s configuration set and keeps going past failures', async () => {
    const db = {
      async query() {
        return { rows: [{ slug: 'a', config_set: 'emailsvc-a' }, { slug: 'b', config_set: 'emailsvc-b' }], rowCount: 2 };
      },
    } as unknown as Db;
    const ensureConfigurationSet = vi.fn(async (name: string) => {
      if (name === 'emailsvc-a') throw new Error('boom');
    });
    const log = { info: vi.fn(), warn: vi.fn() };

    await reconcileConfigurationSets(db, { ensureConfigurationSet }, log);

    expect(ensureConfigurationSet.mock.calls.map((c) => c[0])).toEqual(['emailsvc-a', 'emailsvc-b']);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith({ projects: 2 }, 'SES configuration sets reconciled');
  });
});
