import { describe, expect, it, vi } from 'vitest';
import {
  createFacilityAnalysisRunner,
  type FacilityAnalysisStore,
} from './facilityAnalysisRunner';
import { createFacilityAnalysisBaseExporterFactory } from './facilityAnalysisBaseExporter';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';

describe('createFacilityAnalysisRunner', () => {
  it('reads historical facility records from Feishu Base runtime, analyzes latest collection, and saves result', async () => {
    const store = createMemoryFacilityAnalysisStore();
    const runtime = createRuntime([
      {
        records: [
          baseRecord('old-a', '2026-06-13 12:00:00', 'A', 'A酒店', '58'),
          baseRecord('old-b', '2026-06-22 12:00:00', 'B', 'B酒店', undefined, [{ code: 100, title: '无线WIFI免费' }]),
        ],
        hasMore: true,
        pageToken: 'next',
      },
      {
        records: [
          baseRecord('current-a', '2026-06-23 12:00:00', 'A', 'A酒店', '68'),
          baseRecord('current-b', '2026-06-23 12:00:00', 'B', 'B酒店', undefined, [
            { code: 100, title: '无线WIFI免费' },
            { code: 201, title: '代客泊车服务' },
          ]),
        ],
        hasMore: false,
      },
    ]);
    const runner = createFacilityAnalysisRunner({
      store,
      createRuntime: () => runtime,
      summarizeChanges: async ({ hotelDiffs }) => ({
        dailySummary: '本次分析2家酒店：2家有变动。',
        hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, diff.changes.map((change) => change.description).join('；')])),
      }),
      now: () => '2026-06-23T12:05:00.000+08:00',
    });

    const saved = await runner.run({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
    });

    expect(runtime.readRecordsPage).toHaveBeenCalledTimes(2);
    expect(runtime.readRecordsPage).toHaveBeenNthCalledWith(1, 'tbl-facility', {
      viewId: 'view-facility',
      pageSize: 500,
      pageToken: undefined,
    });
    expect(runtime.readRecordsPage).toHaveBeenNthCalledWith(2, 'tbl-facility', {
      viewId: 'view-facility',
      pageSize: 500,
      pageToken: 'next',
    });
    expect(saved).toMatchObject({
      resultId: 'facility-result-1',
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
      sourceRecordCount: 4,
      result: {
        summary: {
          currentHotelCount: 2,
          changedHotelCount: 2,
        },
      },
    });
    expect(store.saved[0].result.hotelDiffs.map((diff) => diff.hotelId)).toEqual(['A', 'B']);
  });

  it('exports saved facility results to Feishu Base when a base exporter is provided', async () => {
    const store = createMemoryFacilityAnalysisStore();
    const runtime = createRuntime([
      {
        records: [
          baseRecord('current-a', '2026-06-18 12:00:00', 'A', 'A酒店', '88'),
        ],
        hasMore: false,
      },
    ]);
    const baseRuntime = createExportRuntime();
    const exporter = createFacilityAnalysisBaseExporterFactory({
      env: { LARK_BASE_AUTH_CODE: 'auth-code-a' },
      createRuntime: () => baseRuntime as unknown as LarkOpenApiRuntime,
    });
    const runner = createFacilityAnalysisRunner({
      store,
      createRuntime: () => runtime,
      summarizeChanges: async ({ hotelDiffs }) => ({
        dailySummary: '本次分析1家酒店：0家有变动，1家新采集。',
        hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, diff.hotelName])),
      }),
      baseExporter: exporter,
      now: () => '2026-06-18T12:05:00.000+08:00',
    });

    await runner.run({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
    });

    expect(baseRuntime.addTable).toHaveBeenCalledWith('设施和政策变动汇总', expect.any(Array));
    expect(baseRuntime.addTable).toHaveBeenCalledWith('设施酒店变动明细', expect.any(Array));
    expect(baseRuntime.addTable).toHaveBeenCalledWith('设施变动项明细', expect.any(Array));
    expect(baseRuntime.addRecords).toHaveBeenCalled();
  });

  it('reanalyzes each collection date in the requested range after clearing previous exports', async () => {
    const store = createMemoryFacilityAnalysisStore();
    const runtime = createRuntime([
      {
        records: [
          baseRecord('old-a', '2026-06-24 12:00:00', 'A', 'A酒店', '58'),
          baseRecord('current-a-25', '2026-06-25 12:00:00', 'A', 'A酒店', '68'),
          baseRecord('current-b-26', '2026-06-26 12:00:00', 'B', 'B酒店', '88'),
        ],
        hasMore: false,
      },
    ]);
    const baseExporter = {
      export: vi.fn(),
      clearDateRange: vi.fn(),
    };
    const runner = createFacilityAnalysisRunner({
      store,
      createRuntime: () => runtime,
      summarizeChanges: async ({ collectionDate, hotelDiffs }) => ({
        dailySummary: `本次分析${collectionDate}共${hotelDiffs.length}家酒店。`,
        hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, diff.hotelName])),
      }),
      baseExporter,
      now: () => '2026-06-26T12:05:00.000+08:00',
    });

    const saved = await runner.run({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
      reanalyze: true,
      reanalyzeDateRange: {
        startDate: '2026-06-25',
        endDate: '2026-06-26',
      },
    });

    expect(baseExporter.clearDateRange).toHaveBeenCalledWith({
      baseToken: 'base-token-a',
      startDate: '2026-06-25',
      endDate: '2026-06-26',
    });
    expect(store.saved.map((item) => item.result.collectionDate)).toEqual(['2026-06-25', '2026-06-26']);
    expect(baseExporter.export).toHaveBeenCalledTimes(2);
    expect(saved.result.collectionDate).toBe('2026-06-26');
  });

  it('does not clear previous exports when the reanalysis range has a missing collection date', async () => {
    const store = createMemoryFacilityAnalysisStore();
    const runtime = createRuntime([
      {
        records: [
          baseRecord('current-a-25', '2026-06-25 12:00:00', 'A', 'A酒店', '68'),
        ],
        hasMore: false,
      },
    ]);
    const baseExporter = {
      export: vi.fn(),
      clearDateRange: vi.fn(),
    };
    const runner = createFacilityAnalysisRunner({
      store,
      createRuntime: () => runtime,
      summarizeChanges: async ({ collectionDate, hotelDiffs }) => ({
        dailySummary: `本次分析${collectionDate}共${hotelDiffs.length}家酒店。`,
        hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, diff.hotelName])),
      }),
      baseExporter,
      now: () => '2026-06-26T12:05:00.000+08:00',
    });

    await expect(runner.run({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      reanalyze: true,
      reanalyzeDateRange: {
        startDate: '2026-06-25',
        endDate: '2026-06-26',
      },
    })).rejects.toThrow('no facility records found for collection date 2026-06-26');

    expect(baseExporter.clearDateRange).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });
});

