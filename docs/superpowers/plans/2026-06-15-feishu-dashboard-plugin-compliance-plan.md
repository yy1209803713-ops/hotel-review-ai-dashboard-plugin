# Feishu Dashboard Plugin Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前酒店评论 AI 仪表盘项目收敛成合规的飞书多维表格 Dashboard 插件，并保留现有分析、缓存、写回和证据查看能力。

**Architecture:** 保留现有 React/Vite 项目和业务服务层，在当前 runtime adapter 上补齐 Dashboard 插件协议。新增小而清晰的配置协议模块、字段映射模块、配置校验模块和宿主事件处理路径；`App.tsx` 负责 orchestration，但把可测试的协议逻辑移出到 services/runtime helper 中。UI 只做飞书容器所需适配，不重做产品形态。

**Tech Stack:** React 18, TypeScript, Vite, `@lark-base-open/js-sdk@1.0.2`, Semi UI, Vitest, dayjs, zod

---

## File Structure

- Create `src/services/dashboardConfig.ts`: build and normalize `dataConditions`, extract selected `tableId` / `dataRange`, build default draft config from table/range/field metadata.
- Create `src/services/dashboardConfig.test.ts`: unit tests for `dataConditions`, Create-state draft config, and old config normalization.
- Create `src/services/fieldMapping.ts`: field alias table, field-name normalization, auto-prefill and required-field validation.
- Create `src/services/fieldMapping.test.ts`: alias matching, unmatched fields, required-field error coverage.
- Create `src/services/hostDataScope.ts`: parse Dashboard `getData` / `getPreviewData` output into the host-visible review ID scope and stable scope signal.
- Create `src/services/hostDataScope.test.ts`: verify review ID parsing, empty host data handling, and unsupported result detection.
- Create `src/fixtures/dashboardSource.ts`: keep the verified local-preview table, view, and field IDs out of `DEFAULT_CONFIG`.
- Modify `src/types/config.ts`: make source config explicitly support `dataRange`, empty defaults, and optional scope warning.
- Modify `src/constants/defaults.ts`: remove hardcoded API key and table-specific default IDs from shared defaults.
- Modify `src/constants/defaults.test.ts`: assert no hardcoded API key; move verified hotel table IDs out of default-config expectations.
- Modify `src/runtime/sdk.ts`: add `getData`, `getPreviewData`, `onDataChange`, complete theme/config listeners, and Create-safe config behavior.
- Modify `src/runtime/sdk.test.ts`: fixture runtime contract tests for states, preview/data methods, events, and persistence.
- Modify `src/services/cacheStore.ts`: save `dataConditions + customConfig`; remove host-side localStorage fallback on save failure.
- Modify `src/services/cacheStore.test.ts`: verify save failure rejects and no API key is reintroduced.
- Modify `src/services/baseRecords.ts`: make `dataRange`/`viewId` handling explicit and keep row-level reads scoped.
- Modify `src/services/stats.ts`: include source data range and host data signal in `ScopeSnapshot`.
- Modify `src/App.tsx`: lifecycle orchestration, Create/Config/View split, config save, host events, setRendered calls.
- Modify `src/components/ConfigPanel.tsx`: data source, data range, field mapping, AI config, writeback groups; show auto-match and missing-field status.
- Modify `src/components/StateViews.tsx`: missing config, missing API key, stale cache, unsupported host-scope states.
- Modify `src/styles/app.css` and `src/styles/tokens.css`: compact dashboard container, config layout, dark/fullscreen transparency.
- Modify `docs/current-status.md`: record final verified behavior and commands.

---

## Execution Guardrails

- Before touching code, re-open these project references if the implementation context has gone cold:
  - `docs/多维表格仪表盘插件开发资料/docs/多维表格-仪表盘插件-开发指南.md`
  - `docs/多维表格仪表盘插件开发资料/docs/Base-JSSDK-Dashboard-插件-API-文档.md`
  - `docs/多维表格仪表盘插件开发资料/examples/radar_chart_demo/src/App.tsx`
  - `docs/多维表格仪表盘插件开发资料/examples/Count-Down/src/hooks.ts`
- Never call `dashboard.getConfig()` or `dashboard.getData()` while `dashboard.state === DashboardState.Create`.
- Never run AI analysis against all table records when `dataRange` / Dashboard global filters cannot be represented. Surface an error or explicit blocked state instead.
- Keep `getData()` for `View` / `FullScreen` and `getPreviewData(dataConditions)` for `Create` / `Config`, matching the SDK docs.
- Do not add fallback persistence for failed `dashboard.saveConfig()`; failed save must be visible to the user.
- Each task should be committed before moving to the next task.

