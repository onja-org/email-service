import pg from 'pg';

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createDb(connectionString: string, opts: { ssl?: boolean } = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    // Managed providers terminate TLS with certificates that are not in Node's CA bundle.
    ...(opts.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. server restart). The pool recovers on next query.
    console.error('pg pool error', err);
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
