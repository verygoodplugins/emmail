-- Indexes for the welcome automation's event lookups.
--
-- (contact_id, type): the once-per-contact welcome gate runs on the public
-- ingest path and in the queue consumer.
-- (provider_event_id, type): the welcome webhook path resolves every
-- non-campaign Resend event (delivered/bounced/complained) back to its contact.
--
-- `events` also accumulates opens/clicks/webhooks, so without these both lookups
-- become full table scans as it grows.
CREATE INDEX IF NOT EXISTS idx_events_contact_type ON events (contact_id, type);
CREATE INDEX IF NOT EXISTS idx_events_provider_type ON events (provider_event_id, type);
