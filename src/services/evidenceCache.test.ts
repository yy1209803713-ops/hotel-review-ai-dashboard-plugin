import { describe, expect, it, vi } from 'vitest';
import { FieldType } from '@lark-base-open/js-sdk';
import type { DashboardRuntime, RuntimeConfig, RuntimeTable } from '../runtime/sdk';
import type { RawSdkRecord, RecordsPage } from './baseRecords';
import type { ReviewRecord, TopicEvidenceItem } from '../types/analysis';
import {
  EVIDENCE_CACHE_EXTRACTOR_VERSION,
  readEvidenceCache,
  saveEvidenceCacheEntries,
  touchEvidenceCacheEntries,
} from './evidenceCache';

describe('evidenceCache', () => {
  it('creates the evidence cache table and writes only first-stage evidence JSON', async () => {
    const runtime = fakeRuntime();
    const records = [reviewRecord('rec1', '位置很好，服务热情。')];
    const evidenceItems = [
      evidence('rec1', '位置很好', 'positive', '位置'),
      evidence('rec1', '服务热情', 'positive', '服务'),
    ];

    await saveEvidenceCacheEntries(runtime, {
      tableId: 'source-table',
      model: 'qwen-plus',
      records,
      evidenceItems,
      now: '2026-06-16T10:00:00.000Z',
    });

    expect(runtime.addTable).toHaveBeenCalledWith(
      'AI评论证据缓存',
      expect.arrayContaining([
        { name: '数据表 ID', type: FieldType.Text },
        { name: '评论 recordId', type: FieldType.Text },
        { name: '评论内容 hash', type: FieldType.Text },
        { name: '模型', type: FieldType.Text },
        { name: '抽取规则版本', type: FieldType.Text },
        { name: '证据 JSON', type: FieldType.Text },
        { name: '更新时间', type: FieldType.Text },
        { name: '最近使用时间', type: FieldType.Text },
      ]),
    );
    expect(runtime.addRecords).toHaveBeenCalledTimes(1);
    const row = vi.mocked(runtime.addRecords).mock.calls[0][1][0].fields;
    expect(row['cache-table-证据 JSON']).toBe(JSON.stringify(evidenceItems));
    expect(row['cache-table-模型']).toBe('qwen-plus');
    expect(row['cache-table-抽取规则版本']).toBe(EVIDENCE_CACHE_EXTRACTOR_VERSION);
    expect(row['cache-table-更新时间']).toBe('2026-06-16T10:00:00.000Z');
    expect(row['cache-table-最近使用时间']).toBe('2026-06-16T10:00:00.000Z');
  });

  it('matches cached evidence by source table, recordId, model, extractor version, and content hash', async () => {
    const records = [
      reviewRecord('rec1', '位置很好，服务热情。'),
      reviewRecord('rec2', '隔音不好。'),
      reviewRecord('rec3', '新评论。'),
    ];
    const rec1Hash = await hashFor(records[0].content);
    const rec2OldHash = await hashFor('隔音不好');
    const runtime = fakeRuntime({
      tables: [{ tableId: 'cache-table', tableName: 'AI评论证据缓存' }],
      cacheRows: [
        cacheRow('cache-row-1', {
          '数据表 ID': 'source-table',
          '评论 recordId': 'rec1',
          '评论内容 hash': rec1Hash,
          模型: 'qwen-plus',
          抽取规则版本: EVIDENCE_CACHE_EXTRACTOR_VERSION,
          '证据 JSON': JSON.stringify([evidence('rec1', '位置很好', 'positive', '位置')]),
        }),
        cacheRow('cache-row-2', {
          '数据表 ID': 'source-table',
          '评论 recordId': 'rec2',
          '评论内容 hash': rec2OldHash,
          模型: 'qwen-plus',
          抽取规则版本: EVIDENCE_CACHE_EXTRACTOR_VERSION,
          '证据 JSON': JSON.stringify([evidence('rec2', '隔音不好', 'negative', '隔音')]),
        }),
        cacheRow('cache-row-3', {
          '数据表 ID': 'source-table',
          '评论 recordId': 'rec3',
          '评论内容 hash': await hashFor(records[2].content),
          模型: 'other-model',
          抽取规则版本: EVIDENCE_CACHE_EXTRACTOR_VERSION,
          '证据 JSON': JSON.stringify([evidence('rec3', '新评论', 'positive', '新评论')]),
        }),
      ],
    });

    const cache = await readEvidenceCache(runtime, {
      tableId: 'source-table',
      model: 'qwen-plus',
      records,
    });

    expect(cache.tableId).toBe('cache-table');
    expect(cache.hits.map((hit) => hit.record.recordId)).toEqual(['rec1']);
    expect(cache.hits[0].evidenceItems).toEqual([evidence('rec1', '位置很好', 'positive', '位置')]);
    expect(cache.misses.map((record) => record.recordId)).toEqual(['rec2', 'rec3']);
    expect(cache.diagnostics).toMatchObject({
      cacheTableFound: true,
      cacheTableId: 'cache-table',
      requestedRecords: 3,
      cacheRowsRead: 3,
      hitRecords: 1,
      missRecords: 2,
      missReasonCounts: {
        content_hash_mismatch: 1,
        model_mismatch: 1,
      },
    });
    expect(cache.diagnostics.sampleMisses).toEqual([
      { recordId: 'rec2', reviewId: 'rec2', reason: 'content_hash_mismatch' },
      { recordId: 'rec3', reviewId: 'rec3', reason: 'model_mismatch' },
    ]);
  });

  it('diagnoses missing cache table as a cache miss reason', async () => {
    const records = [reviewRecord('rec1', '位置很好。')];
    const runtime = fakeRuntime();

    const cache = await readEvidenceCache(runtime, {
      tableId: 'source-table',
      model: 'qwen-plus',
      records,
    });

    expect(cache.hits).toEqual([]);
    expect(cache.misses).toEqual(records);
    expect(cache.diagnostics).toMatchObject({
      cacheTableFound: false,
      requestedRecords: 1,
      cacheRowsRead: 0,
      hitRecords: 0,
      missRecords: 1,
      missReasonCounts: {
        cache_table_missing: 1,
      },
      sampleMisses: [{ recordId: 'rec1', reviewId: 'rec1', reason: 'cache_table_missing' }],
    });
  });

  it('does not block when touching recently used cache rows fails', async () => {
    const runtime = fakeRuntime({
      tables: [{ tableId: 'cache-table', tableName: 'AI评论证据缓存' }],
      setRecords: vi.fn(async () => {
        throw new Error('write quota exceeded');
      }),
    });

    await expect(
      touchEvidenceCacheEntries(runtime, {
        cacheTableId: 'cache-table',
        cacheRecordIds: ['cache-row-1', 'cache-row-2'],
        now: '2026-06-16T10:05:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(runtime.setRecords).toHaveBeenCalledTimes(1);
  });
});

function reviewRecord(recordId: string, content: string): ReviewRecord {
  return {
    recordId,
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-01 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content,
  };
}

function evidence(
  recordId: string,
  quote: string,
  sentiment: 'positive' | 'negative',
  aspectLabel: string,
): TopicEvidenceItem {
  return {
    recordId,
    quote,
    sentiment,
    aspectLabel,
    reason: `${aspectLabel} reason`,
  };
}

function cacheRow(recordId: string, values: Record<string, unknown>): RawSdkRecord {
  return {
    recordId,
    fields: Object.fromEntries(Object.entries(values).map(([fieldName, value]) => [`cache-table-${fieldName}`, value])),
  };
}

async function hashFor(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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
      evidenceCacheFieldNames.map((fieldName) => ({
        fieldId: `cache-table-${fieldName}`,
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
      tables.push({ tableId: 'cache-table', tableName: name });
      return { tableId: 'cache-table' };
    }),
    addRecords: vi.fn(async (_tableId, records) => records.map((_, index) => `cache-write-${index}`)),
    setRecords: options.setRecords ?? vi.fn(async (_tableId, records) => records.map((record) => ({ recordId: record.recordId }))),
    setRendered: vi.fn(),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
  };
}

const evidenceCacheFieldNames = [
  '数据表 ID',
  '评论 recordId',
  '评论内容 hash',
  '模型',
  '抽取规则版本',
  '证据 JSON',
  '更新时间',
  '最近使用时间',
];
