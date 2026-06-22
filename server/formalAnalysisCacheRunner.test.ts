import { describe, expect, it, vi } from 'vitest';
import { createFormalAnalysisCacheRunner } from './formalAnalysisCacheRunner';
import type { ReviewRecord } from './reviewSource';

describe('createFormalAnalysisCacheRunner', () => {
  it('reuses evidence and topic mapping cache entries without calling AI for cached scope records', async () => {
    const analyzeBatchImpl = vi.fn();
    const saveEvidenceCacheEntriesImpl = vi.fn(async () => undefined);
    const saveTopicMappingCacheEntriesImpl = vi.fn(async () => undefined);
    const readEvidenceCacheImpl = vi.fn(async () => ({
      tableId: 'cache-evidence',
      hits: [
        {
          cacheRecordId: 'cache-row-1',
          record: review('rec-hit', '位置很好，出行方便。'),
          evidenceItems: [
            {
              recordId: 'rec-hit',
              quote: '位置很好',
              sentiment: 'positive',
              aspectLabel: '位置',
            },
          ],
        },
        {
          cacheRecordId: 'cache-row-2',
          record: review('rec-miss', '房间有点吵。'),
          evidenceItems: [
            {
              recordId: 'rec-miss',
              quote: '房间有点吵',
              sentiment: 'negative',
              aspectLabel: '噪音',
            },
          ],
        },
      ],
      misses: [],
      diagnostics: emptyDiagnostics(),
    }));
    const readTopicMappingCacheImpl = vi.fn(async () => ({
      tableId: 'cache-topic',
      hits: [
        {
          cacheRecordId: 'topic-row-1',
          candidate: {
            id: 'c001',
            sourceLabel: '位置',
            sentiment: 'positive',
            count: 1,
            quotes: ['位置很好'],
          },
          mapping: {
            sourceLabel: '位置',
            sentiment: 'positive',
            mergeKey: '位置便利',
            category: '位置',
            displayTopic: '位置方便',
            summary: '位置好',
          },
        },
        {
          cacheRecordId: 'topic-row-2',
          candidate: {
            id: 'c002',
            sourceLabel: '噪音',
            sentiment: 'negative',
            count: 1,
            quotes: ['房间有点吵'],
          },
          mapping: {
            sourceLabel: '噪音',
            sentiment: 'negative',
            mergeKey: '噪音问题',
            category: '设施',
            displayTopic: '房间太吵',
            summary: '噪音大',
          },
        },
      ],
      misses: [],
      diagnostics: emptyDiagnostics(),
    }));

    const runner = createFormalAnalysisCacheRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
        LARK_BASE_AUTH_CODE: 'auth-code-a',
      },
      now: () => '2026-06-22T15:30:00.000Z',
      analyzeBatchImpl,
      readEvidenceCacheImpl,
      saveEvidenceCacheEntriesImpl,
      readTopicMappingCacheImpl,
      saveTopicMappingCacheEntriesImpl,
      createRuntime: vi.fn(() => fakeRuntime()),
    });
    analyzeBatchImpl.mockResolvedValue({
      evidenceItems: [
        {
          recordId: 'rec-miss',
          quote: '房间有点吵',
          sentiment: 'negative',
          aspectLabel: '噪音',
        },
      ],
    });

    const result = await runner.run({
      reviews: [
        review('rec-hit', '位置很好，出行方便。'),
        review('rec-miss', '房间有点吵。'),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: {
          hotelName: 'all',
          periodType: 'month',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
          checkInMonth: 'all',
          minScore: null,
          maxScore: null,
          replyStatus: 'all',
          keyword: '',
        },
      },
      jobId: 'job-1',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(readEvidenceCacheImpl).toHaveBeenCalledTimes(1);
    expect(readTopicMappingCacheImpl).toHaveBeenCalledTimes(1);
    expect(analyzeBatchImpl).toHaveBeenCalledTimes(0);
    expect(saveEvidenceCacheEntriesImpl).toHaveBeenCalledTimes(0);
    expect(saveTopicMappingCacheEntriesImpl).toHaveBeenCalledTimes(0);
    expect(result.summary).toMatchObject({
      generatedAt: '2026-06-22T15:30:00.000Z',
    });
    expect(result.evidenceByTopic).toMatchObject({
      位置便利: [expect.objectContaining({ recordId: 'rec-hit', quote: '位置很好' })],
      噪音问题: [expect.objectContaining({ recordId: 'rec-miss', quote: '房间有点吵' })],
    });
  });

  it('applies filters before running formal analysis and skips non-matching reviews', async () => {
    const analyzeBatchImpl = vi.fn(async ({ records }) => {
      expect(records.map((record) => record.recordId)).toEqual(['rec-match']);
      return {
        evidenceItems: [
          {
            recordId: 'rec-match',
            quote: '位置很好',
            sentiment: 'positive',
            aspectLabel: '位置',
          },
        ],
      };
    });

    const runner = createFormalAnalysisCacheRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
        LARK_BASE_AUTH_CODE: 'auth-code-a',
      },
      analyzeBatchImpl,
      readEvidenceCacheImpl: vi.fn(async () => ({
        tableId: 'cache-evidence',
        hits: [],
        misses: [review('rec-match', '酒店位置很好，靠近地铁。')],
        diagnostics: emptyDiagnostics(),
      })),
      readTopicMappingCacheImpl: vi.fn(async () => ({
        tableId: 'cache-topic',
        hits: [],
        misses: [],
        diagnostics: emptyDiagnostics(),
      })),
      saveEvidenceCacheEntriesImpl: vi.fn(async () => undefined),
      saveTopicMappingCacheEntriesImpl: vi.fn(async () => undefined),
      createRuntime: vi.fn(() => fakeRuntime()),
    });

    await runner.run({
      reviews: [
        review('rec-match', '酒店位置很好，靠近地铁。'),
        review('rec-skip', '房间很吵，空调噪音很大。'),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: {
          hotelName: 'all',
          periodType: 'custom',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
          checkInMonth: 'all',
          minScore: null,
          maxScore: null,
          replyStatus: 'all',
          keyword: '位置',
        },
      },
      jobId: 'job-2',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(analyzeBatchImpl).toHaveBeenCalledTimes(1);
  });
});

function review(recordId: string, content: string): ReviewRecord {
  return {
    recordId,
    fields: {},
    mappedFields: {
      reviewId: recordId,
      hotelName: '昆明中维翠湖宾馆',
      score: 5,
      reviewDate: '2026-06-15 10:00:00',
      checkInMonth: '2026-06-01 00:00:00',
      roomType: '大床房',
      replyContent: '',
      content,
    },
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-15 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content,
    contentHash: `${recordId}-hash`,
  };
}

function fakeRuntime() {
  return {
    getTableList: vi.fn(async () => []),
    getFieldMetaList: vi.fn(async () => []),
    clearFieldMetaCache: vi.fn(),
    readRecordsPage: vi.fn(),
    addTable: vi.fn(),
    addRecords: vi.fn(),
    setRecords: vi.fn(),
  };
}

function emptyDiagnostics() {
  return {
    cacheTableFound: true,
    cacheTableId: 'cache-table',
    requestedRecords: 0,
    cacheRowsRead: 0,
    hitRecords: 0,
    missRecords: 0,
    missReasonCounts: {},
    sampleMisses: [],
  };
}
