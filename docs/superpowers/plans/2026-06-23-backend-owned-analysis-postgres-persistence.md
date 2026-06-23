# Backend-Owned Analysis Postgres Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把酒店评论 AI Dashboard 的后端分析能力真正切到 Postgres 持久化：configs/jobs/results/cache 全部落库，`review_records` 作为后端持久化读模型，飞书事件驱动增量同步，刷新时优先读后端快照而不是先扫 Base。

**Architecture:** 后端成为事实源：`analysis_configs`、`analysis_jobs`、`analysis_results`、`evidence_cache`、`topic_mapping_cache`、`review_records`、`review_source_versions`、`sync_jobs` 都由 Postgres 承接。Feishu Base 只负责初始全量和后续事件增量的输入，sync worker 负责把变更写入 `review_records` 并推进 `review_source_versions`；前端 View restore 先读后端 latest result，再把耗时的宿主数据读取和过滤选项加载放到非关键路径。

**Tech Stack:** TypeScript, Node `http`/`vite-node`, PostgreSQL 16, `pg`, Vitest, existing Feishu Base runtime and Dashboard SDK.

## Global Constraints

- 不要把本项目当成独立普通网页应用来设计运行时能力；必须考虑多维表格仪表盘插件容器、SDK 能力边界和发布要求。
- 不要擅自使用兜底方案；兜底方案只能作为最终无可奈何时的最后手段，且必须得到明确授权。
- 不使用兜底逻辑掩盖 SDK、权限、字段映射、同步、AI schema 或 DB 写入问题；错误必须暴露 stage 和 message。
- 后端是任务、结果、缓存、密钥和调度的事实源。
- 数据源读取和数据采集/同步分开。读取层只回答“分析用什么评论数据”，采集层只负责“数据库里的评论数据从哪里来、何时更新”。
- 第一版不保证实时数据同步；如果启用 Postgres 读模型，分析读取的是最近一次成功同步的数据版本。
- 第一版不做复杂多租户商业化权限模型，但表结构必须包含 `tenantKey` 和插件实例维度，避免后续迁移困难。

---

### Task 1: Add strict Postgres bootstrap and connection helper

**Files:**
- Create: `server/db/postgres.ts`
- Modify: `server/env.ts`
- Modify: `server/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/backend-local-postgres.md`
- Test: `server/db/postgres.test.ts`

**Interfaces:**
- Consumes: `DATABASE_URL`
- Produces: `createPostgresPool()`, `query()`, `closePostgresPool()`, `requireDatabaseUrl()`

- [ ] **Step 1: Write the failing test**

Add a unit test that proves the bootstrap is strict and never falls back to in-memory storage.

```ts
await expect(() => requireDatabaseUrl({ DATABASE_URL: '' })).toThrow('DATABASE_URL is required');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run server/db/postgres.test.ts`
Expected: fail because the helper does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement a tiny Postgres bootstrap around `pg`:

```ts
export function createPostgresPool(databaseUrl: string): Pool {
  if (!databaseUrl.trim()) {
    throw new Error('DATABASE_URL is required');
  }
  return new Pool({ connectionString: databaseUrl, max: 10 });
}
```

