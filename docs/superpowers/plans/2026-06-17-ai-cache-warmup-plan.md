# AI Cache Warmup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a practical cache warmup path for the hotel review AI dashboard plugin without turning the dashboard iframe into a scheduler.

**Architecture:** Keep the dashboard plugin responsible for configuration, cache status, and manual trigger buttons. Add reusable TypeScript services for warmup hit/miss calculation, backend API calls, and optional local runtime execution so the same contract can be used by a future HTTP backend and Feishu Workflow. Do not add frontend cron behavior or silent fallbacks.

**Tech Stack:** React 18, Vite, Vitest, TypeScript, Semi UI, `@lark-base-open/js-sdk`.

---

### Task 1: Warmup Service Contract

**Files:**
- Create: `src/services/warmup.ts`
- Test: `src/services/warmup.test.ts`

- [x] **Step 1: Write failing tests for warmup request validation and summary behavior**

Create `src/services/warmup.test.ts` with tests covering:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type { ReviewRecord, TopicMergeCandidate, TopicMergeGroup } from '../types/analysis';
import { warmupAnalysisCache } from './warmup';

// tests:
// 1. bootstrap saves only cache misses and returns status success with summary counts
// 2. second incremental warmup with all hits makes no AI calls
// 3. lock already held returns skipped without reading records
// 4. invalid request reports failed validation stage
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run src/services/warmup.test.ts
```

Expected: FAIL because `src/services/warmup.ts` does not exist.

- [x] **Step 3: Implement minimal warmup service**

Create `src/services/warmup.ts` with:

```ts
export type WarmupMode = 'bootstrap' | 'incremental';
export type WarmupSource = 'dashboard-button' | 'feishu-workflow' | 'manual';
export type WarmupStatus = 'accepted' | 'running' | 'success' | 'partial_success' | 'failed' | 'skipped';
export type WarmupStage = 'validate_request' | 'lock' | 'read_reviews' | 'read_evidence_cache' | 'extract_evidence' | 'save_evidence_cache' | 'read_topic_mapping_cache' | 'merge_topics' | 'save_topic_mapping_cache';
export type WarmupRequest = { mode: WarmupMode; source: WarmupSource; baseToken?: string; tableId: string; viewId?: string; configId?: string; dryRun?: boolean };
export type WarmupResponse = { jobId: string; status: WarmupStatus; mode: WarmupMode; summary: WarmupSummary; errors: WarmupError[] };
export type WarmupSummary = { totalReviews: number; evidenceCacheHits: number; evidenceCacheMisses: number; evidenceRecordsSaved: number; topicMappingHits: number; topicMappingMisses: number; topicMappingsSaved: number };
export type WarmupError = { stage: WarmupStage; message: string; recordId?: string };
export async function warmupAnalysisCache(...): Promise<WarmupResponse>;
```

Implementation rules:
- Validate `mode` and non-empty `tableId`.
- Acquire a provided lock by key `warmup:<baseToken || "local">:<tableId>`.
- Read records through injected `readReviews`.
- Read evidence cache through injected `readEvidenceCache`.
- Call `runAnalysis` with `cachedEvidenceItems` and `cacheMissRecords`.
- Save new evidence through the `onCacheUsage` callback.
- Read topic mapping cache through `readTopicMappingsImpl`.
- Save new topic mappings through `onTopicMappingUsage`.
- Never catch and hide AI/schema/save errors; return `failed` with stage and message.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run src/services/warmup.test.ts
```

Expected: PASS.

### Task 2: Warmup API Client And Plugin Config

**Files:**
- Modify: `src/types/config.ts`
- Modify: `src/constants/defaults.ts`
- Create: `src/services/warmupClient.ts`
- Test: `src/services/warmupClient.test.ts`

- [x] **Step 1: Write failing tests for API client behavior**

