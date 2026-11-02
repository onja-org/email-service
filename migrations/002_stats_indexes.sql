-- Indexes for the performance dashboard: time-bucketed counts across all projects,
-- and latency (sent_at - created_at) lookups over a time window.
CREATE INDEX messages_created_idx ON messages(created_at DESC);
CREATE INDEX messages_status_created_idx ON messages(status, created_at DESC);
