import { describe, expect, it, vi } from 'vitest';
import { replayQueuedSyncJobsOnStartup } from './startupSyncReplay';
import type { ReviewSyncJob } from './postgresReviewSyncStore';

describe('replayQueuedSyncJobsOnStartup', () => {
  it('enqueues replayable sync jobs in created order', async () => {
    const jobs = [
      syncJob('sync-job-1', '2026-06-23T08:00:00.000Z'),
      syncJob('sync-job-2', '2026-06-23T08:01:00.000Z'),
    ];
    const listReplayableSyncJobs = vi.fn(async (limit: number) => jobs.slice(0, limit));
    const enqueue = vi.fn();

    const replayed = await replayQueuedSyncJobsOnStartup({
      store: { listReplayableSyncJobs },
      queue: { enqueue },
      limit: 10,
    });

    expect(listReplayableSyncJobs).toHaveBeenCalledWith(10);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, 'sync-job-1');
    expect(enqueue).toHaveBeenNthCalledWith(2, 'sync-job-2');
    expect(replayed.map((job) => job.jobId)).toEqual(['sync-job-1', 'sync-job-2']);
  });

  it('logs the replay stage when listing replayable jobs fails', async () => {
    const error = new Error('database unavailable');
    const listReplayableSyncJobs = vi.fn(async () => {
      throw error;
    });
    const enqueue = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      replayQueuedSyncJobsOnStartup({
        store: { listReplayableSyncJobs },
        queue: { enqueue },
      }),
    ).rejects.toThrow('database unavailable');

    expect(enqueue).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('__HOTEL_REVIEW_AI_SYNC_JOB_REPLAY_ERROR__', {
      stage: 'list_replayable_sync_jobs',
      message: 'database unavailable',
    });
    consoleError.mockRestore();
  });
});

function syncJob(jobId: string, createdAt: string): ReviewSyncJob {
  return {
    jobId,
    sourceKey: {
      tenantKey: 'tenant-a',
      sourceKind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review',
      baseToken: 'base-token-a',
      tableId: 'tbl-review',
      viewId: 'vew-active',
      fieldMapping: {
        content: 'fld-review',
        rating: 'fld-rating',
        hotelName: 'fld-hotel',
      },
    },
    tenantKey: 'tenant-a',
    sourceKind: 'feishu_base',
    sourceId: 'base-token-a:tbl-review',
    mode: 'full',
    triggerType: 'manual_api',
    status: 'running',
    stage: 'read_source',
    recordsRead: 0,
    recordsUpserted: 0,
    recordsDeleted: 0,
    recordsUnchanged: 0,
    startedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}
