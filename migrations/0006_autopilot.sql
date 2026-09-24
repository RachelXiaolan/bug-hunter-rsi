-- Autopilot: automatic PR submission, follow-ups, repo cooldowns and cost tracking.
ALTER TABLE opportunities ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE opportunities ADD COLUMN last_followup_at TEXT;
ALTER TABLE opportunities ADD COLUMN maintainer_note TEXT;
ALTER TABLE opportunities ADD COLUMN submitted_at TEXT;
ALTER TABLE targets ADD COLUMN blocked_until TEXT;
ALTER TABLE targets ADD COLUMN blocked_reason TEXT;

CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source)
);
