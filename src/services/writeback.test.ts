import { describe, expect, it, vi } from 'vitest';
import { FieldType } from '@lark-base-open/js-sdk';
import { FIXTURE_ANALYSIS_RESULT } from '../fixtures/analysis';
import type { DashboardRuntime, RuntimeConfig, RuntimeTable } from '../runtime/sdk';
import { writeAnalysisResult } from './writeback';

describe('writeAnalysisResult', () => {
  it('skips when writeback is disabled', async () => {
    const runtime = fakeRuntime();
    const result = await writeAnalysisResult(runtime, FIXTURE_ANALYSIS_RESULT, { enabled: false, confirmed: false });

    expect(result.status).toBe('skipped');
    expect(runtime.addRecords).not.toHaveBeenCalled();
  });

  it('skips when user cannot edit the Base', async () => {
    const runtime = fakeRuntime({ canEdit: false });
    const result = await writeAnalysisResult(runtime, FIXTURE_ANALYSIS_RESULT, { enabled: true, confirmed: true });

    expect(result).toMatchObject({ status: 'skipped', reason: 'permission_denied' });
  });

  it('skips before the first writeback confirmation', async () => {
    const runtime = fakeRuntime();
    const result = await writeAnalysisResult(runtime, FIXTURE_ANALYSIS_RESULT, { enabled: true, confirmed: false });

    expect(result).toMatchObject({ status: 'skipped', reason: 'unconfirmed' });
    expect(runtime.addTable).not.toHaveBeenCalled();
    expect(runtime.addRecords).not.toHaveBeenCalled();
  });

  it('creates missing writeback tables and writes batch plus topic rows', async () => {
    const runtime = fakeRuntime();
    const result = await writeAnalysisResult(runtime, FIXTURE_ANALYSIS_RESULT, { enabled: true, confirmed: true });

    expect(result.status).toBe('written');
    expect(runtime.addTable).toHaveBeenCalledTimes(2);
    expect(runtime.addRecords).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runtime.addRecords).mock.calls[0][1]).toHaveLength(1);
    expect(vi.mocked(runtime.addRecords).mock.calls[1][1]).toHaveLength(
      FIXTURE_ANALYSIS_RESULT.positiveTopics.length + FIXTURE_ANALYSIS_RESULT.negativeTopics.length,
    );
  });
});

function fakeRuntime(options: { canEdit?: boolean; tables?: RuntimeTable[] } = {}): DashboardRuntime {
  const tables = [...(options.tables ?? [])];
  return {
    isFixture: true,
    getState: () => 'View',
    getTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    getConfig: vi.fn(async (): Promise<RuntimeConfig> => ({ dataConditions: [] })),
    saveConfig: vi.fn(async () => true),
    onConfigChange: vi.fn(() => () => undefined),
    getTableList: vi.fn(async () => tables),
    getFieldMetaList: vi.fn(async (tableId: string) => {
      const fieldNames = tableId.includes('batch') ? batchFieldNames : topicFieldNames;
      return fieldNames.map((fieldName) => ({
        fieldId: `${tableId}-${fieldName}`,
        fieldName,
        fieldType: FieldType.Text,
      }));
    }),
    getTableDataRange: vi.fn(),
    getCategories: vi.fn(),
    readRecordsPage: vi.fn(),
    readRecordsByIds: vi.fn(),
    canEditBase: vi.fn(async () => options.canEdit ?? true),
    addTable: vi.fn(async (name: string) => {
      const tableId = name === 'AI分析批次' ? 'batch-table' : 'topic-table';
      tables.push({ tableId, tableName: name });
      return { tableId };
    }),
    addRecords: vi.fn(async (_tableId, records) => records.map((_, index) => `rec-write-${index}`)),
    setRendered: vi.fn(),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
  };
}

const batchFieldNames = [
  '分析批次 ID',
  '酒店',
  '周期类型',
  '开始日期',
  '结束日期',
  '总评论数',
  '好评数',
  '差评/风险数',
  '平均评分',
  '回复率',
  '生成时间',
  '模型',
  '完整结果 JSON',
];

const topicFieldNames = [
  '分析批次 ID',
  '方向',
  '排名',
  '主题',
  '类别',
  '命中评论数',
  '占比',
  '总结',
  '建议动作',
  '关联评论 record_id 列表 JSON',
  '证据片段 JSON',
];
