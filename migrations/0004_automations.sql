-- Multi-step automations: trigger → ordered steps (send_email / wait / add_tag)
-- with per-contact enrollments. Delayed steps use next_run_at + queue delay or
-- the Worker cron sweeper for waits longer than the queue delay max (12h).

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  trigger_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_steps (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  step_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (automation_id, position),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS automation_enrollments (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  current_position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  next_run_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_id, contact_id),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_automations_trigger_enabled
  ON automations (trigger_type, enabled);

CREATE INDEX IF NOT EXISTS idx_enrollments_due
  ON automation_enrollments (status, next_run_at);

CREATE INDEX IF NOT EXISTS idx_enrollments_automation
  ON automation_enrollments (automation_id, status);
