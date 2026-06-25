import { describe, expect, it, vi } from 'vitest';
import { createSyncWarmupFollowupQueue } from './syncWarmupFollowup';
import type { ReviewSyncJob } from './postgresReviewSyncStore';
import { createInMemoryReviewSyncStore } from './postgresReviewSyncStore';
import { PostgresReviewSource } from './postgresReviewSource';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY, ReviewSyncService, type ReviewSyncSourceKey } from './reviewSync';
import { createInMemoryWarmupJobStore } from './warmupJobStore';
import { WarmupJobWorker, createWarmupService } from './warmupJob';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord, ReviewSource } from './reviewSource';

describe('createSyncWarmupFollowupQueue', () => {
  it('enqueues warmup only after the sync job completes successfully', async () => {
    const runSyncJob = vi.fn(async () => syncJob('success'));
    const createWarmupJob = vi.fn(async () => ({ jobId: 'warmup-job-1' }));
    const enqueueWarmupJob = vi.fn();
    const queue = createSyncWarmupFollowupQueue({
      runSyncJob,
      createWarmupJob,
      enqueueWarmupJob,
    });

    await queue.runSyncJobWithWarmup('sync-job-1', sourceKey, {
      enabled: true,
      mode: 'incremental',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });

    expect(createWarmupJob).toHaveBeenCalledWith({
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        fieldMapping: sourceKey.fieldMapping,
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
      triggerType: 'sync_followup',
    });
    expect(enqueueWarmupJob).toHaveBeenCalledWith('warmup-job-1');
  });

  it('does not enqueue warmup after a failed sync job', async () => {
    const queue = createSyncWarmupFollowupQueue({
      runSyncJob: vi.fn(async () => syncJob('failed')),
      createWarmupJob: vi.fn(async () => ({ jobId: 'warmup-job-1' })),
      enqueueWarmupJob: vi.fn(),
    });

    await queue.runSyncJobWithWarmup('sync-job-1', sourceKey, {
      enabled: true,
      mode: 'incremental',
    });

    expect(queue.createWarmupJob).not.toHaveBeenCalled();
    expect(queue.enqueueWarmupJob).not.toHaveBeenCalled();
  });

  it('runs sync before follow-up warmup so warmup reads the just-written read model changes', async () => {
    const reviewStore = createInMemoryReviewSyncStore();
    const warmupStore = createInMemoryWarmupJobStore();
    const feishuSource = new MutableReviewSource([
      review('rec-1', '旧评论'),
    ]);
    const syncService = new ReviewSyncService({
      store: reviewStore,
      sourceReaders: { feishu_base: feishuSource },
      now: createClock([
        '2026-06-25T08:00:00.000Z',
        '2026-06-25T08:00:01.000Z',
        '2026-06-25T08:00:02.000Z',
        '2026-06-25T08:00:03.000Z',
        '2026-06-25T08:00:04.000Z',
        '2026-06-25T08:01:00.000Z',
        '2026-06-25T08:01:01.000Z',
        '2026-06-25T08:01:02.000Z',
        '2026-06-25T08:01:03.000Z',
        '2026-06-25T08:01:04.000Z',
      ]),
    });
    await syncService.runFullSync(sourceKey);
    feishuSource.replace([
      review('rec-1', '新评论'),
      review('rec-2', '新增评论'),
    ]);
    const syncJob = await syncService.enqueueSyncJob(sourceKey, 'incremental');
    const warmupService = createWarmupService({
      store: warmupStore,
      now: () => '2026-06-25T08:01:05.000Z',
    });
    const warmedContents: string[][] = [];
    const runner: AnalysisRunner = {
      run: vi.fn(async ({ reviews }) => {
        warmedContents.push(reviews.map((item) => String(item.mappedFields.content)));
        return {
          summary: {
            overview: { totalReviews: reviews.length },
            cacheDiagnostics: {
              evidenceCache: { hits: 0, misses: reviews.length },
              topicMappingCache: { hits: 0, misses: 0 },
            },
            cacheWriteDiagnostics: {
              evidenceCache: { inserts: reviews.length, updates: 0 },
              topicMappingCache: { inserts: 0, updates: 0 },
            },
          },
          topics: [],
          evidenceByTopic: {},
        };
      }),
    };
    const worker = new WarmupJobWorker({
      store: warmupStore,
      reviewSource: new PostgresReviewSource({ store: reviewStore }),
      runner,
      now: createClock([
        '2026-06-25T08:01:06.000Z',
        '2026-06-25T08:01:08.000Z',
      ]),
    });
    const warmupJobIds: string[] = [];
    const queue = createSyncWarmupFollowupQueue({
      runSyncJob: (jobId) => syncService.runQueuedSyncJob(jobId),
      createWarmupJob: (input) => warmupService.createWarmupJob(input),
      enqueueWarmupJob: (jobId) => {
        warmupJobIds.push(jobId);
      },
    });

    await expect(queue.runSyncJobWithWarmup(syncJob.jobId, sourceKey, {
      enabled: true,
      mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'success',
      recordsUpserted: 2,
      recordsUnchanged: 0,
    });
    expect(warmupJobIds).toEqual(['warmup-job-1']);

    await worker.runWarmupJob(warmupJobIds[0]);

    expect(warmedContents).toEqual([['新评论', '新增评论']]);
    await expect(warmupStore.getWarmupJob(warmupJobIds[0])).resolves.toMatchObject({
      status: 'success',
      recordsScanned: 2,
      evidenceCacheMisses: 2,
      evidenceCacheInserts: 2,
    });
  });
});

const sourceKey: ReviewSyncSourceKey = {
  tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
  sourceKind: 'feishu_base',
  sourceId: 'base-token-a:tbl-review',
  baseToken: 'base-token-a',
  tableId: 'tbl-review',
  fieldMapping: {
    content: 'fld-content',
    reviewDate: 'fld-review-date',
  },
};

function syncJob(status: ReviewSyncJob['status']): ReviewSyncJob {
  return {
    jobId: 'sync-job-1',
    sourceKey,
    tenantKey: sourceKey.tenantKey,
    sourceKind: sourceKey.sourceKind,
    sourceId: sourceKey.sourceId,
    mode: 'incremental',
    triggerType: 'manual_api',
    status,
    stage: status,
    recordsRead: 1,
    recordsUpserted: 1,
    recordsDeleted: 0,
    recordsUnchanged: 0,
    createdAt: '2026-06-25T08:00:00.000Z',
    updatedAt: '2026-06-25T08:00:01.000Z',
  };
}

class MutableReviewSource implements ReviewSource {
  readonly kind = 'feishu_base';

  constructor(private reviews: ReviewRecord[]) {}

  replace(reviews: ReviewRecord[]): void {
    this.reviews = reviews;
  }

  async listReviews(): Promise<ReviewRecord[]> {
    return this.reviews.map((item) => structuredClone(item));
  }

  async getSourceVersion() {
    return {
      kind: 'feishu_base' as const,
      sourceId: sourceKey.sourceId,
      version: 'source-version',
      contentHash: this.reviews.map((item) => item.contentHash).join('|'),
      recordCount: this.reviews.length,
      generatedAt: '2026-06-25T08:01:04.000Z',
    };
  }
}

function review(recordId: string, content: string): ReviewRecord {
  return {
    recordId,
    fields: {
      'fld-content': content,
      'fld-review-date': '2026-06-25 08:00:00',
    },
    mappedFields: {
      reviewId: recordId,
      hotelName: '昆明中维翠湖宾馆',
      score: 5,
      reviewDate: '2026-06-25 08:00:00',
      checkInMonth: '2026-06-01 00:00:00',
      roomType: '大床房',
      replyContent: '',
      content,
    },
    content,
    contentHash: `${recordId}:${content}`,
  };
}

function createClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
