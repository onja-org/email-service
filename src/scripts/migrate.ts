/**
 * Minimal forward-only SQL migration runner.
 *   npm run migrate              (dev, via tsx)
 *   node dist/scripts/migrate.js (in the container)
 * Applies migrations/*.sql in filename order, once each, inside a transaction.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works both from src/scripts (tsx) and dist/scripts (compiled).
const migrationsDir = path.resolve(here, '..', '..', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Serialize concurrent runners (e.g. two replicas starting at once).
    await client.query('SELECT pg_advisory_lock(727227)');

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`applying ${file}... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }
    console.log(`up to date (${files.length} migrations)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727227)').catch(() => undefined);
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
