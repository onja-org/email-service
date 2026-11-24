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

/** True if any project (other than `exceptProjectId`) uses this SES configuration set. */
export async function configSetInUse(db: Queryable, configSet: string, exceptProjectId?: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM projects WHERE config_set = $1 AND id IS DISTINCT FROM $2 LIMIT 1', [
    configSet,
    exceptProjectId ?? null,
  ]);
  return rows.length > 0;
}

export async function getProjectBySlug(db: Queryable, slug: string): Promise<Project> {
  const { rows } = await db.query<Project>('SELECT * FROM projects WHERE slug = $1', [slug]);
  if (!rows[0]) throw notFound(`Project "${slug}"`);
  return rows[0];
}

/**
 * Renames a project and/or changes its slug. The SES configuration set keeps its
 * original name (it is stored on the row), so a slug change needs no SES work and
 * past metrics stay attached. API keys are unaffected.
 */
export async function updateProject(
  db: Queryable,
  slug: string,
  changes: { name?: string; slug?: string },
): Promise<Project> {
  try {
    const { rows } = await db.query<Project>(
      `UPDATE projects SET name = COALESCE($2, name), slug = COALESCE($3, slug)
       WHERE slug = $1 RETURNING *`,
      [slug, changes.name ?? null, changes.slug ?? null],
    );
    if (!rows[0]) throw notFound(`Project "${slug}"`);
    return rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('project_exists', `Project "${changes.slug}" already exists`);
    throw err;
  }
}

export interface DeletedProject {
  project: Project;
  domains: string[];
  counts: { emails: number; templates: number; api_keys: number };
}

/**
 * Deletes a project and everything it owns: domains, API keys (so its senders stop
 * working at once), templates, and its emails with their events and attachments.
 * Suppressions it caused stay on the shared list, unattributed. Returns what was
 * removed so the caller can clean up provider-side resources.
 */
export async function deleteProject(db: Queryable, slug: string): Promise<DeletedProject> {
  const { rows } = await db.query<Project & { domains: string[]; emails: string; templates: string; api_keys: string }>(
    `SELECT p.*,
            COALESCE((SELECT array_agg(domain ORDER BY domain) FROM project_domains WHERE project_id = p.id), '{}') AS domains,
            (SELECT count(*) FROM messages WHERE project_id = p.id) AS emails,
            (SELECT count(*) FROM templates WHERE project_id = p.id) AS templates,
            (SELECT count(*) FROM api_keys WHERE project_id = p.id) AS api_keys
     FROM projects p WHERE p.slug = $1 FOR UPDATE`,
    [slug],
  );
  const row = rows[0];
  if (!row) throw notFound(`Project "${slug}"`);
  await db.query('DELETE FROM projects WHERE id = $1', [row.id]);
  const { domains, emails, templates, api_keys, ...project } = row;
  return { project, domains, counts: { emails: Number(emails), templates: Number(templates), api_keys: Number(api_keys) } };
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

/**
 * Changes a domain's name (e.g. to fix a typo) and/or moves it to another project.
 * Returns null if the domain is not on `projectId`. A moved domain keeps its SES
 * identity, so it stays verified; a renamed one needs a new identity.
 */
export async function updateDomain(
  db: Queryable,
  projectId: string,
  domain: string,
  changes: { domain?: string; projectId?: string },
): Promise<{ domain: string; project_id: string } | null> {
  const next = changes.domain?.toLowerCase();
  try {
    const { rows } = await db.query<{ domain: string; project_id: string }>(
      `UPDATE project_domains SET domain = COALESCE($3, domain), project_id = COALESCE($4, project_id)
       WHERE project_id = $1 AND domain = $2 RETURNING domain, project_id`,
      [projectId, domain.toLowerCase(), next ?? null, changes.projectId ?? null],
    );
    return rows[0] ?? null;
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('domain_taken', `Domain "${next}" is already attached to a project`);
    throw err;
  }
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

export async function renameApiKey(db: Queryable, projectId: string, keyId: string, name: string): Promise<ApiKeyRow | null> {
  const { rows } = await db.query<ApiKeyRow>(
    `UPDATE api_keys SET name = $3 WHERE id = $1 AND project_id = $2
     RETURNING id, project_id, name, prefix, created_at, last_used_at, revoked_at`,
    [keyId, projectId, name],
  );
  return rows[0] ?? null;
}

/** Removes a key for good (active or revoked). An active key stops working at once. */
export async function deleteApiKey(db: Queryable, projectId: string, keyId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM api_keys WHERE id = $1 AND project_id = $2', [keyId, projectId]);
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
