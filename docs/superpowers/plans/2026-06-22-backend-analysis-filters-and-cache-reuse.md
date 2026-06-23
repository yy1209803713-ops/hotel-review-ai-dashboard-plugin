# Backend Analysis Filters And Cache Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backend-owned `analysis-jobs` actually honor user filters and reuse the existing two-layer Feishu Base AI cache so repeated analyses on the same scope stop re-running AI work.

**Architecture:** Keep `AnalysisJobWorker` as the job orchestrator, but move the real record filtering and cache-aware analysis into the shared runner path used by formal jobs. The runner should pre-filter `ReviewRecord[]` with the existing `filterReviews()` logic, then feed the existing `analysisPipeline` with evidence-cache hits/misses and topic-mapping-cache hits/misses from Feishu Base. Cache table access stays isolated behind the existing Feishu Base runtime layer so the backend keeps the same cache semantics as the earlier plugin flow.

**Tech Stack:** TypeScript, Node `fetch`, Vitest, existing backend runtime modules, shared analysis pipeline helpers.

## Global Constraints

- 不要擅自使用兜底方案；兜底方案只能作为最终无可奈何时的最后手段，且必须得到明确授权。
- 不使用兜底逻辑掩盖 SDK、权限、字段类型、记录读写或插件容器兼容问题；优先定位根因并让错误暴露出来再修正。
- 后端是任务、结果、缓存、密钥和调度的事实源。
- AI 评论证据缓存和 AI 评论主题映射缓存继续按现有表级语义复用，不要把它们改成新的缓存模型。
- `filterReviews()` 仍是现有过滤语义的唯一实现，过滤后再进入分析输入。

---

### Task 1: Apply filters before formal analysis input

**Files:**
- Modify: `server/aiAnalysisRunner.ts`
- Modify: `server/aiAnalysisRunner.test.ts`

**Interfaces:**
- Consumes: `filterReviews(records, filters)` from `src/services/filtering.ts`, `readFilterState(query.filters)`, `toPipelineReviewRecord()`
- Produces: filtered `ReviewRecord[]` passed into `runAnalysis()`, with unchanged `AnalysisRunner` return shape

- [ ] **Step 1: Write the failing test**

Add a runner test that feeds two reviews and a restrictive filter, then asserts only the matching review reaches `analyzeBatchImpl`.

```ts
expect(records.map((record) => record.recordId)).toEqual(['rec-match']);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run server/aiAnalysisRunner.test.ts`
Expected: fail because the runner still sends every review into analysis.

- [ ] **Step 3: Write minimal implementation**

Use `filterReviews()` inside `createAiAnalysisRunner()` before invoking `runAnalysis()`, and keep the existing `filters` object flowing into `analysisPipeline` for scope metadata.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run server/aiAnalysisRunner.test.ts`
Expected: pass, with only filtered records analyzed.

- [ ] **Step 5: Commit**

```bash
git add server/aiAnalysisRunner.ts server/aiAnalysisRunner.test.ts
git commit -m "fix: apply filters before backend analysis"
```

### Task 2: Reuse evidence/topic caches in formal analysis-jobs

**Files:**
- Modify: `server/aiAnalysisRunner.ts`
- Modify: `server/aiAnalysisRunner.test.ts`
- Modify: `server/index.ts` only if the runner needs new wiring

**Interfaces:**
- Consumes: `readEvidenceCache`, `saveEvidenceCacheEntries`, `readTopicMappingCache`, `saveTopicMappingCacheEntries`, plus the Feishu Base auth code already available in server env
- Produces: cached formal analysis jobs that skip AI for cache hits and only analyze misses

- [ ] **Step 1: Write the failing test**

Add a runner test that stubs evidence-cache hits for one record and verifies the AI batch function is not called for the cached record; add a second assertion that identical input reuses the topic-mapping cache path as well.

```ts
expect(analyzeBatchImpl).toHaveBeenCalledTimes(0);
expect(saveEvidenceCacheEntries).toHaveBeenCalledTimes(0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run server/aiAnalysisRunner.test.ts`
Expected: fail because formal jobs still run straight through AI without consulting the cache tables.

- [ ] **Step 3: Write minimal implementation**

Teach `createAiAnalysisRunner()` to create the Feishu Base cache runtime from `baseToken + LARK_BASE_AUTH_CODE`, read evidence/topic caches before analysis, pass cache hits/misses into `analysisPipeline`, and save new evidence/topic cache rows only for misses.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run server/aiAnalysisRunner.test.ts server/analysisWorker.test.ts`
Expected: pass, with the cached path avoiding redundant AI work.

- [ ] **Step 5: Commit**

```bash
git add server/aiAnalysisRunner.ts server/aiAnalysisRunner.test.ts server/index.ts
git commit -m "feat: reuse feishu analysis caches in jobs"
```

### Task 3: Full verification and branch handoff

**Files:**
- None

**Interfaces:**
- Consumes: the full backend job flow, including filter handling and cache reuse
- Produces: a branch that is build- and test-green

- [ ] **Step 1: Run the focused backend tests**

Run: `npm test -- --run server/aiAnalysisRunner.test.ts server/analysisWorker.test.ts`

- [ ] **Step 2: Run the production build**

Run: `npm run build`

- [ ] **Step 3: Review the final diff**

Run: `git status --short` and `git log --oneline -5`

- [ ] **Step 4: Commit any final cleanup**

If any last-minute cleanup is needed, make one final commit before handing the branch back.
