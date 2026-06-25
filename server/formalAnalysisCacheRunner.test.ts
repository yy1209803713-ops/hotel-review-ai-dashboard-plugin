import { describe, expect, it, vi } from 'vitest';
import { createFormalAnalysisCacheRunner } from './formalAnalysisCacheRunner';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY } from './reviewSync';
import type { ReviewRecord } from './reviewSource';
import type {
  AnalysisCacheRepository,
  AnalysisCacheSourceIdentity,
  AnalysisEvidenceCacheReadResult,
  AnalysisTopicMappingCacheReadResult,
} from './postgresAnalysisCache';
import type { SourceTopicMapping } from '../src/services/analysisPipeline';
import type {
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
} from '../src/types/analysis';

describe('createFormalAnalysisCacheRunner', () => {
  it('reuses evidence and topic mapping cache entries without calling AI for cached scope records', async () => {
    const analyzeBatchImpl = vi.fn();
    const cacheRepository = createStaticAnalysisCacheRepository({
      readEvidenceCache: vi.fn(async () => ({
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
      })),
      readTopicMappingCache: vi.fn(async () => ({
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
      })),
    });

    const runner = createFormalAnalysisCacheRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
        LARK_BASE_AUTH_CODE: 'auth-code-a',
      },
      now: () => '2026-06-22T15:30:00.000Z',
      analyzeBatchImpl,
      cacheRepository,
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

    expect(cacheRepository.readEvidenceCache).toHaveBeenCalledTimes(1);
    expect(cacheRepository.readTopicMappingCache).toHaveBeenCalledTimes(1);
    expect(analyzeBatchImpl).toHaveBeenCalledTimes(0);
    expect(cacheRepository.saveEvidenceCacheEntries).toHaveBeenCalledTimes(0);
    expect(cacheRepository.saveTopicMappingCacheEntries).toHaveBeenCalledTimes(0);
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
      cacheRepository: createStaticAnalysisCacheRepository({
        readEvidenceCache: vi.fn(async () => ({
          tableId: 'cache-evidence',
          hits: [],
          misses: [review('rec-match', '酒店位置很好，靠近地铁。')],
          diagnostics: emptyDiagnostics(),
        })),
        readTopicMappingCache: vi.fn(async () => ({
          tableId: 'cache-topic',
          hits: [],
          misses: [],
          diagnostics: emptyDiagnostics(),
        })),
      }),
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

  it('normalizes ReviewSource records before applying filters', async () => {
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
      cacheRepository: createStaticAnalysisCacheRepository({
        readEvidenceCache: vi.fn(async ({ records }) => {
          expect(records.map((record) => record.recordId)).toEqual(['rec-match']);
          return {
            tableId: 'cache-evidence',
            hits: [],
            misses: records,
            diagnostics: emptyDiagnostics(),
          };
        }),
        readTopicMappingCache: vi.fn(async () => ({
          tableId: 'cache-topic',
          hits: [],
          misses: [],
          diagnostics: emptyDiagnostics(),
        })),
      }),
    });

    await runner.run({
      reviews: [
        sourceReview('rec-match', {
          content: '酒店位置很好，靠近地铁。',
          reviewDate: '2026-06-15 10:00:00',
        }),
        sourceReview('rec-outside-date', {
          content: '酒店位置也不错。',
          reviewDate: '2026-05-15 10:00:00',
        }),
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
      jobId: 'job-3',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(analyzeBatchImpl).toHaveBeenCalledTimes(1);
  });

  it('hits DB-backed caches with global canonical source identity when a single hotel reruns after all-hotel analysis', async () => {
    const cacheRepository = createMemoryAnalysisCacheRepository();
    const analyzeBatchImpl = vi.fn(async ({ records }) => ({
      evidenceItems: records.map((record) => ({
        recordId: record.recordId,
        quote: record.content.includes('位置') ? '位置很好' : '服务热情',
        sentiment: 'positive' as const,
        aspectLabel: record.content.includes('位置') ? '位置' : '服务',
      })),
    }));
    const mergeTopicsImpl = vi.fn(async ({ candidates }) => ({
      groups: candidates.map((candidate) => ({
        mergeKey: candidate.sourceLabel === '位置' ? '位置便利' : '服务体验',
        category: candidate.sourceLabel,
        displayTopic: candidate.sourceLabel === '位置' ? '位置方便' : '服务热情',
        summary: `${candidate.sourceLabel}相关评论证据。`,
        sentiment: candidate.sentiment,
        members: [
          {
            candidateId: candidate.id,
            sourceLabel: candidate.sourceLabel,
            acceptedQuotes: candidate.quotes,
          },
        ],
      })),
    }));

    const runner = createFormalAnalysisCacheRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
      },
      now: () => '2026-06-22T15:30:00.000Z',
      analyzeBatchImpl,
      mergeTopicsImpl,
      cacheRepository,
    });
    const allHotelReviews = [
      review('rec-a', '位置很好，出行方便。', '昆明A酒店'),
      review('rec-b', '服务热情，响应很快。', '昆明B酒店'),
    ];

    await runner.run({
      reviews: allHotelReviews,
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'vew-active',
        sourceConfig: {
          sourceId: 'base-a:tbl-review',
          upstreamSourceKind: 'feishu_base',
        },
        fieldMapping: {},
        filters: baseFilters({ hotelName: 'all' }),
      },
      jobId: 'job-all',
      pipelineVersion: 'backend-owned-v1',
    });
    expect(analyzeBatchImpl).toHaveBeenCalledTimes(1);
    expect(mergeTopicsImpl).toHaveBeenCalledTimes(1);

    const result = await runner.run({
      reviews: allHotelReviews,
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'vew-active',
        sourceConfig: {
          sourceId: 'base-a:tbl-review',
          upstreamSourceKind: 'feishu_base',
        },
        fieldMapping: {},
        filters: baseFilters({ hotelName: '昆明A酒店' }),
      },
      jobId: 'job-single',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(analyzeBatchImpl).toHaveBeenCalledTimes(1);
    expect(mergeTopicsImpl).toHaveBeenCalledTimes(1);
    expect(cacheRepository.readEvidenceCache).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceKind: 'feishu_base',
      sourceId: 'base-a:tbl-review',
      records: [expect.objectContaining({ recordId: 'rec-a' })],
    }));
    expect(cacheRepository.readTopicMappingCache).toHaveBeenLastCalledWith(expect.objectContaining({
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceKind: 'feishu_base',
      sourceId: 'base-a:tbl-review',
    }));
    expect(result.summary).toMatchObject({
      cacheDiagnostics: {
        triggered: true,
        layers: ['evidence_cache', 'topic_mapping_cache'],
        evidenceCache: {
          requested: 1,
          hits: 1,
          misses: 0,
          hitRate: 1,
        },
        topicMappingCache: {
          requested: 1,
          hits: 1,
          misses: 0,
          hitRate: 1,
        },
        aiTriggered: {
          evidenceExtraction: false,
          topicMapping: false,
        },
      },
    });
    expect(result.evidenceByTopic).toMatchObject({
      位置便利: [expect.objectContaining({ recordId: 'rec-a', quote: '位置很好' })],
    });
  });

  it('saves diagnostics only for records that still fail after single-record retry', async () => {
    const saveEvidenceBatchDiagnostic = vi.fn(async () => undefined);
    const analyzeBatchImpl = vi.fn(async ({ records }) => {
      const recordIds = records.map((record) => record.recordId);
      if (recordIds.join(',') === 'rec-good,rec-bad' || recordIds.includes('rec-bad')) {
        const error = new Error('模型返回内容疑似被截断，不是合法 JSON') as Error & {
          code: string;
          details: Record<string, unknown>;
        };
        error.code = 'truncated_json';
        error.details = {
          source: 'model_content',
          preview: '{"evidenceItems":[',
          rawLength: 70000,
          rawContent: '{"evidenceItems":[',
        };
        throw error;
      }
      return {
        evidenceItems: records.map((record) => ({
          recordId: record.recordId,
          quote: record.recordId === 'rec-good' ? '位置很好' : '早餐很好',
          sentiment: 'positive' as const,
          aspectLabel: '位置',
        })),
      };
    });
    const cacheRepository = createStaticAnalysisCacheRepository({
      readEvidenceCache: vi.fn(async ({ records }) => ({
        tableId: 'cache-evidence',
        hits: [],
        misses: records,
        diagnostics: emptyDiagnostics(),
      })),
      readTopicMappingCache: vi.fn(async () => ({
        tableId: 'cache-topic',
        hits: [],
        misses: [],
        diagnostics: emptyTopicDiagnostics(),
      })),
    });
    cacheRepository.saveEvidenceBatchDiagnostic = saveEvidenceBatchDiagnostic;

    const runner = createFormalAnalysisCacheRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
        AI_MAX_BATCH_SIZE: '2',
      },
      now: () => '2026-06-25T15:00:00.000Z',
      analyzeBatchImpl,
      cacheRepository,
    });

    const result = await runner.run({
      reviews: [
        review('rec-good', '位置很好，服务热情。'),
        review('rec-bad', '房间隔音不好。'),
        review('rec-next', '早餐很好。'),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: baseFilters({ hotelName: 'all' }),
      },
      jobId: 'job-retry',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(analyzeBatchImpl).toHaveBeenCalledTimes(4);
    expect(saveEvidenceBatchDiagnostic).toHaveBeenCalledTimes(1);
    expect(saveEvidenceBatchDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-retry',
      model: 'qwen-plus',
      batchIndex: 0,
      batchNumber: 1,
      batchCount: 2,
      recordIds: ['rec-bad'],
      records: [expect.objectContaining({ recordId: 'rec-bad' })],
      errorCode: 'truncated_json',
      errorMessage: '模型返回内容疑似被截断，不是合法 JSON',
      rawContent: '{"evidenceItems":[',
      rawLength: 70000,
      preview: '{"evidenceItems":[',
      createdAt: '2026-06-25T15:00:00.000Z',
    }));
    expect(cacheRepository.saveEvidenceCacheEntries).toHaveBeenCalledWith(expect.objectContaining({
      records: [
        expect.objectContaining({ recordId: 'rec-good' }),
        expect.objectContaining({ recordId: 'rec-next' }),
      ],
    }));
    expect(result.evidenceByTopic).toMatchObject({
      位置: [
        expect.objectContaining({ recordId: 'rec-good', quote: '位置很好' }),
        expect.objectContaining({ recordId: 'rec-next', quote: '早餐很好' }),
      ],
    });
  });
});

