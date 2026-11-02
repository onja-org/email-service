-- Projects: one per internal app/team. Each has its own SES configuration set
-- so bounce/complaint metrics are visible per project.
CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  config_set    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Domains a project is allowed to send from. A domain belongs to exactly one project.
CREATE TABLE project_domains (
  domain        text PRIMARY KEY,
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_domains_project_idx ON project_domains(project_id);

-- API keys. Only a SHA-256 hash is stored; the plaintext is shown once at creation.
CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  prefix        text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_project_idx ON api_keys(project_id);

-- Templates are owned by the service (not SES) so they can be versioned and rendered
-- with Handlebars before sending.
CREATE TABLE templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  subject       text NOT NULL,
  html          text,
  text          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

-- Every send request becomes a message row. Status lifecycle:
--   queued -> sending -> sent -> (delivered | bounced | complained)
--   queued -> suppressed            (all recipients on the suppression list)
--   queued/sending -> failed        (SES rejected it or retries exhausted)
CREATE TYPE message_status AS ENUM (
  'queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed'
);

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key  text,
  status           message_status NOT NULL DEFAULT 'queued',
  from_address     text NOT NULL,
  reply_to         text[] NOT NULL DEFAULT '{}',
  to_addresses     text[] NOT NULL,
  cc_addresses     text[] NOT NULL DEFAULT '{}',
  bcc_addresses    text[] NOT NULL DEFAULT '{}',
  suppressed       text[] NOT NULL DEFAULT '{}',
  subject          text NOT NULL,
  html             text,
  text             text,
  template_name    text,
  template_data    jsonb,
  headers          jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ses_message_id   text,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX messages_project_created_idx ON messages(project_id, created_at DESC);
CREATE INDEX messages_ses_id_idx ON messages(ses_message_id) WHERE ses_message_id IS NOT NULL;
CREATE INDEX messages_status_idx ON messages(status) WHERE status IN ('queued', 'sending');

-- Delivery events reported by SES (via SNS): delivery, bounce, complaint, etc.
CREATE TABLE message_events (
  id            bigserial PRIMARY KEY,
  message_id    uuid REFERENCES messages(id) ON DELETE CASCADE,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_events_message_idx ON message_events(message_id);

-- Global suppression list. An address that hard-bounces or complains for any
-- project is never emailed again by any project. Protects the shared reputation.
CREATE TABLE suppressions (
  email         text PRIMARY KEY,
  reason        text NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  message_id    uuid REFERENCES messages(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
