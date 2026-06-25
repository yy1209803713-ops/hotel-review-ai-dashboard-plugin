import { describe, expect, it, vi } from 'vitest';
import { createFacilityAnalysisBaseExporterFactory } from './facilityAnalysisBaseExporter';
import type { FacilityAnalysisStore, FacilityAnalysisStoredResult } from './facilityAnalysisRunner';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';

describe('createFacilityAnalysisBaseExporterFactory', () => {
  it('creates missing tables, fills missing fields, exports rows, and marks success', async () => {
    const store = createStore();
    const runtime = createRuntime({ tables: [], fields: {} });
    const exporter = createFacilityAnalysisBaseExporterFactory({
      env: { LARK_BASE_AUTH_CODE: 'auth-code-a' },
      store,
      createRuntime: () => runtime as unknown as LarkOpenApiRuntime,
    });

    await exporter.export(minimalSavedResult());

    expect(runtime.addTable).toHaveBeenCalledTimes(3);
    expect(runtime.addTable).toHaveBeenCalledWith('设施和政策变动汇总', expect.arrayContaining([
      expect.objectContaining({ name: '分析时间', type: 'datetime', style: { format: 'yyyy/MM/dd HH:mm' } }),
      expect.objectContaining({ name: '数据采集日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
      expect.objectContaining({ name: '对比日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
      expect.objectContaining({ name: '当前酒店数', type: 'number', style: expect.objectContaining({ precision: 0 }) }),
      expect.objectContaining({ name: '变动明细', type: 'text' }),
    ]));
    expect(runtime.addTable).toHaveBeenCalledWith('设施酒店变动明细', expect.arrayContaining([
      expect.objectContaining({ name: '分析时间', type: 'datetime', style: { format: 'yyyy/MM/dd HH:mm' } }),
      expect.objectContaining({ name: '数据采集日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
      expect.objectContaining({ name: '对比日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
    ]));
    expect(runtime.addTable).toHaveBeenCalledWith('设施变动项明细', expect.arrayContaining([
      expect.objectContaining({ name: '分析时间', type: 'datetime', style: { format: 'yyyy/MM/dd HH:mm' } }),
      expect.objectContaining({ name: '数据采集日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
      expect.objectContaining({ name: '对比日期', type: 'datetime', style: { format: 'yyyy/MM/dd' } }),
    ]));
    expect(runtime.addField).not.toHaveBeenCalled();
    expect(runtime.addRecords).toHaveBeenCalledTimes(3);
    expect(runtime.addRecords).toHaveBeenCalledWith(expect.any(String), [
      {
        fields: expect.objectContaining({
          分析时间: Date.parse('2026-06-23T12:05:00.000+08:00'),
          数据采集日期: Date.parse('2026-06-23T00:00:00+08:00'),
          对比日期: Date.parse('2026-06-22T00:00:00+08:00'),
          变动明细: 'A酒店：早餐价格上调10元',
        }),
      },
    ]);
    expect(runtime.addRecords).toHaveBeenCalledWith(expect.any(String), [
      {
        fields: expect.objectContaining({
          分析时间: Date.parse('2026-06-23T12:05:00.000+08:00'),
          数据采集日期: Date.parse('2026-06-23T00:00:00+08:00'),
          对比日期: Date.parse('2026-06-22T00:00:00+08:00'),
          批次记录ID: 'rec-1',
          酒店名称: 'A酒店',
        }),
      },
    ]);
    expect(store.markExportStatus).toHaveBeenCalledWith(expect.objectContaining({
      resultId: 'facility-result-1',
      status: 'success',
      stage: 'done',
    }));
  });

  it('fills missing fields when tables already exist', async () => {
    const store = createStore();
    const runtime = createRuntime({
      tables: [
        { tableId: 'tbl-batch', tableName: '设施和政策变动汇总' },
        { tableId: 'tbl-hotel', tableName: '设施酒店变动明细' },
        { tableId: 'tbl-change', tableName: '设施变动项明细' },
      ],
      fields: {
        'tbl-batch': [{ fieldId: 'f1', fieldName: '结果ID', fieldType: 1 }],
        'tbl-hotel': [{ fieldId: 'f2', fieldName: '结果ID', fieldType: 1 }],
        'tbl-change': [{ fieldId: 'f3', fieldName: '结果ID', fieldType: 1 }],
      },
    });
    const exporter = createFacilityAnalysisBaseExporterFactory({
      env: { LARK_BASE_AUTH_CODE: 'auth-code-a' },
      store,
      createRuntime: () => runtime as unknown as LarkOpenApiRuntime,
    });

    await exporter.export(minimalSavedResult());

    expect(runtime.addTable).not.toHaveBeenCalled();
    expect(runtime.addField).toHaveBeenCalled();
  });

  it('omits empty datetime fields instead of writing empty strings', async () => {
    const store = createStore();
    const runtime = createRuntime({ tables: [], fields: {} });
    const exporter = createFacilityAnalysisBaseExporterFactory({
      env: { LARK_BASE_AUTH_CODE: 'auth-code-a' },
      store,
      createRuntime: () => runtime as unknown as LarkOpenApiRuntime,
    });
    const result = minimalSavedResult();
    result.result.hotelDiffs[0].previousCollectedAt = undefined;

    await exporter.export(result);

    const writtenFields = runtime.addRecords.mock.calls.flatMap((call) =>
      (call[1] as Array<{ fields: Record<string, unknown> }>).map((record) => record.fields),
    );
    expect(writtenFields.every((fields) => fields.对比日期 !== '')).toBe(true);
  });

  it('marks failed when export throws', async () => {
    const store = createStore();
    const runtime = createRuntime({ tables: [], fields: {} });
    runtime.addRecords.mockRejectedValueOnce(new Error('boom'));
    const exporter = createFacilityAnalysisBaseExporterFactory({
      env: { LARK_BASE_AUTH_CODE: 'auth-code-a' },
      store,
      createRuntime: () => runtime as unknown as LarkOpenApiRuntime,
    });

    await expect(exporter.export(minimalSavedResult())).rejects.toThrow('boom');
    expect(store.markExportStatus).toHaveBeenCalledWith(expect.objectContaining({
      resultId: 'facility-result-1',
      status: 'failed',
      stage: 'export_error',
      error: 'boom',
    }));
  });
});

function createStore(): FacilityAnalysisStore & { markExportStatus: ReturnType<typeof vi.fn> } {
  return {
    saveResult: vi.fn(),
    markExportStatus: vi.fn(async (input) => ({ ...minimalSavedResult(), exportStatus: input.status, exportStage: input.stage, exportError: input.error, exportedAt: input.exportedAt })),
  } as unknown as FacilityAnalysisStore & { markExportStatus: ReturnType<typeof vi.fn> };
}

function createRuntime(input: { tables: Array<{ tableId: string; tableName: string }>; fields: Record<string, Array<{ fieldId: string; fieldName: string; fieldType: string | number }>> }) {
  return {
    getTableList: vi.fn(async () => input.tables),
    getFieldMetaList: vi.fn(async (tableId: string) => input.fields[tableId] ?? []),
    clearFieldMetaCache: vi.fn(),
    readRecordsPage: vi.fn(async () => ({ records: [], hasMore: false })),
    addTable: vi.fn(async (_name: string) => ({ tableId: `tbl-${Math.random().toString(16).slice(2, 8)}` })),
    addField: vi.fn(async (_tableId: string) => ({ fieldId: `fld-${Math.random().toString(16).slice(2, 8)}` })),
    addRecords: vi.fn(async (_tableId: string, records: Array<{ fields: Record<string, unknown> }>) => records.map((_, index) => `rec-${index + 1}`)),
    setRecords: vi.fn(),
  };
}

function minimalSavedResult(): FacilityAnalysisStoredResult {
  return {
    resultId: 'facility-result-1',
    tenantKey: 'tenant-a',
    baseToken: 'base-token-a',
    tableId: 'tbl-facility',
    viewId: 'view-facility',
    sourceRecordCount: 1,
    createdAt: '2026-06-23T12:05:01.000Z',
    exportStatus: 'pending',
    result: {
      analysisId: 'facility-analysis-1',
      generatedAt: '2026-06-23T12:05:00.000+08:00',
      collectionDate: '2026-06-23',
      summary: {
        collectionDate: '2026-06-23',
        currentHotelCount: 1,
        unchangedHotelCount: 0,
        changedHotelCount: 0,
        newHotelCount: 1,
      },
      dailySummary: '本次分析1家酒店：1家新采集。',
      hotelDiffs: [
        {
          hotelId: 'A',
          hotelName: 'A酒店',
          status: 'new',
          currentCollectedAt: '2026-06-23 12:00:00',
          previousCollectedAt: '2026-06-22T12:00:00.000',
          currentSnapshot: { raw: {} },
          changes: [
            {
              kind: 'updated',
              field: '早餐价格',
              before: '88',
              after: '98',
              description: '早餐价格由“88”变为“98”',
            },
          ],
          aiSummary: 'A酒店：早餐价格上调10元。',
        },
      ],
    },
  };
}