Wire `server/index.ts` to fail fast when `DATABASE_URL` is missing, and update `docs/backend-local-postgres.md` to document the required DSN and the migration command.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- --run server/db/postgres.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/db/postgres.ts server/env.ts server/index.ts package.json package-lock.json docs/backend-local-postgres.md server/db/postgres.test.ts
git commit -m "feat: add strict postgres bootstrap"
```

### Task 2: Persist configs, jobs, results, and cache rows in Postgres

**Files:**
- Create: `server/postgresAnalysisStore.ts`
- Modify: `server/backendAnalysis.ts`
- Modify: `server/analysisWorker.ts`
- Test: `server/postgresAnalysisStore.test.ts`

**Interfaces:**
- Consumes: `createPostgresPool()`, `AnalysisBackendStore`
- Produces: `createPostgresAnalysisBackendStore(pool): AnalysisBackendStore`

- [ ] **Step 1: Write the failing test**

Add an integration-style test that upserts one config twice, creates a job, saves a result, and then reads it back as the latest result.

```ts
const first = await store.upsertConfig(baseConfigRequest);
const second = await store.upsertConfig(baseConfigRequest);
expect(second.configVersion).toBe(first.configVersion + 1);
await expect(store.getLatestResult(ownership)).resolves.toMatchObject({
  resultId: expect.stringMatching(/^result-/),
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- --run server/postgresAnalysisStore.test.ts
```
Expected: fail because there is no Postgres-backed store yet.

- [ ] **Step 3: Write minimal implementation**

Implement the full `AnalysisBackendStore` contract with SQL:

```ts
analysis_configs -> upsert by identity, bump config_version
analysis_jobs -> create/find/claim/update/finalize with partial unique active scope index
review_source_versions -> upsert the source snapshot row and reuse its id from saveResult
analysis_results -> insert result_json/summary_json and read latest by generated_at desc
evidence_cache / topic_mapping_cache -> upsert by identity and preserve last_used_at
```

Keep all writes transactional where the row dependencies matter, and use JSONB for the schema payloads exactly as the migration defines them.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- --run server/postgresAnalysisStore.test.ts server/backendAnalysis.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/postgresAnalysisStore.ts server/backendAnalysis.ts server/analysisWorker.ts server/postgresAnalysisStore.test.ts
git commit -m "feat: persist backend analysis state in postgres"
```

### Task 3: Persist `review_records` and drive incremental sync from Feishu events

**Files:**
- Create: `server/postgresReviewSyncStore.ts`
- Create: `server/reviewSync.ts`
- Create: `server/postgresReviewSource.ts`
- Create: `server/syncHandler.ts`
- Modify: `server/index.ts`
- Test: `server/reviewSync.test.ts`

**Interfaces:**
- Consumes: Feishu Base read runtime, `sync_jobs`, `review_records`, `review_source_versions`
- Produces: `runFullSync()`, `enqueueSyncJob()`, `handleFeishuRecordChangedEvent()`, `PostgresReviewSource`

- [ ] **Step 1: Write the failing test**

Add tests that prove the sync path can seed the read model, apply an update, and soft-delete a removed record.

```ts
await syncService.runFullSync(sourceKey);
expect(await repo.listReviews(sourceKey)).toHaveLength(2);

await syncService.handleFeishuRecordChangedEvent({
  sourceKey,
  recordId: 'rec-1',
  operation: 'update',
});
expect(await repo.getReviewRecord(sourceKey, 'rec-1')).toMatchObject({ is_deleted: false });
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- --run server/reviewSync.test.ts
```
Expected: fail because the sync service and Postgres read model do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Build the sync layer in two parts:

```ts
// sync handler: validate, dedupe, enqueue sync_jobs, return fast
// sync worker: read Feishu Base, upsert review_records, soft-delete confirmed removals,
//              write review_source_versions after each successful run
```

`PostgresReviewSource.getSourceVersion()` should read the latest `review_source_versions` row instead of rescanning Base, and `listReviews()` should read non-deleted `review_records`.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- --run server/reviewSync.test.ts server/reviewSource.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/postgresReviewSyncStore.ts server/reviewSync.ts server/postgresReviewSource.ts server/syncHandler.ts server/index.ts server/reviewSync.test.ts
git commit -m "feat: persist review records and sync snapshots"
```

### Task 4: Make View restore read persisted results first and defer slow host reads

**Files:**
- Modify: `src/App.tsx`
- Modify: `server/index.ts`
- Modify: `server/analysisWorker.ts`
- Modify: `server/backendAnalysis.ts`
- Modify: `src/App.test.tsx`
- Modify: `server/analysisWorker.test.ts`

**Interfaces:**
- Consumes: `getLatestResult()`, `getCurrentJob()`, `resolveScope()`, `runtime.getData()`
- Produces: first paint from persisted backend result, background-only host data loading, idempotent init under StrictMode

- [ ] **Step 1: Write the failing test**

Add a View-mode test that keeps `runtime.getData()` pending but returns a backend result immediately; the result should still render.

```ts
const getData = vi.fn(() => new Promise(() => {}));
backendAnalysisClientMock.client.getLatestResult.mockResolvedValue({
  resultId: 'result-1',
  summary: createAnalysisResult(3),
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npm test -- --run src/App.test.tsx
```
Expected: fail because `initializeDisplayState()` still waits for `runtime.getData()` before restoring the result.

- [ ] **Step 3: Write minimal implementation**

Reorder the View restore path so it:

```ts
1. loads plugin config
2. resolves backend ownership
3. asks backend for current job / latest result
4. renders the persisted result
5. loads hostData and filter option records afterward
```

Keep the init idempotent so StrictMode does not duplicate backend calls, and keep `setRendered()` tied to the first meaningful paint instead of the slowest host read.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npm test -- --run src/App.test.tsx server/analysisWorker.test.ts
```
Expected: pass, and the restore path should no longer wait on a full Base scan before the result appears.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx server/index.ts server/analysisWorker.ts server/backendAnalysis.ts src/App.test.tsx server/analysisWorker.test.ts
git commit -m "feat: restore backend analysis before host reads"
```

### Task 5: End-to-end verification, docs, and local operator notes

**Files:**
- Modify: `docs/backend-local-postgres.md`
- Modify: `docs/current-status.md`
- Modify: `docs/superpowers/plans/2026-06-23-backend-owned-analysis-postgres-persistence.md` only if self-review finds a contradiction

**Interfaces:**
- Consumes: the full Postgres-backed backend analysis flow
- Produces: validated build, validated tests, and updated runbook notes

- [ ] **Step 1: Run the focused backend and frontend tests**

Run:
```bash
npm test -- --run server/postgresAnalysisStore.test.ts server/reviewSync.test.ts server/analysisWorker.test.ts src/App.test.tsx
```

- [ ] **Step 2: Run the production build**

Run:
```bash
npm run build
```

- [ ] **Step 3: Exercise the local Postgres path**

Run:
```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U hotel_review_ai -d hotel_review_ai -f /dev/stdin < server/migrations/001_backend_owned_analysis.sql
DATABASE_URL=postgresql://hotel_review_ai:hotel_review_ai_dev@127.0.0.1:5432/hotel_review_ai npm run server
```
Then smoke-test:

```bash
curl 'http://127.0.0.1:8787/api/hotel-review-ai/results/latest?...'
curl -X POST 'http://127.0.0.1:8787/api/hotel-review-ai/sync/feishu/record-changed' ...
```

- [ ] **Step 4: Update runbook notes**

Document the new Postgres-first restore path, the `DATABASE_URL` requirement, and the full/incremental sync split in `docs/backend-local-postgres.md` and `docs/current-status.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/backend-local-postgres.md docs/current-status.md
git commit -m "docs: record postgres-backed backend analysis workflow"
```

