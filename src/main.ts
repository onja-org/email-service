import pino from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './lib/db.js';
import { createQueue } from './services/queue.js';
import { createSesService } from './services/ses.js';
import { buildApp } from './app.js';
import { createWorker } from './worker.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.LOG_LEVEL });
  const db = createDb(cfg.DATABASE_URL);
  const queue = createQueue(cfg);
  const ses = createSesService(cfg, log);

  const runApi = cfg.MODE === 'api' || cfg.MODE === 'all';
  const runWorker = cfg.MODE === 'worker' || cfg.MODE === 'all';

  const app = await buildApp({ cfg, db, queue, ses, log }, { fullApi: runApi });
  const worker = runWorker ? createWorker({ cfg, db, queue, ses, log }) : null;

  await db.query('SELECT 1');
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  worker?.start();
  log.info({ mode: cfg.MODE, region: cfg.AWS_REGION, port: cfg.PORT }, 'email-service ready');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      log.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000).unref();
    try {
      await app.close(); // stop accepting requests, finish in-flight ones
      await worker?.stop(); // finish the current batch
      await db.end();
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
