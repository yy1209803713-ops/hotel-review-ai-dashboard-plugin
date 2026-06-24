import type { ReviewSyncJob, ReviewSyncStore } from './postgresReviewSyncStore';

export type SyncJobQueue = {
  enqueue(jobId: string): void;
};

export type StartupSyncReplayOptions = {
  store: Pick<ReviewSyncStore, 'listReplayableSyncJobs'>;
  queue: SyncJobQueue;
  limit?: number;
};

export async function replayQueuedSyncJobsOnStartup(options: StartupSyncReplayOptions): Promise<ReviewSyncJob[]> {
  const limit = options.limit ?? 1000;
  try {
    const jobs = await options.store.listReplayableSyncJobs(limit);
    for (const job of jobs) {
      options.queue.enqueue(job.jobId);
    }
    return jobs;
  } catch (cause) {
    console.error('__HOTEL_REVIEW_AI_SYNC_JOB_REPLAY_ERROR__', {
      stage: 'list_replayable_sync_jobs',
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}