Create `src/services/warmupClient.test.ts` covering:
- Missing endpoint throws a visible configuration error.
- `triggerWarmup` sends `POST /api/hotel-review-ai/warmup` style JSON with `Authorization: Bearer <secret>`.
- Non-2xx response surfaces backend `stage` and `message`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run src/services/warmupClient.test.ts
```

Expected: FAIL because client/config types do not exist.

- [x] **Step 3: Add config types and client**

Add to `PluginConfig`:

```ts
warmup: {
  endpointUrl: string;
  secret: string;
};
```

Add defaults:

```ts
warmup: {
  endpointUrl: '',
  secret: '',
}
```

Add `src/services/warmupClient.ts`:
- `buildWarmupRequest(config, mode)`
- `triggerWarmup(config, mode, source, fetchImpl = fetch)`
- Validate endpoint URL and secret before fetch.
- Return parsed `WarmupResponse`.
- Throw `WarmupClientError` with backend stage/message for non-2xx responses.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run src/services/warmupClient.test.ts
```

Expected: PASS.

### Task 3: Config Panel Warmup Controls

**Files:**
- Modify: `src/components/ConfigPanel.tsx`
- Modify: `src/components/ConfigPanel.test.tsx`
- Modify: `src/styles/app.css`

- [x] **Step 1: Write failing config panel tests**

Extend `src/components/ConfigPanel.test.tsx` to verify:
- The panel renders a `缓存预热` section.
- Endpoint URL and secret changes update `config.warmup`.
- `初始化缓存` and `立即预热` buttons call provided handlers.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run src/components/ConfigPanel.test.tsx
```

Expected: FAIL because warmup props and controls are missing.

- [x] **Step 3: Add controls**

Update `ConfigPanel` props:

```ts
warmupRunning: boolean;
onWarmupBootstrap: () => void;
onWarmupIncremental: () => void;
```

Add a compact `缓存预热` section after AI API:
- Endpoint URL input.
- Warmup secret password input.
- `初始化缓存` button.
- `立即预热` button.
- Buttons disabled while saving/loading/running or missing source table.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run src/components/ConfigPanel.test.tsx
```

Expected: PASS.

### Task 4: App Warmup Trigger And Status

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Create: `src/components/CacheWarmupStatus.tsx`
- Modify: `src/components/DashboardShell.tsx`
- Modify: `src/styles/app.css`

- [x] **Step 1: Write failing app tests**

Extend `src/App.test.tsx` to verify:
- Config mode passes warmup handlers to `ConfigPanel`.
- Clicking `立即预热` calls `triggerWarmup` with `mode=incremental`.
- Failure displays backend stage/message.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: FAIL because warmup client is not wired.

- [x] **Step 3: Wire app state and status component**

Add state:
- `warmupRunning`
- `warmupStatus`

Add handlers:
- `handleWarmupBootstrap()`
- `handleWarmupIncremental()`

Use `triggerWarmup(config, mode, 'dashboard-button')`.
On success, update status and show Toast summary.
On failure, display `缓存预热失败：<stage> <message>`.

Add `CacheWarmupStatus` under dashboard content when status exists:
- Evidence coverage.
- Topic mapping coverage.
- Last status.
- Last trigger time.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: PASS.

### Task 5: Workflow Documentation And Verification

**Files:**
- Create: `docs/ai-cache-warmup-workflow.md`
- Modify: `docs/current-status.md`

- [x] **Step 1: Add docs**

Document:
- Workflow `TimerTrigger -> HTTPClientAction -> backend endpoint`.
- Required headers/body.
- Environment variables for backend.
- Current repository boundary: plugin ships API client and reusable service contract; deployment host provides actual HTTP endpoint and OpenAPI credentials.

- [x] **Step 2: Run full verification**

Run:

```bash
npm test -- --run
npm run build
```

Expected: both exit 0.

- [x] **Step 3: Review spec coverage**

Check `docs/superpowers/specs/2026-06-17-ai-cache-warmup-design.md` against implemented files and record any deferred backend deployment details in the final response.
