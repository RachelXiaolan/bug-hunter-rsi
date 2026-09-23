CREATE TABLE IF NOT EXISTS live_hunt_fix_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES live_hunt_runs(id) ON DELETE CASCADE,
  finding_id TEXT NOT NULL REFERENCES live_hunt_findings(id),
  resolved_at TEXT NOT NULL,
  evidence TEXT NOT NULL,
  UNIQUE(run_id, finding_id)
);

CREATE INDEX IF NOT EXISTS live_hunt_fix_events_recent_idx
  ON live_hunt_fix_events(resolved_at DESC);
