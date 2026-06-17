import { describe, expect, it, vi } from 'vitest';
import { FieldType } from '@lark-base-open/js-sdk';
import type { DashboardRuntime, RuntimeConfig, RuntimeTable } from '../runtime/sdk';
import type { RawSdkRecord, RecordsPage } from './baseRecords';
import type { TopicMergeCandidate, TopicMergeGroup } from '../types/analysis';
import {
  TOPIC_MAPPING_CACHE_VERSION,
  readTopicMappingCache,
  saveTopicMappingCacheEntries,
  touchTopicMappingCacheEntries,
} from './topicMappingCache';

describe('topicMappingCache', () => {
  it('creates the topic mapping cache table and writes one row per source label mapping', async () => {
    const runtime = fakeRuntime();
    const candidates = [
      candidate('positive', '房间空间', ['房间很大']),
      candidate('positive', '房间采光', ['采光很好']),
    ];
    const groups: TopicMergeGroup[] = [
      {
        mergeKey: '房间空间采光',
        sentiment: 'positive',
        category: '房型',
        displayTopic: '房间宽敞，采光也好',
        summary: '客人认可房间空间和采光。',
        members: candidates.map((item) => ({
          candidateId: item.id,
          sourceLabel: item.sourceLabel,
          acceptedQuotes: item.quotes,
        })),
      },
    ];

    await saveTopicMappingCacheEntries(runtime, {
      tableId: 'source-table',
      model: 'qwen-plus',
      candidates,
      groups,
      now: '2026-06-17T10:00:00.000Z',
    });

    expect(runtime.addTable).toHaveBeenCalledWith(
      'AI评论主题映射缓存',
      expect.arrayContaining([
        { name: '数据表 ID', type: FieldType.Text },
        { name: '候选 sentiment', type: FieldType.Text },
        { name: '候选标签归一化 key', type: FieldType.Text },
        { name: '候选标签', type: FieldType.Text },
        { name: '模型', type: FieldType.Text },
        { name: '主题映射规则版本', type: FieldType.Text },
        { name: '映射 JSON', type: FieldType.Text },
        { name: '更新时间', type: FieldType.Text },
        { name: '最近使用时间', type: FieldType.Text },
      ]),
    );
    expect(runtime.addRecords).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(runtime.addRecords).mock.calls[0][1].map((row) => row.fields);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      'topic-cache-数据表 ID': 'source-table',
      'topic-cache-候选 sentiment': 'positive',
      'topic-cache-候选标签': '房间空间',
      'topic-cache-模型': 'qwen-plus',
      'topic-cache-主题映射规则版本': TOPIC_MAPPING_CACHE_VERSION,
      'topic-cache-更新时间': '2026-06-17T10:00:00.000Z',
      'topic-cache-最近使用时间': '2026-06-17T10:00:00.000Z',
    });
    expect(JSON.parse(String(rows[0]['topic-cache-映射 JSON']))).toMatchObject({
      sourceLabel: '房间空间',
      sentiment: 'positive',
      mergeKey: '房间空间采光',
      category: '房型',
      displayTopic: '房间宽敞，采光也好',
      summary: '客人认可房间空间和采光。',
      acceptedQuotes: ['房间很大'],
    });
  });

  it('reads mappings by source table, sentiment, normalized label, model and version', async () => {
    const candidates = [
      candidate('positive', '房间 空间', ['房间很大']),
      candidate('negative', '隔音问题', ['隔音不好']),
      candidate('positive', '早餐体验', ['早餐好吃']),
    ];
    const runtime = fakeRuntime({
      tables: [{ tableId: 'topic-cache', tableName: 'AI评论主题映射缓存' }],
      cacheRows: [
        cacheRow('map-1', {
          '数据表 ID': 'source-table',
          '候选 sentiment': 'positive',
          '候选标签归一化 key': '房间空间',
          候选标签: '房间空间',
          模型: 'qwen-plus',
          主题映射规则版本: TOPIC_MAPPING_CACHE_VERSION,
          '映射 JSON': JSON.stringify({
            sourceLabel: '房间空间',
            sentiment: 'positive',
            mergeKey: '房间空间采光',
            category: '房型',
            displayTopic: '房间宽敞，采光也好',
            summary: '客人认可房间空间和采光。',
            acceptedQuotes: ['房间很大'],
          }),
        }),
        cacheRow('map-2', {
          '数据表 ID': 'source-table',
          '候选 sentiment': 'negative',
          '候选标签归一化 key': '隔音问题',
          候选标签: '隔音问题',
          模型: 'other-model',
          主题映射规则版本: TOPIC_MAPPING_CACHE_VERSION,
          '映射 JSON': JSON.stringify({
            sourceLabel: '隔音问题',
            sentiment: 'negative',
            mergeKey: '隔音问题',
            category: '设施',
            displayTopic: '房间隔音不好',
            summary: '隔音影响休息。',
          }),
        }),
      ],
    });

    const cache = await readTopicMappingCache(runtime, {
      tableId: 'source-table',
      model: 'qwen-plus',
      candidates,
    });

    expect(cache.tableId).toBe('topic-cache');
    expect(cache.hits.map((hit) => hit.candidate.sourceLabel)).toEqual(['房间 空间']);
    expect(cache.hits[0].mapping).toMatchObject({
      mergeKey: '房间空间采光',
      displayTopic: '房间宽敞，采光也好',
    });
    expect(cache.misses.map((item) => item.sourceLabel)).toEqual(['隔音问题', '早餐体验']);
    expect(cache.diagnostics).toMatchObject({
      cacheTableFound: true,
      cacheTableId: 'topic-cache',
      requestedCandidates: 3,
      cacheRowsRead: 2,
      hitCandidates: 1,
      missCandidates: 2,
      missReasonCounts: {
        model_mismatch: 1,
        cache_no_matching_row: 1,
      },
    });
  });

  it('does not block when touching recently used topic mapping rows fails', async () => {
    const runtime = fakeRuntime({
      tables: [{ tableId: 'topic-cache', tableName: 'AI评论主题映射缓存' }],
      setRecords: vi.fn(async () => {
        throw new Error('quota exceeded');
      }),
    });

    await expect(
      touchTopicMappingCacheEntries(runtime, {
        cacheTableId: 'topic-cache',
        cacheRecordIds: ['map-1'],
        now: '2026-06-17T10:05:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(runtime.setRecords).toHaveBeenCalledTimes(1);
  });
});

function candidate(
  sentiment: 'positive' | 'negative',
  sourceLabel: string,
  quotes: string[],
): TopicMergeCandidate {
  return {
    id: `candidate-${sentiment}-${sourceLabel}`,
    sourceLabel,
    sentiment,
    count: 1,
    quotes,
  };
}

function cacheRow(recordId: string, values: Record<string, unknown>): RawSdkRecord {
  return {
    recordId,
    fields: Object.fromEntries(Object.entries(values).map(([fieldName, value]) => [`topic-cache-${fieldName}`, value])),
  };
}

function fakeRuntime(
  options: {
    tables?: RuntimeTable[];
    cacheRows?: RawSdkRecord[];
    setRecords?: DashboardRuntime['setRecords'];
  } = {},
): DashboardRuntime {
  const tables = [...(options.tables ?? [])];
  const cacheRows = options.cacheRows ?? [];
  return {
    isFixture: true,
    getState: () => 'View',
    getTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    getConfig: vi.fn(async (): Promise<RuntimeConfig> => ({ dataConditions: [] })),
    getPreviewData: vi.fn(async () => []),
    getData: vi.fn(async () => []),
    saveConfig: vi.fn(async () => true),
    onDataChange: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getTableList: vi.fn(async () => tables),
    getFieldMetaList: vi.fn(async () =>
      topicMappingCacheFieldNames.map((fieldName) => ({
        fieldId: `topic-cache-${fieldName}`,
        fieldName,
        fieldType: FieldType.Text,
      })),
    ),
    getTableDataRange: vi.fn(),
    getCategories: vi.fn(),
    readRecordsPage: vi.fn(async (): Promise<RecordsPage> => ({
      records: cacheRows,
      hasMore: false,
    })),
    readRecordsByIds: vi.fn(),
    canEditBase: vi.fn(async () => true),
    addTable: vi.fn(async (name: string) => {
      tables.push({ tableId: 'topic-cache', tableName: name });
      return { tableId: 'topic-cache' };
    }),
    addRecords: vi.fn(async (_tableId, records) => records.map((_, index) => `topic-cache-write-${index}`)),
    setRecords: options.setRecords ?? vi.fn(async (_tableId, records) => records.map((record) => ({ recordId: record.recordId }))),
    setRendered: vi.fn(),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
  };
}

const topicMappingCacheFieldNames = [
  '数据表 ID',
  '候选 sentiment',
  '候选标签归一化 key',
  '候选标签',
  '模型',
  '主题映射规则版本',
  '映射 JSON',
  '更新时间',
  '最近使用时间',
];
