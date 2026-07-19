-- The welcome automation gates on events(contact_id, type) on the public ingest
-- path and again in the queue consumer. `events` also accumulates opens/clicks/
-- webhooks, so without this index that gate becomes a full table scan as the
-- table grows. Keep the lookup bounded.
CREATE INDEX IF NOT EXISTS idx_events_contact_type ON events (contact_id, type);
