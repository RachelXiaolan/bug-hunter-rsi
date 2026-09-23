CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('manual', 'scheduled')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  checks_total INTEGER NOT NULL,
  harness_passed INTEGER NOT NULL,
  fixtures_detected INTEGER NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_finished_at_idx ON runs(finished_at DESC);

CREATE TABLE IF NOT EXISTS specimens (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  reproduction TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'sample'
);

CREATE INDEX IF NOT EXISTS specimens_first_seen_at_idx ON specimens(first_seen_at DESC);

CREATE TABLE IF NOT EXISTS run_findings (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  specimen_id TEXT NOT NULL REFERENCES specimens(id),
  PRIMARY KEY (run_id, specimen_id)
);

CREATE TABLE IF NOT EXISTS design_revisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  run_id TEXT REFERENCES runs(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'framework'
);

CREATE INDEX IF NOT EXISTS design_revisions_created_at_idx ON design_revisions(created_at DESC);

CREATE TABLE IF NOT EXISTS manual_run_limits (
  bucket TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO system_state(key, value, updated_at)
VALUES ('framework_version', '0.1.0', '2026-09-23T00:00:00.000Z');
