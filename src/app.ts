import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Db } from './lib/db.js';
import { HttpError } from './lib/errors.js';
import type { Queue } from './services/queue.js';
import type { SesService } from './services/ses.js';
import { healthRoutes } from './routes/health.js';
import { emailRoutes } from './routes/emails.js';
import { templateRoutes } from './routes/templates.js';
import { suppressionRoutes } from './routes/suppressions.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import { statsRoutes } from './routes/stats.js';
import { dashboardRoutes } from './routes/dashboard.js';

export interface AppDeps {
  cfg: Config;
  db: Db;
  queue: Queue;
  ses: SesService;
  log: Logger;
}

declare module 'fastify' {
  interface FastifyInstance {
    cfg: Config;
    db: Db;
    queue: Queue;
    ses: SesService;
  }
}

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(deps: AppDeps, opts: { fullApi: boolean }) {
  const app = Fastify({
    loggerInstance: deps.log,
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024, // 10 MB: SES max message size is 40 MB, HTML bodies are far smaller
    genReqId: () => crypto.randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('cfg', deps.cfg);
  app.decorate('db', deps.db);
  app.decorate('queue', deps.queue);
  app.decorate('ses', deps.ses);

  // SNS posts JSON with Content-Type text/plain.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(null, body);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError || (err as { validation?: unknown }).validation) {
      const issues = err instanceof ZodError ? err.issues : (err as { validation: unknown }).validation;
      return reply.status(400).send({ error: { code: 'validation_error', message: 'Invalid request', details: issues } });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'request_error',
        message: status >= 500 ? 'Internal error' : (e.message ?? 'Request error'),
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' } });
  });

  await app.register(healthRoutes);
  if (opts.fullApi) {
    await app.register(emailRoutes, { prefix: '/v1' });
    await app.register(templateRoutes, { prefix: '/v1' });
    await app.register(suppressionRoutes, { prefix: '/v1' });
    await app.register(adminRoutes, { prefix: '/admin' });
    await app.register(statsRoutes, { prefix: '/admin/stats' });
    await app.register(webhookRoutes, { prefix: '/webhooks' });
    await app.register(dashboardRoutes);
  }

  return app;
}
