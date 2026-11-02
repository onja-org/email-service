import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Liveness: process is up.
  app.get('/health', async () => ({ status: 'ok' }));

  // Readiness: database reachable.
  app.get('/ready', async (_req, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      app.log.warn({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'degraded', db: 'unreachable' });
    }
  });
};
