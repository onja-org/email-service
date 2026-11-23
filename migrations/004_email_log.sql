-- Email log: filter messages by sender domain, newest first.
-- from_address is "addr@domain" or "Name <addr@domain>"; the domain is lower-cased
-- and stored so the admin log can filter (and index) on it.
ALTER TABLE messages ADD COLUMN from_domain text;

UPDATE messages
SET from_domain = lower(substring(from_address FROM '@([^@<>[:space:]]+)>?[[:space:]]*$'))
WHERE from_domain IS NULL;

-- Anything the pattern could not parse (should be none: addresses are validated on send).
UPDATE messages SET from_domain = '' WHERE from_domain IS NULL;

-- Fill from_domain when an INSERT leaves it out. The previous release's code keeps
-- serving traffic for a short while after this migration runs (zero-downtime deploy),
-- and its INSERTs don't name the column; without this they would hit NOT NULL.
CREATE FUNCTION messages_fill_from_domain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.from_domain IS NULL THEN
    NEW.from_domain := coalesce(
      lower(substring(NEW.from_address FROM '@([^@<>[:space:]]+)>?[[:space:]]*$')), '');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER messages_fill_from_domain BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_fill_from_domain();

ALTER TABLE messages ALTER COLUMN from_domain SET NOT NULL;

CREATE INDEX messages_from_domain_created_idx ON messages(from_domain, created_at DESC);
-- Keyset pagination for the log orders by (created_at, id).
CREATE INDEX messages_created_id_idx ON messages(created_at DESC, id DESC);
-- Retention purge of events that never matched a message.
CREATE INDEX message_events_created_idx ON message_events(created_at) WHERE message_id IS NULL;
