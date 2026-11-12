import type { Queryable } from '../lib/db.js';
import { generateApiKey, hashApiKey } from '../lib/keys.js';
import { conflict, notFound } from '../lib/errors.js';
import type { SesService } from './ses.js';

export interface Project {
  id: string;
  slug: string;
  name: string;
  config_set: string;
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

/** The project resolved from an API key, with the domains it may send from. */
export interface AuthContext {
  project: Project;
  apiKeyId: string;
  domains: string[];
}

export async function createProject(
  db: Queryable,
  input: { slug: string; name: string; configSet: string },
): Promise<Project> {
  try {
    const { rows } = await db.query<Project>(
      'INSERT INTO projects (slug, name, config_set) VALUES ($1, $2, $3) RETURNING *',
      [input.slug, input.name, input.configSet],
    );
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('project_exists', `Project "${input.slug}" already exists`);
    throw err;
  }
}

/**
 * Makes sure every project's SES configuration set exists and publishes events
 * to the configured SNS topic. Run at startup: a project created before
 * SNS_EVENTS_TOPIC_ARN was set would otherwise never get an event destination,
 * so its bounces and complaints would never reach the suppression list.
 */
export async function reconcileConfigurationSets(
  db: Queryable,
  ses: Pick<SesService, 'ensureConfigurationSet'>,
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void },
): Promise<void> {
  const { rows } = await db.query<{ slug: string; config_set: string }>('SELECT slug, config_set FROM projects');
  for (const p of rows) {
    try {
      await ses.ensureConfigurationSet(p.config_set);
    } catch (err) {
      log.warn({ err, project: p.slug, configSet: p.config_set }, 'could not reconcile SES configuration set');
    }
  }
  if (rows.length) log.info({ projects: rows.length }, 'SES configuration sets reconciled');
}

export async function getProjectBySlug(db: Queryable, slug: string): Promise<Project> {
  const { rows } = await db.query<Project>('SELECT * FROM projects WHERE slug = $1', [slug]);
  if (!rows[0]) throw notFound(`Project "${slug}"`);
  return rows[0];
}

export async function listProjects(db: Queryable): Promise<(Project & { domains: string[] })[]> {
  const { rows } = await db.query<Project & { domains: string[] }>(
    `SELECT p.*, COALESCE(array_agg(d.domain ORDER BY d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}') AS domains
     FROM projects p LEFT JOIN project_domains d ON d.project_id = p.id
     GROUP BY p.id ORDER BY p.slug`,
  );
  return rows;
}

export async function listDomains(db: Queryable, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ domain: string }>(
    'SELECT domain FROM project_domains WHERE project_id = $1 ORDER BY domain',
    [projectId],
  );
  return rows.map((r) => r.domain);
}

export async function addDomain(db: Queryable, projectId: string, domain: string): Promise<void> {
  const d = domain.toLowerCase();
  try {
    await db.query('INSERT INTO project_domains (project_id, domain) VALUES ($1, $2)', [projectId, d]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      const { rows } = await db.query<{ project_id: string }>(
        'SELECT project_id FROM project_domains WHERE domain = $1',
        [d],
      );
      if (rows[0]?.project_id === projectId) return; // already attached to this project, idempotent
      throw conflict('domain_taken', `Domain "${d}" belongs to another project`);
    }
    throw err;
  }
}

export async function removeDomain(db: Queryable, projectId: string, domain: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM project_domains WHERE project_id = $1 AND domain = $2', [
    projectId,
    domain.toLowerCase(),
  ]);
  return (rowCount ?? 0) > 0;
}

export async function createApiKey(
  db: Queryable,
  projectId: string,
  name: string,
): Promise<{ key: ApiKeyRow; plaintext: string }> {
  const gen = generateApiKey();
  const { rows } = await db.query<ApiKeyRow>(
    `INSERT INTO api_keys (project_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, name, prefix, created_at, last_used_at, revoked_at`,
    [projectId, name, gen.prefix, gen.hash],
  );
  return { key: rows[0], plaintext: gen.plaintext };
}

export async function listApiKeys(db: Queryable, projectId: string): Promise<ApiKeyRow[]> {
  const { rows } = await db.query<ApiKeyRow>(
    `SELECT id, project_id, name, prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

export async function revokeApiKey(db: Queryable, projectId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL',
    [keyId, projectId],
  );
  return (rowCount ?? 0) > 0;
}

/** Resolves a plaintext API key to its project. Returns null for unknown/revoked keys. */
export async function authenticateApiKey(db: Queryable, plaintext: string): Promise<AuthContext | null> {
  const hash = hashApiKey(plaintext);
  const { rows } = await db.query<Project & { api_key_id: string; domains: string[] }>(
    `SELECT p.*, k.id AS api_key_id,
            COALESCE(array_agg(d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}') AS domains
     FROM api_keys k
     JOIN projects p ON p.id = k.project_id
     LEFT JOIN project_domains d ON d.project_id = p.id
     WHERE k.key_hash = $1 AND k.revoked_at IS NULL
     GROUP BY p.id, k.id`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  // Fire-and-forget; a failed timestamp update must not fail the request.
  void db.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.api_key_id]).catch(() => undefined);
  const { api_key_id, domains, ...project } = row;
  return { project, apiKeyId: api_key_id, domains };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
