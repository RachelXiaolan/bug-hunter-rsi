# Bug Hunter RSI Engine Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fixed daily sample run with a safe, bounded, evidence-driven test-strategy evolution cycle and show each generation in the live design page.

**Architecture:** Keep the evolutionary core pure and deterministic in `src/evolution.js`; evaluate five bounded weight mutations over a closed synthetic benchmark, preserve regression cases, and promote only strict improvements with a perfect regression gate. Persist generations, strategy snapshots, specimens, and design revisions in D1; make both the Cron handler and manual action call the same cycle; render persisted truth from `/api/state`.

**Tech Stack:** Cloudflare Workers, D1/SQLite migrations, Workers Static Assets, Node built-in test runner, vanilla HTML/CSS/JavaScript.

---

### Task 1: Evolution behavior contracts

**Files:**
- Create: `tests/evolution.test.mjs`
- Create: `src/evolution.js`

**Steps:**
1. Write tests for deterministic-but-generation-specific candidates, exact weight normalization, bounded probe counts, preservation of all regression specimens, and promotion refusal on regression/holdout failure.
2. Run `node --test tests/evolution.test.mjs`; confirm each fails because `src/evolution.js` does not exist.
3. Implement the pure bounded benchmark and evolution decision API; no Worker or D1 code in this module.
4. Re-run targeted tests, then the full project test suite.

### Task 2: Persistent evolution ledger

**Files:**
- Create: `migrations/0002_rsi_generations.sql`
- Modify: `src/index.js`

**Steps:**
1. Define D1 tables for generation decisions, candidate evaluations, test cases, and versioned recommendation-rule evidence; add unique constraints for generation and candidate identity.
2. Add state reads for current policy, recent seven generations, test-library growth, current recommendation rules, and the current page revision.
3. Add one `runEvolutionCycle` persistence path shared by manual `/api/evolve` and `scheduled()`; batch writes so a generation snapshot, findings, policy promotion, and living-spec update stay consistent.
4. Preserve same-origin checks and manual rate limiting; bound work to five candidates and a fixed per-candidate probe budget.

### Task 3: Live self-updating project page

**Files:**
- Modify: `index.html`
- Modify: `tests/page-contract.test.mjs`

**Steps:**
1. Add failing page-contract expectations for generation number, candidate decision, operator weights, holdout score, regression gate, and synthetic-benchmark disclosure.
2. Render live values only from `/api/state`; display both promotions and rejections with reasons; label simulated coverage distinctly from repository branch coverage.
3. Change the manual action to trigger the same evolution cycle as Cron; retain accessible loading/error states and current history.
4. Run all project tests and inspect the production-like page locally.

### Task 4: Production rollout

**Files:**
- `wrangler.toml`
- Remote Cloudflare D1 and Worker deployment

**Steps:**
1. Apply the new migration to local D1 and validate SQL/query paths.
2. Run the pure-engine and page-contract suites plus `wrangler deploy --dry-run`.
3. Apply the migration remotely, deploy the Worker/assets, then manually run one evolution cycle.
4. Verify live `/api/state`, visible generation/decision/history, Worker bindings, Cron trigger, and D1 persistence. Do not claim day-over-day empirical improvement until multiple daily generations have been observed.
