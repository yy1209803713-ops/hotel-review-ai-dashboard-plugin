import { describe, expect, it, vi } from 'vitest';
import { createAnalysisPreflightSyncRunner, toReviewSyncSourceKey } from './analysisPreflightSync';
import type { BackendAnalysisConfig } from './backendAnalysis';
import type { ReviewSyncService } from './reviewSync';

const postgresConfig: BackendAnalysisConfig = {
  tenantKey: 'tenant-a',
  baseUserId: 'user-a',
  pluginInstanceId: 'plugin-a',
  baseToken: 'base-token-a',
  model: 'qwen-plus',
  source: {
    kind: 'postgres',
    sourceId: 'base-token-a:tbl-review:vew-active',
    upstreamSourceKind: 'feishu_base',
    tableId: 'tbl-review',
    viewId: 'vew-active',
    fieldMapping: {
      content: 'fld-review',
      rating: 'fld-rating',
      hotelName: 'fld-hotel',
    },
  },
  filters: {},
  dashboardDataConditions: {},
  configId: 'config-a',
  configVersion: 1,
  updatedAt: '2026-06-24T01:00:00.000Z',
};

describe('analysis preflight sync', () => {
  it('builds the sync sourceKey from a postgres analysis config', () => {
    expect(toReviewSyncSourceKey(postgresConfig)).toEqual({
      tenantKey: 'tenant-a',
      sourceKind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review:vew-active',
      baseToken: 'base-token-a',
      tableId: 'tbl-review',
      viewId: 'vew-active',
      fieldMapping: {
        content: 'fld-review',
        rating: 'fld-rating',
        hotelName: 'fld-hotel',
      },
    });
  });

  it('runs full sync with the analysis_preflight trigger', async () => {
    const runFullSync = vi.fn(async () => ({ jobId: 'sync-job-1' }));
    const runner = createAnalysisPreflightSyncRunner({ runFullSync } as unknown as ReviewSyncService);

    await runner.run({ config: postgresConfig });

    expect(runFullSync).toHaveBeenCalledWith(toReviewSyncSourceKey(postgresConfig), 'analysis_preflight');
  });
});