function review(recordId: string, content: string, hotelName = '昆明中维翠湖宾馆'): ReviewRecord {
  return {
    recordId,
    fields: {},
    mappedFields: {
      reviewId: recordId,
      hotelName,
      score: 5,
      reviewDate: '2026-06-15 10:00:00',
      checkInMonth: '2026-06-01 00:00:00',
      roomType: '大床房',
      replyContent: '',
      content,
    },
    reviewId: recordId,
    hotelName,
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

function sourceReview(recordId: string, overrides: Partial<Record<string, unknown>>): ReviewRecord {
  const mappedFields = {
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-15 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    replyContent: '',
    content: '酒店位置很好。',
    ...overrides,
  };
  return {
    recordId,
    fields: {},
    mappedFields,
    content: String(mappedFields.content ?? ''),
    contentHash: `${recordId}-hash`,
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

function baseFilters(overrides: Record<string, unknown>) {
  return {
    hotelName: 'all',
    periodType: 'custom',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
    checkInMonth: 'all',
    minScore: null,
    maxScore: null,
    replyStatus: 'all',
    keyword: '',
    ...overrides,
  };
}

function createStaticAnalysisCacheRepository(overrides: {
  readEvidenceCache?: AnalysisCacheRepository['readEvidenceCache'];
  readTopicMappingCache?: AnalysisCacheRepository['readTopicMappingCache'];
}): AnalysisCacheRepository {
  return {
    readEvidenceCache: overrides.readEvidenceCache ?? vi.fn(async ({ records }) => ({
      tableId: 'cache-evidence',
      hits: [],
      misses: records,
      diagnostics: emptyDiagnostics(),
    })),
    saveEvidenceCacheEntries: vi.fn(async () => undefined),
    readTopicMappingCache: overrides.readTopicMappingCache ?? vi.fn(async ({ candidates }) => ({
      tableId: 'cache-topic',
      hits: [],
      misses: candidates,
      diagnostics: emptyTopicDiagnostics(),
    })),
    saveTopicMappingCacheEntries: vi.fn(async () => undefined),
  };
}

function createMemoryAnalysisCacheRepository(): AnalysisCacheRepository {
  const evidenceByKey = new Map<string, TopicEvidenceItem[]>();
  const mappingsByKey = new Map<string, SourceTopicMapping>();
  const repository: AnalysisCacheRepository = {
    readEvidenceCache: vi.fn(async (params): Promise<AnalysisEvidenceCacheReadResult> => {
      const hits = params.records.flatMap((record) => {
        const evidenceItems = evidenceByKey.get(evidenceKey(params, record));
        return evidenceItems
          ? [{
              cacheRecordId: evidenceKey(params, record),
              record,
              evidenceItems,
            }]
          : [];
      });
      const hitIds = new Set(hits.map((hit) => hit.record.recordId));
      return {
        tableId: params.sourceId,
        hits,
        misses: params.records.filter((record) => !hitIds.has(record.recordId)),
        diagnostics: emptyDiagnostics(),
      };
    }),
    saveEvidenceCacheEntries: vi.fn(async (params) => {
      const evidenceByRecord = groupEvidence(params.evidenceItems);
      for (const record of params.records) {
        evidenceByKey.set(evidenceKey(params, record), evidenceByRecord.get(record.recordId) ?? []);
      }
    }),
    readTopicMappingCache: vi.fn(async (params): Promise<AnalysisTopicMappingCacheReadResult> => {
      const hits = params.candidates.flatMap((candidate) => {
        const mapping = mappingsByKey.get(mappingKey(params, candidate));
        return mapping ? [{ cacheRecordId: mappingKey(params, candidate), candidate, mapping }] : [];
      });
      const hitKeys = new Set(hits.map((hit) => candidateKey(hit.candidate)));
      return {
        tableId: params.sourceId,
        hits,
        misses: params.candidates.filter((candidate) => !hitKeys.has(candidateKey(candidate))),
        diagnostics: emptyTopicDiagnostics(),
      };
    }),
    saveTopicMappingCacheEntries: vi.fn(async (params) => {
      for (const [key, mapping] of buildMappingsFromGroups(params.candidates, params.groups)) {
        mappingsByKey.set(`${params.tenantKey}:${params.sourceKind}:${params.sourceId}:${params.model}:${key}`, mapping);
      }
    }),
  };
  return repository;
}

function evidenceKey(params: AnalysisCacheSourceIdentity & { model: string }, record: { recordId: string; content: string }): string {
  return `${params.tenantKey}:${params.sourceKind}:${params.sourceId}:${params.model}:${record.recordId}:${record.content}`;
}

function mappingKey(params: AnalysisCacheSourceIdentity & { model: string }, candidate: TopicMergeCandidate): string {
  return `${params.tenantKey}:${params.sourceKind}:${params.sourceId}:${params.model}:${candidateKey(candidate)}`;
}

function candidateKey(candidate: TopicMergeCandidate): string {
  return `${candidate.sentiment}:${normalizeTopic(candidate.sourceLabel)}`;
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}

function groupEvidence(evidenceItems: TopicEvidenceItem[]): Map<string, TopicEvidenceItem[]> {
  const grouped = new Map<string, TopicEvidenceItem[]>();
  for (const item of evidenceItems) {
    grouped.set(item.recordId, [...(grouped.get(item.recordId) ?? []), item]);
  }
  return grouped;
}

function buildMappingsFromGroups(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): Map<string, SourceTopicMapping> {
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const mappings = new Map<string, SourceTopicMapping>();
  for (const group of groups) {
    for (const member of group.members) {
      const candidate = member.candidateId ? candidatesById.get(member.candidateId) : undefined;
      if (!candidate) {
        continue;
      }
      mappings.set(candidateKey(candidate), {
        sourceLabel: candidate.sourceLabel,
        sentiment: candidate.sentiment,
        mergeKey: group.mergeKey,
        category: group.category,
        displayTopic: group.displayTopic,
        summary: group.summary,
        acceptedQuotes: member.acceptedQuotes,
        action: group.action,
      });
    }
  }
  return mappings;
}

function emptyTopicDiagnostics() {
  return {
    cacheTableFound: true,
    cacheTableId: 'cache-topic',
    requestedCandidates: 0,
    cacheRowsRead: 0,
    hitCandidates: 0,
    missCandidates: 0,
    missReasonCounts: {},
    sampleMisses: [],
  };
}
