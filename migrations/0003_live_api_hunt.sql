CREATE TABLE IF NOT EXISTS live_hunt_runs (
  id TEXT PRIMARY KEY,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('manual', 'scheduled')),
  scheduled_for TEXT UNIQUE,
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  target TEXT NOT NULL,
  probe_count INTEGER NOT NULL,
  confirmed_count INTEGER NOT NULL,
  new_count INTEGER NOT NULL,
  policy_before_json TEXT NOT NULL,
  policy_after_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  ai_status TEXT NOT NULL,
  ai_probe_count INTEGER NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_hunt_evidence (
  run_id TEXT NOT NULL REFERENCES live_hunt_runs(id) ON DELETE CASCADE,
  probe_id TEXT NOT NULL,
  request TEXT NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT NOT NULL,
  status INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  inconclusive INTEGER NOT NULL,
  PRIMARY KEY (run_id, probe_id)
);

CREATE TABLE IF NOT EXISTS live_hunt_findings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  reproduction TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  expected TEXT NOT NULL,
  actual TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open'
);
