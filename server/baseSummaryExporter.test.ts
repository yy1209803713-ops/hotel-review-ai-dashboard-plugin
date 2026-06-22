import { describe, expect, it, vi } from 'vitest';
import { BackendAnalysisError, type AnalysisResult } from './backendAnalysis';
import { buildBaseSummaryExportPayload, createFeishuBaseSummaryExporterFactory } from './baseSummaryExporter';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';

describe('buildBaseSummaryExportPayload', () => {
  it('keeps only user-readable summary fields out of the exported rows', () => {
    const payload = buildBaseSummaryExportPayload(createAnalysisResult());

    expect(payload.summaryRow).toMatchObject({
      '结果 ID': 'result-1',
      '任务 ID': 'job-1',
      酒店: '全部',
      总评论数: 2,
      好评数: 1,
      '差评/风险数': 1,
      平均评分: 4.5,
      回复率: 0.5,
      模型: 'qwen-plus',
    });
    expect(payload.topicRows).toHaveLength(2);
    expect(payload.topicRows[0]).toMatchObject({
      '结果 ID': 'result-1',
      方向: '好评',
      排名: 1,
      主题: '位置便利',
      '代表证据片段': '位置很好\n交通方便',
    });

    const serializedRows = JSON.stringify([payload.summaryRow, ...payload.topicRows]);
    expect(serializedRows).not.toContain('backend-owned-v1');
    expect(serializedRows).not.toContain('pipelineVersion');
    expect(serializedRows).not.toContain('result_json');
    expect(serializedRows).not.toContain('cache');
    expect(serializedRows).not.toContain('错误栈');
  });
});

describe('createFeishuBaseSummaryExporterFactory', () => {
  it('creates only user-readable Base summary tables on explicit export', async () => {
    const runtime = fakeRuntime();
    const createRuntime = vi.fn(() => runtime);
    const exporter = createFeishuBaseSummaryExporterFactory({
      env: { LARK_APP_ID: 'cli-a', LARK_APP_SECRET: 'secret-a' },
      createRuntime,
    });

    await expect(
      exporter.exportBaseSummary({
        result: createAnalysisResult(),
        config: {
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          configId: 'config-1',
          configVersion: 1,
          updatedAt: 'now',
          baseToken: 'base-token-a',
          model: 'qwen-plus',
          source: {
            kind: 'feishu_base',
            tableId: 'tbl-review',
            fieldMapping: { content: 'fld-content' },
          },
        },
      }),
    ).resolves.toMatchObject({
      resultId: 'result-1',
      summaryTableId: 'tbl-summary',
      topicTableId: 'tbl-topic',
      summaryRecordIds: ['rec-summary-1'],
      topicRecordIds: ['rec-topic-1', 'rec-topic-2'],
    });

    expect(createRuntime).toHaveBeenCalledWith({
      baseToken: 'base-token-a',
      appId: 'cli-a',
      appSecret: 'secret-a',
    });
    expect(runtime.addTable).toHaveBeenCalledWith('AI分析摘要', expect.any(Array));
    expect(runtime.addTable).toHaveBeenCalledWith('AI主题摘要', expect.any(Array));
    expect(runtime.addTable).not.toHaveBeenCalledWith('AI评论证据缓存', expect.anything());
    expect(runtime.addTable).not.toHaveBeenCalledWith('AI评论主题映射缓存', expect.anything());
  });

  it('surfaces missing Feishu app credentials at export_summary stage', async () => {
    const exporter = createFeishuBaseSummaryExporterFactory({
      env: { LARK_APP_ID: '', LARK_APP_SECRET: 'secret-a' },
      createRuntime: vi.fn(),
    });

    await expect(
      exporter.exportBaseSummary({
        result: createAnalysisResult(),
        config: {
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          configId: 'config-1',
          configVersion: 1,
          updatedAt: 'now',
          baseToken: 'base-token-a',
          source: {
            kind: 'feishu_base',
            tableId: 'tbl-review',
            fieldMapping: { content: 'fld-content' },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'BackendAnalysisError',
      stage: 'export_summary',
      message: 'LARK_APP_ID is required for base summary export',
    } satisfies Partial<BackendAnalysisError>);
  });
});

function fakeRuntime(): LarkOpenApiRuntime {
  return {
    getTableList: vi.fn(async () => []),
    getFieldMetaList: vi.fn(async () => []),
    clearFieldMetaCache: vi.fn(),
    readRecordsPage: vi.fn(),
    addTable: vi.fn(async (name: string) => ({ tableId: name === 'AI分析摘要' ? 'tbl-summary' : 'tbl-topic' })),
    addRecords: vi.fn(async (tableId: string, records) =>
      records.map((_, index) => (tableId === 'tbl-summary' ? `rec-summary-${index + 1}` : `rec-topic-${index + 1}`)),
    ),
    setRecords: vi.fn(),
  };
}

function createAnalysisResult(): AnalysisResult {
  return {
    resultId: 'result-1',
    tenantKey: 'tenant-a',
    baseUserId: 'user-a',
    pluginInstanceId: 'plugin-a',
    scopeKey: 'scope-a',
    jobId: 'job-1',
    configId: 'config-1',
    configVersion: 1,
    sourceVersion: {
      kind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review',
      version: 'source-a',
      contentHash: 'hash-a',
      generatedAt: '2026-06-18T10:00:00.000Z',
      recordCount: 2,
    },
    pipelineVersion: 'backend-owned-v1',
    summary: {
      analysisId: 'analysis-1',
      generatedAt: '2026-06-18T11:00:00.000Z',
      model: 'qwen-plus',
      status: 'complete',
      scope: { hotelName: '全部', periodType: 'month', startDate: '2026-06-01', endDate: '2026-06-30' },
      overview: {
        totalReviews: 2,
        positiveReviews: 1,
        negativeOrRiskReviews: 1,
        mixedReviews: 0,
        neutralReviews: 0,
        averageScore: 4.5,
        replyRate: 0.5,
      },
      positiveTopics: [
        {
          mergeKey: 'location',
          topic: '位置',
          displayTopic: '位置便利',
          category: '位置',
          count: 1,
          sentiment: 'positive',
          commentRecordIds: ['rec-1'],
          evidencePhrases: ['位置很好', '交通方便'],
          summary: '客人认可位置。',
          action: '延续交通指引。',
        },
      ],
      negativeTopics: [
        {
          mergeKey: 'noise',
          topic: '噪音',
          displayTopic: '隔音不足',
          category: '设施',
          count: 1,
          sentiment: 'negative',
          commentRecordIds: ['rec-2'],
          evidencePhrases: [],
          evidenceItems: [{ recordId: 'rec-2', quote: '晚上有噪音', sentiment: 'negative', aspectLabel: '隔音' }],
          summary: '客人反馈隔音。',
          action: '检查临街房隔音。',
        },
      ],
      actionItems: [],
    },
    topics: [],
    createdAt: '2026-06-18T11:01:00.000Z',
  };
}
