import { describe, expect, it, vi } from 'vitest';
import { BackendAnalysisError } from './backendAnalysis';
import { WarmupJobWorker, createWarmupService } from './warmupJob';
import { createInMemoryWarmupJobStore } from './warmupJobStore';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY } from './reviewSync';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord, ReviewSource } from './reviewSource';

describe('WarmupService and WarmupJobWorker', () => {
  it('creates an auditable warmup job with global canonical source identity', async () => {
    const store = createInMemoryWarmupJobStore();
    const service = createWarmupService({
      store,
      now: () => '2026-06-25T09:00:00.000Z',
    });

    const job = await service.createWarmupJob({
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        viewId: 'vew-active-must-not-enter-source-id',
        fieldMapping: { content: 'fld-content', reviewDate: 'fld-review-date' },
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
      triggerType: 'manual_api',
    });

    expect(job).toMatchObject({
      jobId: 'warmup-job-1',
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceKind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review',
      status: 'queued',
      reviewStartDate: '2026-06-01',
      reviewEndDate: '2026-06-30',
    });
    expect(job.acceptedResponse).toMatchObject({
      jobId: 'warmup-job-1',
      status: 'accepted',
      mode: 'incremental',
    });
  });

  it('runs warmup against the global Postgres read model and filters by reviewDate before reading caches', async () => {
    const store = createInMemoryWarmupJobStore();
    const service = createWarmupService({
      store,
      now: createClock([
        '2026-06-25T09:00:00.000Z',
        '2026-06-25T09:00:01.000Z',
        '2026-06-25T09:00:03.000Z',
      ]),
    });
    const job = await service.createWarmupJob({
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-content', reviewDate: 'fld-review-date' },
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
      triggerType: 'manual_api',
    });
    const source = new FakeReviewSource([
      review('rec-in-range', '位置很好。', '2026-06-15 10:00:00'),
      review('rec-out-range', '服务不错。', '2026-05-15 10:00:00'),
    ]);
    const runner: AnalysisRunner = {
      run: vi.fn(async ({ reviews, query, jobId }) => {
        expect(jobId).toBe(job.jobId);
        expect(query).toMatchObject({
          tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
          baseToken: 'base-token-a',
          tableId: 'tbl-review',
          sourceConfig: {
            sourceId: 'base-token-a:tbl-review',
            upstreamSourceKind: 'feishu_base',
          },
          filters: {
            periodType: 'custom',
            startDate: '2026-06-01',
            endDate: '2026-06-30',
          },
        });
        expect(reviews.map((item) => item.recordId)).toEqual(['rec-in-range']);
        return {
          summary: {
            overview: {
              totalReviews: 1,
            },
            cacheDiagnostics: {
              evidenceCache: { hits: 0, misses: 1 },
              topicMappingCache: { hits: 0, misses: 1 },
            },
            cacheWriteDiagnostics: {
              evidenceCache: { inserts: 1, updates: 0 },
              topicMappingCache: { inserts: 1, updates: 0 },
            },
          },
          topics: [],
          evidenceByTopic: {},
        };
      }),
    };
    const worker = new WarmupJobWorker({
      store,
      reviewSource: source,
      runner,
      now: createClock([
        '2026-06-25T09:00:01.000Z',
        '2026-06-25T09:00:03.000Z',
      ]),
    });

    const result = await worker.runWarmupJob(job.jobId);

    expect(source.queries).toEqual([
      expect.objectContaining({
        tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        sourceConfig: {
          sourceId: 'base-token-a:tbl-review',
          upstreamSourceKind: 'feishu_base',
        },
      }),
    ]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'success',
      summary: {
        totalReviews: 1,
        recordsScanned: 1,
        evidenceCacheMisses: 1,
        evidenceCacheInserts: 1,
        topicMappingMisses: 1,
        topicMappingCacheInserts: 1,
      },
    });
    await expect(store.getWarmupJob(job.jobId)).resolves.toMatchObject({
      status: 'success',
      recordsScanned: 1,
      evidenceCacheMisses: 1,
      evidenceCacheInserts: 1,
      topicMappingCacheMisses: 1,
      topicMappingCacheInserts: 1,
      durationMs: 2000,
    });
  });

  it('fails visibly when the requested source has not been synced into the read model', async () => {
    const store = createInMemoryWarmupJobStore();
    const service = createWarmupService({
      store,
      now: () => '2026-06-25T09:00:00.000Z',
    });
    const job = await service.createWarmupJob({
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'missing-base',
        tableId: 'missing-table',
        fieldMapping: { content: 'fld-content', reviewDate: 'fld-review-date' },
        startDate: '2026-05-01',
        endDate: '2026-05-10',
      },
      triggerType: 'manual_api',
    });
    const runner: AnalysisRunner = {
      run: vi.fn(),
    };
    const source = new MissingVersionReviewSource();
    const worker = new WarmupJobWorker({
      store,
      reviewSource: source,
      runner,
      now: createClock([
        '2026-06-25T09:00:01.000Z',
        '2026-06-25T09:00:02.000Z',
      ]),
    });

    const result = await worker.runWarmupJob(job.jobId);

    expect(result).toMatchObject({
      status: 'failed',
      summary: {
        recordsScanned: 0,
        totalReviews: 0,
      },
      errors: [
        {
          stage: 'read_reviews',
          message: 'source version not found for missing-base:missing-table; run sync first',
        },
      ],
    });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(store.getWarmupJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      stage: 'read_reviews',
      errorStage: 'read_reviews',
      errorMessage: 'source version not found for missing-base:missing-table; run sync first',
    });
  });

  it('records merge topic failures with the merge_topics stage instead of extract_evidence', async () => {
    const store = createInMemoryWarmupJobStore();
    const service = createWarmupService({
      store,
      now: () => '2026-06-25T09:00:00.000Z',
    });
    const job = await service.createWarmupJob({
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: { content: 'fld-content', reviewDate: 'fld-review-date' },
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
      triggerType: 'manual_api',
    });
    const runner: AnalysisRunner = {
      run: vi.fn(async () => {
        throw new BackendAnalysisError(
          500,
          'merge_topics',
          '模型返回 JSON 不符合结构要求：缺少字段 mappings.0.summary',
        );
      }),
    };
    const worker = new WarmupJobWorker({
      store,
      reviewSource: new FakeReviewSource([review('rec-in-range', '位置很好。', '2026-06-15 10:00:00')]),
      runner,
      now: createClock([
        '2026-06-25T09:00:01.000Z',
        '2026-06-25T09:00:02.000Z',
      ]),
    });

    const result = await worker.runWarmupJob(job.jobId);

    expect(result).toMatchObject({
      status: 'failed',
      summary: {
        recordsScanned: 1,
      },
      errors: [
        {
          stage: 'merge_topics',
          message: '模型返回 JSON 不符合结构要求：缺少字段 mappings.0.summary',
        },
      ],
    });
    await expect(store.getWarmupJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      stage: 'merge_topics',
      errorStage: 'merge_topics',
      errorMessage: '模型返回 JSON 不符合结构要求：缺少字段 mappings.0.summary',
    });
  });
});