---

### Task 1: Shared Defaults And Config Persistence

**Files:**
- Create: `src/fixtures/dashboardSource.ts`
- Modify: `src/constants/defaults.ts`
- Modify: `src/constants/defaults.test.ts`
- Modify: `src/types/config.ts`
- Modify: `src/runtime/sdk.ts`
- Modify: `src/runtime/sdk.test.ts`
- Modify: `src/services/baseRecords.test.ts`
- Modify: `src/services/cacheStore.ts`
- Modify: `src/services/cacheStore.test.ts`

- [ ] **Step 1: Write failing tests**

Replace the default API key test in `src/constants/defaults.test.ts` with:

```ts
it('does not ship a hardcoded API key', () => {
  expect(DEFAULT_CONFIG.ai.apiBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  expect(DEFAULT_CONFIG.ai.model).toBe('qwen-plus');
  expect(DEFAULT_CONFIG.ai.apiKey).toBe('');
});
```

Replace the old verified table/field default test in `src/constants/defaults.test.ts` with:

```ts
it('starts with an empty source config for real dashboard setup', () => {
  expect(DEFAULT_CONFIG.source.tableId).toBe('');
  expect(DEFAULT_CONFIG.source.viewId).toBe('');
  expect(Object.values(DEFAULT_CONFIG.source.fields)).toEqual(['', '', '', '', '', '', '', '']);
});
```

Replace the localStorage fallback test in `src/services/cacheStore.test.ts` with:

```ts
it('surfaces Dashboard save failures instead of falling back to localStorage', async () => {
  const runtime = fakeRuntime(
    { dataConditions: [], customConfig: DEFAULT_CONFIG },
    () => Promise.reject(new Error('save failed')),
  );
  const cache: AnalysisCache = {
    result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-2' },
    scopeSnapshot: {},
    sourceSnapshot: {},
    model: 'qwen-plus',
    generatedAt: '2026-06-03T12:00:00+08:00',
  };

  await expect(saveAnalysisCache(runtime, cache)).rejects.toThrow('save failed');
  expect(localStorage.getItem('hotel-review-ai-dashboard:fixture-instance')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test -- --run src/constants/defaults.test.ts src/services/cacheStore.test.ts`

Expected: FAIL because `DEFAULT_CONFIG.ai.apiKey` is currently hardcoded and `saveAnalysisCache` falls back to localStorage.

- [ ] **Step 3: Implement config defaults and persistence behavior**

In `src/constants/defaults.ts`, update `DEFAULT_CONFIG`:

```ts
source: {
  tableId: '',
  viewId: '',
  fields: {
    reviewId: '',
    content: '',
    hotelName: '',
    score: '',
    reviewDate: '',
    checkInMonth: '',
    replyContent: '',
    roomType: '',
  },
},
ai: {
  apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: '',
  model: 'qwen-plus',
  temperature: 0.2,
  maxBatchSize: 10,
  batchConcurrency: 3,
  topN: 10,
},
writeback: {
  enabled: false,
  confirmed: false,
},
```

Create `src/fixtures/dashboardSource.ts`:

```ts
import { SourceType } from '@lark-base-open/js-sdk';
import type { PluginConfig } from '../types/config';

export const FIXTURE_SOURCE_CONFIG: PluginConfig['source'] = {
  tableId: 'tbl37qjFGwC2XccK',
  viewId: 'vew4P7LY9a',
  dataRange: {
    type: SourceType.VIEW,
    viewId: 'vew4P7LY9a',
    viewName: '表格',
  },
  fields: {
    reviewId: 'fldVtWzH6z',
    content: 'fld5T66ajC',
    hotelName: 'fld2vyUWnW',
    score: 'fld5x0xdlt',
    reviewDate: 'fld75mtSQz',
    checkInMonth: 'fld4GSbB7A',
    replyContent: 'fld5lYCMLN',
    roomType: 'fld1eRxoQS',
  },
};
```

Update fixture-only code in `src/runtime/sdk.ts`:

```ts
import { FIXTURE_SOURCE_CONFIG } from '../fixtures/dashboardSource';
```

Use `FIXTURE_SOURCE_CONFIG` instead of `DEFAULT_CONFIG.source` for:

```ts
customConfig: {
  ...DEFAULT_CONFIG,
  source: FIXTURE_SOURCE_CONFIG,
}
```

and fixture table/range/category definitions:

```ts
tableId: FIXTURE_SOURCE_CONFIG.tableId
viewId: FIXTURE_SOURCE_CONFIG.viewId
fieldId: FIXTURE_SOURCE_CONFIG.fields.reviewId
```

Update tests that need the verified local-preview mapping to import `FIXTURE_SOURCE_CONFIG`, especially `src/runtime/sdk.test.ts` and `src/services/baseRecords.test.ts`.

In `src/services/cacheStore.ts`, remove the `LOCAL_STORAGE_PREFIX` fallback and let `runtime.saveConfig(nextConfig)` errors reject.

Keep backward-compatible normalization for old saved configs:

```ts
const isOldDefaultModel = config.ai.model === 'gpt-4o-mini' || !config.ai.model.trim();
const isEmptyApiKey = !config.ai.apiKey.trim();

apiKey: isEmptyApiKey ? '' : config.ai.apiKey,
model: isOldDefaultModel ? DEFAULT_CONFIG.ai.model : config.ai.model,
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/constants/defaults.test.ts src/services/cacheStore.test.ts src/runtime/sdk.test.ts src/services/baseRecords.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/fixtures/dashboardSource.ts src/constants/defaults.ts src/constants/defaults.test.ts src/types/config.ts src/runtime/sdk.ts src/runtime/sdk.test.ts src/services/baseRecords.test.ts src/services/cacheStore.ts src/services/cacheStore.test.ts
git commit -m "refactor: normalize dashboard plugin config defaults"
```

### Task 2: Dashboard Config Builder

**Files:**
- Create: `src/services/dashboardConfig.ts`
- Create: `src/services/dashboardConfig.test.ts`
- Modify: `src/runtime/sdk.ts`
- Modify: `src/runtime/sdk.test.ts`
- Modify: `src/services/cacheStore.ts`
- Modify: `src/services/cacheStore.test.ts`
- Modify: `src/types/config.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/dashboardConfig.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SourceType } from '@lark-base-open/js-sdk';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { buildDataConditions, getPrimaryDataCondition, mergeConfigWithDataCondition } from './dashboardConfig';

describe('dashboardConfig', () => {
  it('builds a minimal COUNTA data condition from plugin source config', () => {
    const config = {
      ...DEFAULT_CONFIG,
      source: {
        tableId: 'tbl1',
        viewId: 'vew1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        fields: { ...DEFAULT_CONFIG.source.fields, reviewId: 'fld_review_id' },
      },
    };

    expect(buildDataConditions(config)).toEqual([
      {
        tableId: 'tbl1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        groups: [{ fieldId: 'fld_review_id' }],
        series: 'COUNTA',
      },
    ]);
  });

  it('merges saved dataConditions back into source config', () => {
    const config = mergeConfigWithDataCondition(DEFAULT_CONFIG, {
      tableId: 'tbl1',
      dataRange: { type: SourceType.ALL },
      series: 'COUNTA',
    });

    expect(config.source.tableId).toBe('tbl1');
    expect(config.source.dataRange).toEqual({ type: SourceType.ALL });
  });

  it('returns null for missing saved data conditions', () => {
    expect(getPrimaryDataCondition({ dataConditions: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run src/services/dashboardConfig.test.ts`

Expected: FAIL because `dashboardConfig.ts` does not exist.

- [ ] **Step 3: Implement config builder**

Create `src/services/dashboardConfig.ts` with these exported functions:

```ts
import { SourceType, type IDataCondition, type IDataRange } from '@lark-base-open/js-sdk';
import type { PluginConfig } from '../types/config';
import type { RuntimeConfig } from '../runtime/sdk';

export function getPrimaryDataCondition(config: RuntimeConfig): IDataCondition | null {
  return config.dataConditions[0] ? (config.dataConditions[0] as IDataCondition) : null;
}

export function buildDataConditions(config: PluginConfig): IDataCondition[] {
  if (!config.source.tableId) {
    return [];
  }
  const reviewIdField = config.source.fields.reviewId;
  return [
    {
      tableId: config.source.tableId,
      dataRange: normalizeDataRange(config.source.dataRange, config.source.viewId),
      groups: reviewIdField ? [{ fieldId: reviewIdField }] : undefined,
      series: 'COUNTA',
    },
  ];
}

export function mergeConfigWithDataCondition(config: PluginConfig, dataCondition: IDataCondition | null): PluginConfig {
  if (!dataCondition) {
    return config;
  }
  return {
    ...config,
    source: {
      ...config.source,
      tableId: dataCondition.tableId ?? config.source.tableId,
      viewId: dataCondition.dataRange?.type === SourceType.VIEW ? dataCondition.dataRange.viewId : config.source.viewId,
      dataRange: dataCondition.dataRange ?? config.source.dataRange,
    },
  };
}

function normalizeDataRange(dataRange: unknown, viewId?: string): IDataRange | undefined {
  if (dataRange && typeof dataRange === 'object') {
    return dataRange as IDataRange;
  }
  return viewId ? { type: SourceType.VIEW, viewId, viewName: '表格' } : { type: SourceType.ALL };
}
```

