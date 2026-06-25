# Warmup Background Job Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/api/hotel-review-ai/warmup` into an auditable background job and let sync requests optionally enqueue warmup after successful sync.

**Architecture:** Add a `warmup_jobs` store/table, a `WarmupService` that creates jobs, and a `WarmupJobWorker` that reads the global Postgres review source and reuses `formalAnalysisCacheRunner` to build only missing two-layer caches. `sync/full` and `sync/incremental` keep their own sync logging and optionally enqueue a warmup job from the request body after sync succeeds.

**Tech Stack:** TypeScript, Vitest, Postgres, existing `ReviewSyncService`, `PostgresReviewSource`, `formalAnalysisCacheRunner`, `postgresAnalysisCache`.

## Global Constraints

- This is a Feishu Base dashboard plugin backend; do not add frontend cron behavior.
- No fallback paths: missing synced read model, invalid payload, or missing AI env should fail visibly and be recorded.
- Shared cache identity must remain `global-review-source + feishu_base + baseToken:tableId`.
- Warmup time range uses comment/review time: `reviewDate`.

---

### Task 1: Warmup Store And Migration

**Files:**
- Create: `server/warmupJobStore.ts`
- Modify: `server/migrations/001_backend_owned_analysis.sql`
- Modify: `server/backendOwnedMigration.test.ts`

**Interfaces:**
- Produces: `WarmupJobStore`, `createInMemoryWarmupJobStore()`, `createPostgresWarmupJobStore()`.

- [ ] Write failing tests for `warmup_jobs` migration text and in-memory job lifecycle.
- [ ] Implement the `warmup_jobs` table with trigger payload/result JSON and cache statistics.
- [ ] Implement in-memory and Postgres stores.
- [ ] Run targeted tests.

### Task 2: Warmup Service And Worker

**Files:**
- Create: `server/warmupJob.ts`
- Modify: `server/warmupTypes.ts`
- Modify: `server/warmupHandler.ts`
- Test: `server/warmupHandler.test.ts`

**Interfaces:**
- Consumes: `WarmupJobStore`, `ReviewSource`, `AnalysisRunner`.
- Produces: `WarmupService.createWarmupJob()`, `WarmupJobWorker.runWarmupJob()`.

- [ ] Write failing tests that `/warmup` enqueues a job and the worker filters by `reviewDate`.
- [ ] Implement validation for `baseToken`, `tableId`, optional `fieldMapping`, optional `startDate/endDate`.
- [ ] Implement worker using `postgres` source query with `sourceConfig.sourceId = baseToken:tableId`.
- [ ] Record requested payload, accepted response, final result, scan counts, hit/miss counts, and save insert/update counts.

### Task 3: Sync Follow-Up Warmup

**Files:**
- Modify: `server/syncHandler.ts`
- Modify: `server/index.ts`
- Test: `server/reviewSync.test.ts`
- Test: `server/indexPostgresWiring.test.ts`

**Interfaces:**
- Consumes: optional request body `warmup`.
- Produces: sync queue hook that enqueues warmup only after successful sync.

- [ ] Write failing tests for `warmup.enabled` on sync request.
- [ ] Carry warmup options from sync request into the runtime queue.
- [ ] Enqueue warmup after successful full/incremental sync.
- [ ] Run targeted tests and build.

### Task 4: Docs And Curl

**Files:**
- Modify: `docs/ai-cache-warmup-workflow.md`
- Modify: `docs/current-status.md`

- [ ] Document standalone warmup curl.
- [ ] Document sync-with-warmup curl.
- [ ] Run final verification.