class FakeReviewSource implements ReviewSource {
  readonly kind = 'postgres';
  readonly queries: unknown[] = [];

  constructor(private readonly reviews: ReviewRecord[]) {}

  async listReviews(query: Parameters<ReviewSource['listReviews']>[0]): Promise<ReviewRecord[]> {
    this.queries.push(structuredClone(query));
    const filters = isRecord(query.filters) ? query.filters : {};
    const startDate = typeof filters.startDate === 'string' ? filters.startDate : undefined;
    const endDate = typeof filters.endDate === 'string' ? filters.endDate : undefined;
    return this.reviews
      .filter((record) => {
        const reviewDate = typeof record.mappedFields.reviewDate === 'string' ? record.mappedFields.reviewDate : undefined;
        if ((startDate || endDate) && !reviewDate) {
          return false;
        }
        if (startDate && reviewDate && reviewDate < `${startDate} 00:00:00`) {
          return false;
        }
        if (endDate && reviewDate && reviewDate > `${endDate} 23:59:59`) {
          return false;
        }
        return true;
      })
      .map((record) => structuredClone(record));
  }

  async getSourceVersion() {
    return {
      kind: 'postgres' as const,
      sourceId: 'base-token-a:tbl-review',
      version: 'source-version',
      contentHash: 'content-hash',
      recordCount: this.reviews.length,
      generatedAt: '2026-06-25T09:00:00.000Z',
    };
  }
}

class MissingVersionReviewSource implements ReviewSource {
  readonly kind = 'postgres';

  async listReviews(query: Parameters<ReviewSource['listReviews']>[0]): Promise<ReviewRecord[]> {
    await this.getSourceVersion(query);
    return [];
  }

  async getSourceVersion() {
    throw new Error('source version not found for missing-base:missing-table; run sync first');
  }
}

function review(recordId: string, content: string, reviewDate: string): ReviewRecord {
  return {
    recordId,
    fields: {},
    mappedFields: {
      reviewId: recordId,
      hotelName: '昆明中维翠湖宾馆',
      score: 5,
      reviewDate,
      checkInMonth: '2026-06-01 00:00:00',
      roomType: '大床房',
      replyContent: '',
      content,
    },
    content,
    contentHash: `${recordId}-hash`,
  };
}

function createClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
