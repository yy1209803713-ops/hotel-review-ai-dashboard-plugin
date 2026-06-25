import { describe, expect, it, vi } from 'vitest';
import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type {
  AnalysisResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
} from '../types/analysis';
import { warmupAnalysisCache } from './warmup';

const config: AiConfig = {
  apiBaseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'qwen-plus',
  temperature: 0.2,
  maxBatchSize: 10,
  batchConcurrency: 1,
  topN: 10,
};

const filters: FilterState = {
  hotelName: 'all',
  periodType: 'month',
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  checkInMonth: 'all',
  minScore: null,
  maxScore: null,
  replyStatus: 'all',
  keyword: '',
};

const fields: FieldMapping = {
  reviewId: 'reviewId',
  content: 'content',
  hotelName: 'hotelName',
  score: 'score',
  reviewDate: 'reviewDate',
  checkInMonth: 'checkInMonth',
  replyContent: 'replyContent',
  roomType: 'roomType',
};

describe('warmupAnalysisCache', () => {
  it('logs workflow trigger metadata when warmup comes from Feishu Workflow', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    await warmupAnalysisCache({
      request: {
        mode: 'incremental',
        source: 'feishu-workflow',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'view-a',
      },
      config,
      filters,
      fields,
      readReviews: vi.fn(async () => []),
      readEvidenceCache: vi.fn(async () => ({ hits: [], misses: [] })),
      readTopicMappingCache: vi.fn(),
      saveEvidenceCacheEntries: vi.fn(),
      saveTopicMappingCacheEntries: vi.fn(),
      runAnalysis: vi.fn(),
      lock: memoryLock(),
      now: () => '2026-06-17T06:00:00.000Z',
    });

    expect(infoSpy).toHaveBeenCalledWith(
      '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
      JSON.stringify({
        jobId: 'warmup-2026-06-17T06:00:00.000Z-tbl-review',
        source: 'feishu-workflow',
        mode: 'incremental',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'view-a',
        dryRun: false,
      }),
    );
  });

  it('saves only evidence and topic mapping misses during bootstrap', async () => {
    const reviews = [
      reviewRecord('rec1', '位置很好。'),
      reviewRecord('rec2', '服务热情。'),
    ];
    const extractedEvidence = [evidence('rec2', '服务热情', 'positive', '服务')];
    const topicCandidate = candidate('positive', '服务', ['服务热情']);
    const topicGroup = groupFor(topicCandidate);
    const runAnalysis = vi.fn(async (params) => {
      await params.onCacheUsage?.({
        cachedEvidenceCount: 1,
        cachedRecordCount: 1,
        analyzedRecordCount: 1,
        newEvidenceItems: extractedEvidence,
      });
      const mappingRead = await params.readTopicMappingsImpl?.({ candidates: [topicCandidate] });
      expect(mappingRead).toEqual({ cachedMappings: [], cachedCandidates: [] });
      await params.onTopicMappingUsage?.({
        cachedMappingCount: 0,
        missedCandidateCount: 1,
        newCandidates: [topicCandidate],
        newGroups: [topicGroup],
      });
      return analysisResult(reviews.length);
    });
    const saveEvidence = vi.fn(async () => undefined);
    const saveTopicMappings = vi.fn(async () => undefined);

    const result = await warmupAnalysisCache({
      request: {
        mode: 'bootstrap',
        source: 'manual',
        baseToken: 'base-a',
        tableId: 'tbl-review',
      },
      config,
      filters,
      fields,
      readReviews: vi.fn(async () => reviews),
      readEvidenceCache: vi.fn(async () => ({
        tableId: 'tbl-evidence-cache',
        hits: [
          {
            cacheRecordId: 'cache-rec1',
            record: reviews[0],
            evidenceItems: [evidence('rec1', '位置很好', 'positive', '位置')],
          },
        ],
        misses: [reviews[1]],
      })),
      readTopicMappingCache: vi.fn(async () => ({
        tableId: 'tbl-topic-cache',
        hits: [],
        misses: [topicCandidate],
      })),
      saveEvidenceCacheEntries: saveEvidence,
      saveTopicMappingCacheEntries: saveTopicMappings,
      runAnalysis,
      lock: memoryLock(),
      now: () => '2026-06-17T06:00:00.000Z',
    });

    expect(result.status).toBe('success');
    expect(result.jobId).toBe('warmup-2026-06-17T06:00:00.000Z-tbl-review');
    expect(result.summary).toEqual({
      recordsScanned: 2,
      totalReviews: 2,
      evidenceCacheHits: 1,
      evidenceCacheMisses: 1,
      evidenceRecordsSaved: 1,
      topicMappingHits: 0,
      topicMappingMisses: 1,
      topicMappingsSaved: 1,
    });
    expect(runAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      records: reviews,
      cachedEvidenceItems: [evidence('rec1', '位置很好', 'positive', '位置')],
      cacheMissRecords: [reviews[1]],
    }));
    expect(saveEvidence).toHaveBeenCalledWith({
      tableId: 'tbl-review',
      model: 'qwen-plus',
      records: [reviews[1]],
      evidenceItems: extractedEvidence,
      now: '2026-06-17T06:00:00.000Z',
    });
    expect(saveTopicMappings).toHaveBeenCalledWith({
      tableId: 'tbl-review',
      model: 'qwen-plus',
      candidates: [topicCandidate],
      groups: [topicGroup],
      now: '2026-06-17T06:00:00.000Z',
    });
  });

  it('does not call AI or write caches when incremental warmup has complete hits', async () => {
    const reviews = [reviewRecord('rec1', '位置很好。')];
    const runAnalysis = vi.fn();

    const result = await warmupAnalysisCache({
      request: {
        mode: 'incremental',
        source: 'manual',
        tableId: 'tbl-review',
      },
      config,
      filters,
      fields,
      readReviews: vi.fn(async () => reviews),
      readEvidenceCache: vi.fn(async () => ({
        tableId: 'tbl-evidence-cache',
        hits: [
          {
            cacheRecordId: 'cache-rec1',
            record: reviews[0],
            evidenceItems: [evidence('rec1', '位置很好', 'positive', '位置')],
          },
        ],
        misses: [],
      })),
      readTopicMappingCache: vi.fn(),
      saveEvidenceCacheEntries: vi.fn(),
      saveTopicMappingCacheEntries: vi.fn(),
      runAnalysis,
      lock: memoryLock(),
    });

    expect(result.status).toBe('success');
    expect(result.summary).toMatchObject({
      totalReviews: 1,
      evidenceCacheHits: 1,
      evidenceCacheMisses: 0,
      evidenceRecordsSaved: 0,
      topicMappingHits: 0,
      topicMappingMisses: 0,
      topicMappingsSaved: 0,
    });
    expect(runAnalysis).not.toHaveBeenCalled();
  });

  it('returns skipped when the same base table lock is already held', async () => {
    const lock = memoryLock(['warmup:base-a:tbl-review']);
    const readReviews = vi.fn();

    const result = await warmupAnalysisCache({
      request: {
        mode: 'incremental',
        source: 'feishu-workflow',
        baseToken: 'base-a',
        tableId: 'tbl-review',
      },
      config,
      filters,
      fields,
      readReviews,
      readEvidenceCache: vi.fn(),
      readTopicMappingCache: vi.fn(),
      saveEvidenceCacheEntries: vi.fn(),
      saveTopicMappingCacheEntries: vi.fn(),
      runAnalysis: vi.fn(),
      lock,
    });

    expect(result.status).toBe('skipped');
    expect(result.errors).toEqual([
      {
        stage: 'lock',
        message: 'warmup lock is already held for warmup:base-a:tbl-review',
      },
    ]);
    expect(readReviews).not.toHaveBeenCalled();
  });

  it('returns failed validation error for malformed requests', async () => {
    const result = await warmupAnalysisCache({
      request: {
        mode: 'nightly' as never,
        source: 'manual',
        tableId: '',
      },
      config,
      filters,
      fields,
      readReviews: vi.fn(),
      readEvidenceCache: vi.fn(),
      readTopicMappingCache: vi.fn(),
      saveEvidenceCacheEntries: vi.fn(),
      saveTopicMappingCacheEntries: vi.fn(),
      runAnalysis: vi.fn(),
      lock: memoryLock(),
    });

    expect(result.status).toBe('failed');
    expect(result.errors).toEqual([
      {
        stage: 'validate_request',
        message: 'mode must be bootstrap or incremental; tableId is required',
      },
    ]);
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

function groupFor(source: TopicMergeCandidate): TopicMergeGroup {
  return {
    mergeKey: source.sourceLabel,
    sentiment: source.sentiment,
    category: source.sourceLabel,
    displayTopic: source.sourceLabel,
    summary: `${source.sourceLabel} summary`,
    members: [
      {
        candidateId: source.id,
        sourceLabel: source.sourceLabel,
        acceptedQuotes: source.quotes,
      },
    ],
  };
}

function analysisResult(totalReviews: number): AnalysisResult {
  return {
    analysisId: 'analysis-1',
    generatedAt: '2026-06-17T06:00:00.000Z',
    model: 'qwen-plus',
    status: 'complete',
    scope: {
      hotelName: 'all',
      periodType: 'month',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    },
    overview: {
      totalReviews,
      positiveReviews: totalReviews,
      negativeOrRiskReviews: 0,
      mixedReviews: 0,
      neutralReviews: 0,
      averageScore: 5,
      replyRate: 0,
    },
    positiveTopics: [],
    negativeTopics: [],
    actionItems: [],
  };
}

function memoryLock(initialKeys: string[] = []) {
  const held = new Set(initialKeys);
  return {
    acquire: vi.fn(async (key: string) => {
      if (held.has(key)) {
        return false;
      }
      held.add(key);
      return true;
    }),
    release: vi.fn(async (key: string) => {
      held.delete(key);
    }),
  };
}
