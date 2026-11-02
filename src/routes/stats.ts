import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAdmin } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { getProblems, getProjectStats, getSummary, getTimeseries, pickBucket, type StatsWindow } from '../services/stats.js';

const windowQuery = z.object({
  /** ISO timestamps. Defaults: last 7 days ending now. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  project: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/).optional(),
});

const MAX_WINDOW_DAYS = 400;

function resolveWindow(q: z.infer<typeof windowQuery>): StatsWindow {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 7 * 86_400_000);
  if (from >= to) throw badRequest('invalid_window', '"from" must be before "to"');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86_400_000) {
    throw badRequest('window_too_large', `Window may not exceed ${MAX_WINDOW_DAYS} days`);
  }
  return { from, to, project: q.project };
}

/**
 * Read-only metrics for the performance dashboard. Admin-token protected.
 * All endpoints accept the same window (from, to, project) so every panel agrees.
 */
export const statsRoutes: FastifyPluginAsync = async (instance) => {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  app.addHook('preHandler', requireAdmin);

  app.get('/summary', { schema: { querystring: windowQuery } }, async (req) =>
    getSummary(app.db, resolveWindow(req.query)),
  );

  app.get(
    '/timeseries',
    { schema: { querystring: windowQuery.extend({ bucket: z.enum(['hour', 'day']).optional() }) } },
    async (req) => {
      const w = resolveWindow(req.query);
      return getTimeseries(app.db, w, req.query.bucket ?? pickBucket(w));
    },
  );

  app.get('/projects', { schema: { querystring: windowQuery } }, async (req) => ({
    data: await getProjectStats(app.db, resolveWindow(req.query)),
  }));

  app.get(
    '/problems',
    { schema: { querystring: windowQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(50) }) } },
    async (req) => ({ data: await getProblems(app.db, resolveWindow(req.query), req.query.limit) }),
  );
};
