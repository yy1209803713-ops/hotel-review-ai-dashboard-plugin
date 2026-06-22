import { describe, expect, it } from 'vitest';
import { BackendAnalysisError } from './backendAnalysis';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';
import { FeishuBaseReviewSource } from './reviewSource';

describe('FeishuBaseReviewSource', () => {
  it('reads paged Base records, exposes metrics, and generates stable SourceVersion', async () => {
    const runtime = createRuntime([
      {
        records: [
          { recordId: 'rec-1', fields: { 'fld-review': 'Great view', 'fld-rating': 5, 'fld-hotel': 'Hotel A' } },
          { recordId: 'rec-2', fields: { 'fld-review': 'Noisy room', 'fld-rating': 2, 'fld-hotel': 'Hotel A' } },
        ],
        hasMore: true,
        pageToken: 'next-page',
      },
      {
        records: [{ recordId: 'rec-3', fields: { 'fld-review': 'Helpful staff', 'fld-rating': 4, 'fld-hotel': 'Hotel B' } }],
        hasMore: false,
      },
    ]);
    const source = new FeishuBaseReviewSource({ runtime, now: () => 1_000 });
    const query = {
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-review',
      viewId: 'vew-active',
      fieldMapping: {
        content: 'fld-review',
        rating: 'fld-rating',
        hotelName: 'fld-hotel',
      },
      filters: { sentiment: ['positive', 'negative'] },
    };

    const reviews = await source.listReviews(query);
    const metrics = source.getLastMetrics();
    const firstVersion = await source.getSourceVersion(query);
    const secondVersion = await source.getSourceVersion(query);

    expect(runtime.readCalls).toEqual([
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: undefined } },
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: 'next-page' } },
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: undefined } },
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: 'next-page' } },
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: undefined } },
      { tableId: 'tbl-review', params: { viewId: 'vew-active', pageSize: 100, pageToken: 'next-page' } },
    ]);
    expect(reviews).toEqual([
      {
        recordId: 'rec-1',
        fields: { 'fld-review': 'Great view', 'fld-rating': 5, 'fld-hotel': 'Hotel A' },
        mappedFields: { content: 'Great view', rating: 5, hotelName: 'Hotel A' },
        content: 'Great view',
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        recordId: 'rec-2',
        fields: { 'fld-review': 'Noisy room', 'fld-rating': 2, 'fld-hotel': 'Hotel A' },
        mappedFields: { content: 'Noisy room', rating: 2, hotelName: 'Hotel A' },
        content: 'Noisy room',
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        recordId: 'rec-3',
        fields: { 'fld-review': 'Helpful staff', 'fld-rating': 4, 'fld-hotel': 'Hotel B' },
        mappedFields: { content: 'Helpful staff', rating: 4, hotelName: 'Hotel B' },
        content: 'Helpful staff',
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(metrics).toEqual({
      baseReadDurationMs: 0,
      recordCount: 3,
      pageCount: 2,
      recordsPerSecond: 3_000,
      apiRetryCount: 0,
      rateLimitCount: 0,
      readErrorCount: 0,
    });
    expect(firstVersion).toEqual(secondVersion);
    expect(firstVersion).toMatchObject({
      kind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review:vew-active',
      recordCount: 3,
      generatedAt: '1970-01-01T00:00:01.000Z',
    });
    expect(firstVersion.version).toBe(`source-${firstVersion.contentHash.slice(0, 16)}`);
  });

  it('keeps SourceVersion stable when paged records arrive in a different order', async () => {
    const runtimeA = createRuntime([
      {
        records: [
          { recordId: 'rec-1', fields: { 'fld-review': 'Great view' } },
          { recordId: 'rec-2', fields: { 'fld-review': 'Noisy room' } },
        ],
        hasMore: false,
      },
    ]);
    const runtimeB = createRuntime([
      {
        records: [
          { recordId: 'rec-2', fields: { 'fld-review': 'Noisy room' } },
          { recordId: 'rec-1', fields: { 'fld-review': 'Great view' } },
        ],
        hasMore: false,
      },
    ]);
    const query = {
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-review',
      fieldMapping: {
        content: 'fld-review',
      },
      filters: {},
    };

    const firstVersion = await new FeishuBaseReviewSource({ runtime: runtimeA, now: () => 1_000 }).getSourceVersion(query);
    const secondVersion = await new FeishuBaseReviewSource({ runtime: runtimeB, now: () => 1_000 }).getSourceVersion(query);

    expect(firstVersion.contentHash).toBe(secondVersion.contentHash);
    expect(firstVersion.version).toBe(secondVersion.version);
    expect(firstVersion.recordCount).toBe(2);
    expect(secondVersion.recordCount).toBe(2);
  });

  it('fails with read_source stage when a mapped field is missing from a record', async () => {
    const runtime = createRuntime([
      {
        records: [{ recordId: 'rec-1', fields: { 'fld-rating': 5 } }],
        hasMore: false,
      },
    ]);
    const source = new FeishuBaseReviewSource({ runtime, now: () => 1_000 });

    await expect(
      source.listReviews({
        tenantKey: 'tenant-a',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-review', rating: 'fld-rating' },
        filters: {},
      }),
    ).rejects.toMatchObject({
      stage: 'read_source',
      message: 'mapped field content(fld-review) is missing in record rec-1',
    });
    expect(source.getLastMetrics()).toMatchObject({
      recordCount: 0,
      pageCount: 1,
      readErrorCount: 1,
    });
  });

  it('wraps OpenAPI read failures with read_source stage and preserves metrics', async () => {
    const runtime = createRuntime([
      {
        records: [{ recordId: 'rec-1', fields: { 'fld-review': 'Great view' } }],
        hasMore: true,
        pageToken: 'next-page',
      },
    ]);
    runtime.readRecordsPage = async (tableId, params) => {
      runtime.readCalls.push({ tableId, params });
      if (params.pageToken === 'next-page') {
        throw new Error('Feishu rate limited');
      }
      return { records: [{ recordId: 'rec-1', fields: { 'fld-review': 'Great view' } }], hasMore: true, pageToken: 'next-page' };
    };
    const source = new FeishuBaseReviewSource({ runtime, now: () => 1_000 });

    await expect(
      source.listReviews({
        tenantKey: 'tenant-a',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-review' },
        filters: {},
      }),
    ).rejects.toBeInstanceOf(BackendAnalysisError);
    await expect(
      source.listReviews({
        tenantKey: 'tenant-a',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-review' },
        filters: {},
      }),
    ).rejects.toMatchObject({
      stage: 'read_source',
      message: 'Feishu rate limited',
    });
    expect(source.getLastMetrics()).toMatchObject({
      pageCount: 2,
      readErrorCount: 1,
      apiRetryCount: 0,
      rateLimitCount: 1,
    });
  });

  it('counts rate limit errors in metrics when the runtime reports a 429-style failure', async () => {
    const runtime = createRuntime([
      {
        records: [{ recordId: 'rec-1', fields: { 'fld-review': 'Great view' } }],
        hasMore: true,
        pageToken: 'next-page',
      },
    ]);
    runtime.readRecordsPage = async (tableId, params) => {
      runtime.readCalls.push({ tableId, params });
      if (params.pageToken === 'next-page') {
        const error = new Error('rate limited');
        (error as Error & { status?: number }).status = 429;
        throw error;
      }
      return { records: [{ recordId: 'rec-1', fields: { 'fld-review': 'Great view' } }], hasMore: true, pageToken: 'next-page' };
    };
    const source = new FeishuBaseReviewSource({ runtime, now: () => 1_000 });

    await expect(
      source.listReviews({
        tenantKey: 'tenant-a',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-review' },
        filters: {},
      }),
    ).rejects.toMatchObject({
      stage: 'read_source',
      message: 'rate limited',
    });
    expect(source.getLastMetrics()).toMatchObject({
      pageCount: 2,
      readErrorCount: 1,
      rateLimitCount: 1,
    });
  });
});

function createRuntime(pages: Awaited<ReturnType<LarkOpenApiRuntime['readRecordsPage']>>[]): LarkOpenApiRuntime & {
  readCalls: Array<{ tableId: string; params: { viewId?: string; pageSize: number; pageToken?: unknown } }>;
} {
  const readCalls: Array<{ tableId: string; params: { viewId?: string; pageSize: number; pageToken?: unknown } }> = [];
  return {
    readCalls,
    async readRecordsPage(tableId, params) {
      readCalls.push({ tableId, params });
      const pageIndex = params.pageToken ? 1 : 0;
      return pages[pageIndex];
    },
    async getTableList() {
      return [];
    },
    async getFieldMetaList() {
      return [];
    },
    clearFieldMetaCache() {},
    async addTable() {
      return { tableId: 'tbl-new' };
    },
    async addRecords() {
      return [];
    },
    async setRecords() {
      return [];
    },
  };
}