function createMemoryFacilityAnalysisStore(): FacilityAnalysisStore & { saved: Array<Parameters<FacilityAnalysisStore['saveResult']>[0]> } {
  const saved: Array<Parameters<FacilityAnalysisStore['saveResult']>[0]> = [];
  return {
    saved,
    async saveResult(input) {
      saved.push(input);
      return {
        ...input,
        resultId: `facility-result-${saved.length}`,
        createdAt: input.result.generatedAt,
      };
    },
  };
}

function createRuntime(pages: Array<{ records: Array<{ recordId: string; fields: Record<string, unknown> }>; hasMore: boolean; pageToken?: string }>): LarkOpenApiRuntime {
  const readRecordsPage = vi.fn(async (_tableId: string, params: { pageToken?: unknown }) => {
    const page = params.pageToken ? pages[1] : pages[0];
    return page;
  });
  return {
    getTableList: vi.fn(),
    getFieldMetaList: vi.fn(),
    clearFieldMetaCache: vi.fn(),
    readRecordsPage,
    addTable: vi.fn(),
    addRecords: vi.fn(),
    setRecords: vi.fn(),
  } as unknown as LarkOpenApiRuntime;
}

function createExportRuntime() {
  return {
    getTableList: vi.fn(async () => []),
    getFieldMetaList: vi.fn(async () => []),
    clearFieldMetaCache: vi.fn(),
    readRecordsPage: vi.fn(async () => ({ records: [], hasMore: false })),
    addTable: vi.fn(async (_name: string) => ({ tableId: `tbl-${Math.random().toString(16).slice(2, 8)}` })),
    addField: vi.fn(async (_tableId: string) => ({ fieldId: `fld-${Math.random().toString(16).slice(2, 8)}` })),
    addRecords: vi.fn(async (_tableId: string, records: Array<{ fields: Record<string, unknown> }>) =>
      records.map((_, index) => `rec-${index + 1}`),
    ),
    setRecords: vi.fn(),
  };
}

function baseRecord(
  id: string,
  collectedAt: string,
  hotelId: string,
  hotelName: string,
  breakfastPrice?: string,
  facilities: Array<{ code: number; title: string }> = [],
) {
  return {
    recordId: id,
    fields: {
      id,
      采集日期: collectedAt.slice(0, 10),
      采集时间: collectedAt,
      酒店ID: hotelId,
      酒店名称: hotelName,
      早餐价格: breakfastPrice ?? null,
      酒店设施JSON: JSON.stringify({
        hotelFacilityPop: {
          hotelPopularFacility: {
            title: '设施服务',
            list: facilities,
          },
        },
      }),
    },
  };
}