Update `savePluginConfig` and `saveAnalysisCache` in `src/services/cacheStore.ts` to call `buildDataConditions(pluginConfig)`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/services/dashboardConfig.test.ts src/services/cacheStore.test.ts src/runtime/sdk.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/dashboardConfig.ts src/services/dashboardConfig.test.ts src/runtime/sdk.ts src/runtime/sdk.test.ts src/services/cacheStore.ts src/services/cacheStore.test.ts src/types/config.ts
git commit -m "feat: build dashboard data conditions"
```

### Task 3: Field Mapping And Config Validation

**Files:**
- Create: `src/services/fieldMapping.ts`
- Create: `src/services/fieldMapping.test.ts`
- Modify: `src/components/ConfigPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/constants/defaults.ts`

- [ ] **Step 1: Write failing tests**

Create `src/services/fieldMapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { REQUIRED_FIELD_KEYS } from '../constants/defaults';
import { getMissingRequiredFields, suggestFieldMapping } from './fieldMapping';

describe('suggestFieldMapping', () => {
  it('prefills common Chinese and English aliases', () => {
    const fields = [
      { fieldId: 'fld_id', fieldName: '评论ID', fieldType: 'number' },
      { fieldId: 'fld_content', fieldName: 'comment', fieldType: 'text' },
      { fieldId: 'fld_hotel', fieldName: '酒店', fieldType: 'text' },
      { fieldId: 'fld_score', fieldName: 'rating', fieldType: 'number' },
      { fieldId: 'fld_review_date', fieldName: '评论日期', fieldType: 'text' },
      { fieldId: 'fld_checkin', fieldName: '入住月份', fieldType: 'text' },
      { fieldId: 'fld_reply', fieldName: '回复内容', fieldType: 'text' },
      { fieldId: 'fld_room', fieldName: 'room_type', fieldType: 'text' },
    ];

    expect(suggestFieldMapping(fields)).toEqual({
      reviewId: 'fld_id',
      content: 'fld_content',
      hotelName: 'fld_hotel',
      score: 'fld_score',
      reviewDate: 'fld_review_date',
      checkInMonth: 'fld_checkin',
      replyContent: 'fld_reply',
      roomType: 'fld_room',
    });
  });

  it('reports missing required fields by key', () => {
    const missing = getMissingRequiredFields({
      reviewId: 'fld_id',
      content: '',
      hotelName: 'fld_hotel',
      score: '',
      reviewDate: 'fld_date',
      checkInMonth: 'fld_checkin',
      replyContent: 'fld_reply',
      roomType: 'fld_room',
    });

    expect(missing).toEqual(['content', 'score']);
    expect(REQUIRED_FIELD_KEYS).toContain('content');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run src/services/fieldMapping.test.ts`

Expected: FAIL because `fieldMapping.ts` does not exist.

- [ ] **Step 3: Implement field mapping helpers**

Create `src/services/fieldMapping.ts`:

```ts
import { REQUIRED_FIELD_KEYS } from '../constants/defaults';
import type { FieldMapping } from '../types/config';
import type { RuntimeCategory } from '../runtime/sdk';

const FIELD_ALIASES: Record<keyof FieldMapping, string[]> = {
  reviewId: ['评论id', '评论ID', '评论 ID', 'reviewId', 'review_id', 'id'],
  content: ['评论内容', '内容', 'comment', 'content', 'review'],
  hotelName: ['酒店名称', '酒店', 'hotelName', 'hotel_name', 'hotel'],
  score: ['评分', 'score', 'rating'],
  reviewDate: ['评论日期', '评论时间', 'reviewDate', 'review_date', 'commentDate'],
  checkInMonth: ['入住日期', '入住月份', 'checkInMonth', 'check_in_month', 'checkInDate'],
  replyContent: ['酒店回复内容', '回复内容', 'replyContent', 'reply'],
  roomType: ['房型', 'roomType', 'room_type'],
};

export function suggestFieldMapping(fields: RuntimeCategory[]): FieldMapping {
  const normalizedFields = new Map(fields.map((field) => [normalizeFieldName(field.fieldName), field.fieldId]));
  return Object.fromEntries(
    REQUIRED_FIELD_KEYS.map((key) => {
      const match = FIELD_ALIASES[key].map(normalizeFieldName).find((alias) => normalizedFields.has(alias));
      return [key, match ? normalizedFields.get(match) ?? '' : ''];
    }),
  ) as FieldMapping;
}

export function getMissingRequiredFields(fields: FieldMapping): Array<keyof FieldMapping> {
  return REQUIRED_FIELD_KEYS.filter((key) => !fields[key]?.trim());
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}
```

Use `suggestFieldMapping()` in `App.tsx` after loading categories for a selected table. Use `getMissingRequiredFields()` before save and before analysis.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/services/fieldMapping.test.ts src/constants/defaults.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/fieldMapping.ts src/services/fieldMapping.test.ts src/components/ConfigPanel.tsx src/App.tsx src/constants/defaults.ts
git commit -m "feat: add field mapping validation"
```

### Task 4: Runtime Lifecycle And Host Events

**Files:**
- Modify: `src/runtime/sdk.ts`
- Modify: `src/runtime/sdk.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/main.tsx`

- [ ] **Step 1: Write failing tests**

Extend `src/runtime/sdk.test.ts`:

```ts
it('provides fixture preview/data/event methods for all dashboard states', async () => {
  const runtime = createFixtureRuntime({ state: 'Create' });

  expect(runtime.getState()).toBe('Create');
  await expect(runtime.getPreviewData([])).resolves.toEqual([]);
  await expect(runtime.getData()).resolves.toEqual([]);
  expect(runtime.onDataChange(() => undefined)).toBeTypeOf('function');
  expect(runtime.onConfigChange(() => undefined)).toBeTypeOf('function');
  expect(runtime.onThemeChange(() => undefined)).toBeTypeOf('function');
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run src/runtime/sdk.test.ts`

Expected: FAIL because `DashboardRuntime` does not expose `getData`, `getPreviewData`, or `onDataChange` yet.

- [ ] **Step 3: Implement runtime contract**

Update `DashboardRuntime` in `src/runtime/sdk.ts` with:

```ts
getPreviewData(dataConditions: unknown): Promise<unknown[][]>;
getData(): Promise<unknown[][]>;
onDataChange(callback: (data: unknown[][]) => void): () => void;
```

Fixture runtime:

```ts
getPreviewData: async () => [],
getData: async () => [],
onDataChange: () => () => undefined,
```

Lark runtime:

```ts
getPreviewData: (dataConditions) => dashboard.getPreviewData(dataConditions as never),
getData: () => dashboard.getData(),
onDataChange: (callback) => dashboard.onDataChange((event) => callback(event.data)),
```

Keep `Create` state safe by returning a draft runtime config without calling `dashboard.getConfig()`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/runtime/sdk.test.ts src/services/cacheStore.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/sdk.ts src/runtime/sdk.test.ts src/App.tsx src/main.tsx
git commit -m "feat: align dashboard runtime lifecycle"
```

### Task 5: App Orchestration And Save Flow

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/ConfigPanel.tsx`
- Modify: `src/components/StateViews.tsx`
- Modify: `src/services/cacheStore.ts`
- Modify: `src/services/cacheStore.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `src/services/cacheStore.test.ts`:

```ts
it('saves customConfig together with rebuilt dataConditions', async () => {
  let savedConfig: RuntimeConfig | null = null;
  const pluginConfig = {
    ...DEFAULT_CONFIG,
    source: {
      ...DEFAULT_CONFIG.source,
      tableId: 'tbl1',
      fields: { ...DEFAULT_CONFIG.source.fields, reviewId: 'fld1' },
    },
  };
  const runtime = fakeRuntime({ dataConditions: [], customConfig: pluginConfig }, async (config) => {
    savedConfig = config;
    return true;
  });

  await savePluginConfig(runtime, pluginConfig);

  expect(savedConfig?.customConfig?.source.tableId).toBe('tbl1');
  expect(savedConfig?.dataConditions[0]).toMatchObject({ tableId: 'tbl1', series: 'COUNTA' });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run src/services/cacheStore.test.ts`

Expected: FAIL until `savePluginConfig()` rebuilds `dataConditions`.

- [ ] **Step 3: Implement orchestration**

In `App.tsx`:

- Initialize by state:
  - `Create`: load tables, choose default table, load ranges/categories, auto-map fields, do not call host `getConfig`.
  - `Config`: load saved config, ranges/categories, preview data.
  - `View` / `FullScreen`: load saved config and cached analysis; call `runtime.getData()` for host signal.
- Before save, validate:
  - `source.tableId` exists.
  - all required fields are mapped.
  - `ai.apiBaseUrl` and `ai.model` exist.
- Allow empty API key for config save, but block test connection and analysis if key is empty.
- Save via `savePluginConfig(runtime, config)`.
- After successful save, show success toast.
- On save failure, set error and show toast with the real error message.

In `ConfigPanel.tsx`:

- Add data range select.
- Show missing field list from validation.
- Keep AI fields editable and saveable.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/services/cacheStore.test.ts src/services/fieldMapping.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/ConfigPanel.tsx src/components/StateViews.tsx src/services/cacheStore.ts src/services/cacheStore.test.ts
git commit -m "feat: save dashboard plugin config"
```

### Task 6: Data Scope, Cache Staleness, And Analysis Guards

**Files:**
- Create: `src/services/hostDataScope.ts`
- Create: `src/services/hostDataScope.test.ts`
- Modify: `src/services/baseRecords.ts`
- Modify: `src/services/baseRecords.test.ts`
- Modify: `src/services/stats.ts`
- Modify: `src/services/stats.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/services/aiClient.ts`
- Modify: `src/services/aiClient.test.ts`

- [ ] **Step 1: Write failing tests**

Extend `src/services/stats.test.ts`:

```ts
it('captures source table and data range in the analysis scope', () => {
  const scope = buildScopeSnapshot(records, filters, fields, 'qwen-plus', {
    tableId: 'tbl1',
    dataRange: { type: 'ALL' },
    hostDataSignal: 'host-count:3',
  });

  expect(scope.source.tableId).toBe('tbl1');
  expect(scope.source.hostDataSignal).toBe('host-count:3');
});

it('detects stale cache when the source view changes', () => {
  const cached = buildScopeSnapshot(records, filters, fields, 'qwen-plus', {
    tableId: 'tbl1',
    dataRange: { type: 'VIEW', viewId: 'view-a' },
  });
  const current = buildScopeSnapshot(records, filters, fields, 'qwen-plus', {
    tableId: 'tbl1',
    dataRange: { type: 'VIEW', viewId: 'view-b' },
  });

  expect(isCacheStale(cached, current)).toBe(true);
});
```

Create `src/services/hostDataScope.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHostDataSignal, parseHostVisibleReviewIds } from './hostDataScope';

describe('hostDataScope', () => {
  it('extracts review IDs from Dashboard grouped data', () => {
    const data = [
      [
        { value: '评论ID', text: '评论ID', groupKey: null },
        { value: '记录数', text: '记录数', groupKey: null },
      ],
      [
        { value: '1001', text: '1001', groupKey: '1001' },
        { value: 1, text: '1', groupKey: null },
      ],
      [
        { value: '1002', text: '1002', groupKey: '1002' },
        { value: 1, text: '1', groupKey: null },
      ],
    ];

    expect(parseHostVisibleReviewIds(data)).toEqual(new Set(['1001', '1002']));
    expect(buildHostDataSignal(data)).toBe('host-visible-review-ids:1001|1002');
  });

  it('returns null when Dashboard data is not grouped by review ID', () => {
    const data = [
      [{ value: '记录数', text: '记录数', groupKey: null }],
      [{ value: 6070, text: '6070', groupKey: null }],
    ];

    expect(parseHostVisibleReviewIds(data)).toBeNull();
    expect(buildHostDataSignal(data)).toBe('host-data-unsupported');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test -- --run src/services/stats.test.ts src/services/hostDataScope.test.ts`

Expected: FAIL because `buildScopeSnapshot` does not yet include source scope metadata and `hostDataScope.ts` does not exist.

- [ ] **Step 3: Implement scope-aware analysis guards**

Create `src/services/hostDataScope.ts`:

```ts
export type HostDataItem = {
  value: string | number | null;
  text: string | null;
  groupKey?: string | null;
};

export type HostData = HostDataItem[][];

export function parseHostVisibleReviewIds(data: unknown): Set<string> | null {
  if (!Array.isArray(data) || data.length < 2) {
    return null;
  }

  const ids = new Set<string>();
  for (const row of data.slice(1)) {
    if (!Array.isArray(row)) {
      return null;
    }
    const firstCell = row[0] as HostDataItem | undefined;
    const rawId = firstCell?.groupKey ?? firstCell?.text ?? firstCell?.value;
    if (rawId === null || rawId === undefined || String(rawId).trim() === '') {
      return null;
    }
    ids.add(String(rawId));
  }

  return ids.size ? ids : null;
}

export function buildHostDataSignal(data: unknown): string {
  const ids = parseHostVisibleReviewIds(data);
  if (!ids) {
    return 'host-data-unsupported';
  }
  return `host-visible-review-ids:${Array.from(ids).sort().join('|')}`;
}
```

Update `ScopeSnapshot` in `src/services/stats.ts`:

```ts
export type ScopeSnapshot = {
  filters: FilterState;
  fields: FieldMapping;
  model: string;
  analysisCopyVersion: string;
  totalReviews: number;
  firstRecordId: string | null;
  lastRecordId: string | null;
  source: {
    tableId: string;
    dataRange?: unknown;
    hostDataSignal?: string;
  };
};
```

Update `buildScopeSnapshot()` to accept source metadata as the fifth argument:

```ts
export function buildScopeSnapshot(
  records: ReviewRecord[],
  filters: FilterState,
  fields: FieldMapping,
  model: string,
  source: ScopeSnapshot['source'],
): ScopeSnapshot {
  return {
    filters,
    fields,
    model,
    analysisCopyVersion: ANALYSIS_COPY_VERSION,
    totalReviews: records.length,
    firstRecordId: records[0]?.recordId ?? null,
    lastRecordId: records[records.length - 1]?.recordId ?? null,
    source,
  };
}
```

Before `handleTestConnection()` and `handleUpdateAnalysis()`:

```ts
if (!config.ai.apiKey.trim()) {
  const message = '请先填写并保存 API Key';
  setError(message);
  Toast.error(message);
  return;
}
```

In `App.tsx`, store Dashboard host data in state and gate analysis:

```ts
const [hostData, setHostData] = useState<unknown[][] | null>(null);
const [scopeWarning, setScopeWarning] = useState<string | null>(null);
```

In `View` / `FullScreen` initialization, call `runtime.getData()` and save it into `hostData`. In `Create` / `Config`, call `runtime.getPreviewData(buildDataConditions(configDraft))` and save that preview result into `hostData`.

Before filtering records for analysis:

```ts
const hostVisibleReviewIds = parseHostVisibleReviewIds(hostData);
if (!hostVisibleReviewIds) {
  const message = '当前仪表盘筛选结果无法映射到评论 ID，已停止 AI 分析以避免分析到非当前范围的数据。请检查字段映射和数据源配置。';
  setScopeWarning(message);
  setError(message);
  Toast.error(message);
  return;
}
const scopedRecords = records.filter((record) => hostVisibleReviewIds.has(record.reviewId));
```

Then apply the existing user filter to `scopedRecords`, not to the full row-level `records` array:

```ts
const filtered = filterReviews(scopedRecords, filters);
```

Build the current scope with:

```ts
const sourceScope = {
  tableId: config.source.tableId,
  dataRange: config.source.dataRange,
  hostDataSignal: buildHostDataSignal(hostData),
};
const scope = buildScopeSnapshot(filtered, filters, config.source.fields, config.ai.model, sourceScope);
```

Pass `scopeWarning` into `DashboardShell`, and render it through `StateViews` as an explicit warning banner.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test -- --run src/services/stats.test.ts src/services/hostDataScope.test.ts src/services/baseRecords.test.ts src/services/aiClient.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/hostDataScope.ts src/services/hostDataScope.test.ts src/services/baseRecords.ts src/services/baseRecords.test.ts src/services/stats.ts src/services/stats.test.ts src/App.tsx src/services/aiClient.ts src/services/aiClient.test.ts
git commit -m "feat: track dashboard data scope"
```

### Task 7: UI Container, Theme, And FullScreen Adaptation

**Files:**
- Modify: `src/styles/app.css`
- Modify: `src/styles/tokens.css`
- Modify: `src/components/DashboardShell.tsx`
- Modify: `src/components/ConfigPanel.tsx`
- Modify: `src/components/StateViews.tsx`
- Modify: `src/components/TopicEvidenceModal.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Add manual verification checklist to docs/current-status.md draft**

Add this section to `docs/current-status.md` after implementation:

```md
## Dashboard Plugin UI Verification

- `?state=Create`: config layout renders without horizontal overflow.
- `?state=Config`: grouped config panel renders and save action is visible.
- `?state=View`: config panel is hidden.
- `?state=FullScreen`: transparent/dark background is applied and content does not overlap.
```

- [ ] **Step 2: Run build before UI changes**

Run: `npm run build`

Expected: PASS. If build fails before UI changes, stop and fix the pre-existing build failure first.

- [ ] **Step 3: Implement UI adaptation**

CSS requirements:

```css
html,
body {
  background: transparent !important;
  background-image: none !important;
}

.config-layout {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
}

@media (max-width: 860px) {
  .config-layout {
    grid-template-columns: 1fr;
  }
}

[theme-mode='dark'],
.full-screen {
  color-scheme: dark;
  --app-bg: transparent;
}
```

Component requirements:

- `ConfigPanel` groups fields under 数据源、字段映射、AI API、写回设置.
- `StateViews` includes states for missing field mapping, missing API key, stale cache, and unsupported host scope.
- `DashboardShell` keeps current analysis UI but accepts an optional `scopeWarning`.
- `TopicEvidenceModal` remains scrollable at compact widths.

- [ ] **Step 4: Run build and local preview checks**

Run: `npm run build`

Expected: PASS.

Optional browser verification if a dev server is available:

```bash
npm run dev -- --host 127.0.0.1
```

Open:

- `http://127.0.0.1:5173/?state=Create`
- `http://127.0.0.1:5173/?state=Config`
- `http://127.0.0.1:5173/?state=View`
- `http://127.0.0.1:5173/?state=FullScreen`

- [ ] **Step 5: Commit**

```bash
git add src/styles/app.css src/styles/tokens.css src/components/DashboardShell.tsx src/components/ConfigPanel.tsx src/components/StateViews.tsx src/components/TopicEvidenceModal.tsx src/App.tsx docs/current-status.md
git commit -m "style: adapt ui for dashboard plugin states"
```

### Task 8: Final Verification

**Files:**
- Modify: `docs/current-status.md`
- Modify: `docs/superpowers/plans/2026-06-15-feishu-dashboard-plugin-compliance-plan.md`

- [ ] **Step 1: Run full verification**

```bash
npm test -- --run
npm run build
```

- [ ] **Step 2: Record failures before fixing**

If either command fails, write the exact failing test name or TypeScript/build error into the task notes before changing code.

- [ ] **Step 3: Fix verification failures**

Allowed fixes in this task:

- Type errors caused by the new runtime/config types.
- Test expectation updates for intentional config default changes.
- Missing imports or stale references from refactoring.
- Documentation updates in `docs/current-status.md` with final commands and result.

- [ ] **Step 4: Re-run full verification**

Run: `npm test -- --run && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/current-status.md docs/superpowers/plans/2026-06-15-feishu-dashboard-plugin-compliance-plan.md
git commit -m "docs: record dashboard plugin compliance verification"
```

## Self-Review

### Spec Coverage

- Dashboard lifecycle: Task 4 and Task 5.
- `dataConditions` and `customConfig`: Task 2 and Task 5.
- Field auto-prefill and validation: Task 3.
- Data range and host filter respect: Task 6.
- API key removal and saving: Task 1 and Task 5.
- Host events: Task 4 and Task 5.
- UI adaptation: Task 7.
- Verification: Task 8.

### Placeholder Scan

- No `TBD`, `TODO`, `implement later`, or vague placeholder sections remain.
- UI task is explicitly build/manual-verification driven because this project does not currently have component UI tests.
- Host-global-filter exactness remains a known SDK-behavior dependency; the plan requires explicit warning behavior rather than a hidden fallback.

### Type Consistency

- Existing names preserved: `PluginConfig`, `FieldMapping`, `RuntimeConfig`, `DashboardRuntime`, `ScopeSnapshot`.
- New names introduced consistently: `buildDataConditions`, `getPrimaryDataCondition`, `mergeConfigWithDataCondition`, `suggestFieldMapping`, `getMissingRequiredFields`.
- `buildScopeSnapshot` signature change is explicitly covered by Task 6 and its tests.

## Execution Record

- 2026-06-15: Implemented Tasks 1-8 on branch `codex/feishu-dashboard-plugin-compliance`.
- Final verification: `npm test -- --run` passed 16 test files and 117 tests.
- Final build: `npm run build` passed; remaining output is the existing Sass deprecation warning and Vite chunk size warning.
- Browser checks: `?state=Create`, `?state=Config`, `?state=View`, and `?state=FullScreen` were verified on desktop and 390px mobile viewport for the Task 7 UI checklist.
