-- Bug Hunter v2: real repositories, opportunities, feedback and an evolving playbook.
-- Legacy synthetic tables (evolution_*, live_hunt_*, specimens, runs ...) are left untouched and unused.

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  track TEXT NOT NULL CHECK (track IN ('open-source', 'internal')),
  write_policy TEXT NOT NULL CHECK (write_policy IN ('readonly', 'review', 'pr')),
  source TEXT NOT NULL CHECK (source IN ('config', 'discovered')),
  active INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  last_features_json TEXT,
  last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS playbooks (
  version INTEGER PRIMARY KEY,
  parent INTEGER,
  status TEXT NOT NULL CHECK (status IN ('champion', 'challenger', 'retired', 'rejected')),
  created_at TEXT NOT NULL,
  playbook_json TEXT NOT NULL,
  diff_json TEXT NOT NULL DEFAULT '[]',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('scouting', 'finalized')),
  champion_version INTEGER NOT NULL,
  challenger_version INTEGER,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  llm_status TEXT,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS repo_scans (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  track TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('champion', 'challenger', 'explore', 'internal')),
  playbook_version INTEGER NOT NULL,
  pre_score REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  profile TEXT,
  features_json TEXT,
  facts_json TEXT,
  pain_points_json TEXT,
  llm_status TEXT,
  error TEXT,
  scanned_at TEXT,
  UNIQUE (round_id, repo)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  scan_id TEXT NOT NULL REFERENCES repo_scans(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  track TEXT NOT NULL,
  write_policy TEXT NOT NULL,
  profile TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  effort TEXT NOT NULL,
  confidence REAL NOT NULL,
  priority REAL NOT NULL,
  fix_plan TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  arm TEXT NOT NULL,
  playbook_version INTEGER NOT NULL,
  features_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('discarded', 'verified', 'queued', 'claimed', 'abandoned', 'tests-failed', 'ready-for-review', 'submitted')),
  status_reason TEXT NOT NULL DEFAULT '',
  patch TEXT,
  test_log TEXT,
  pr_url TEXT,
  outcome TEXT CHECK (outcome IN ('merged', 'closed', 'stale') OR outcome IS NULL),
  maintainer_responded INTEGER NOT NULL DEFAULT 0,
  team_verdict TEXT CHECK (team_verdict IN ('useful', 'not-useful') OR team_verdict IS NULL),
  reward REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS opportunities_status_idx ON opportunities(status, priority DESC);
CREATE INDEX IF NOT EXISTS opportunities_created_idx ON opportunities(created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_at_idx ON events(at DESC);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('team', 'maintainer', 'executor')),
  verdict TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS evolution_steps (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  candidate_version INTEGER,
  metrics_json TEXT NOT NULL,
  llm_status TEXT
);

CREATE TABLE IF NOT EXISTS manual_run_limits (
  bucket TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
