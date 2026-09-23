CREATE TABLE IF NOT EXISTS evolution_generations (
  generation INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  run_kind TEXT NOT NULL CHECK (run_kind IN ('manual', 'scheduled')),
  scheduled_for TEXT UNIQUE,
  seed TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('promoted', 'rejected')),
  decision_reason TEXT NOT NULL,
  baseline_score REAL NOT NULL,
  baseline_holdout_score REAL NOT NULL,
  champion_policy_json TEXT NOT NULL,
  champion_score REAL NOT NULL,
  champion_holdout_score REAL NOT NULL,
  candidate_count INTEGER NOT NULL,
  probes_total INTEGER NOT NULL,
  branches_covered INTEGER NOT NULL,
  regression_total INTEGER NOT NULL,
  regression_passed INTEGER NOT NULL,
  new_findings INTEGER NOT NULL,
  test_cases_added INTEGER NOT NULL,
  recommendation_updates INTEGER NOT NULL,
  operator_stats_json TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evolution_generations_created_at_idx
  ON evolution_generations(created_at DESC);

CREATE TABLE IF NOT EXISTS evolution_candidates (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES evolution_generations(generation) ON DELETE CASCADE,
  weights_json TEXT NOT NULL,
  training_score REAL NOT NULL,
  holdout_score REAL NOT NULL,
  branches_covered INTEGER NOT NULL,
  probes INTEGER NOT NULL,
  regression_total INTEGER NOT NULL,
  regression_passed INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('promoted', 'rejected')),
  rejection_reason TEXT,
  findings_json TEXT NOT NULL,
  operator_stats_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS evolution_candidates_generation_idx
  ON evolution_candidates(generation);

CREATE TABLE IF NOT EXISTS test_case_library (
  signature TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('boundary', 'sequence', 'concurrency', 'reduction')),
  specimen_id TEXT NOT NULL,
  reproduction TEXT NOT NULL,
  first_generation INTEGER NOT NULL REFERENCES evolution_generations(generation),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS test_case_library_operator_idx
  ON test_case_library(operator, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS recommendation_rules (
  id TEXT PRIMARY KEY,
  operator TEXT NOT NULL CHECK (operator IN ('boundary', 'sequence', 'concurrency', 'reduction')),
  text TEXT NOT NULL,
  version INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  last_generation INTEGER NOT NULL REFERENCES evolution_generations(generation),
  updated_at TEXT NOT NULL
);
