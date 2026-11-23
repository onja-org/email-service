-- File attachments for a message. Kept out of the messages table so list/detail
-- queries (SELECT * FROM messages) never drag the bytes along. Inserted in the
-- same transaction as the message, so the worker never sees one without the other.
CREATE TABLE message_attachments (
  id            bigserial PRIMARY KEY,
  message_id    uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position      int NOT NULL,
  filename      text NOT NULL,
  content_type  text,
  -- Set for inline images referenced from the HTML as <img src="cid:...">.
  content_id    text,
  size_bytes    int NOT NULL,
  content       bytea NOT NULL,
  UNIQUE (message_id, position)
);
