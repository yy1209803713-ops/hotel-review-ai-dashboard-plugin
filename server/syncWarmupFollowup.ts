import type { ReviewSyncJob } from './postgresReviewSyncStore';
import type { ReviewSyncSourceKey } from './reviewSync';
import type { WarmupMode } from './warmupTypes';

export type SyncWarmupOptions = {
  enabled: true;
  mode: WarmupMode;
  startDate?: string;
  endDate?: string;
};

export type SyncWarmupFollowupQueueOptions = {
  runSyncJob(jobId: string): Promise<ReviewSyncJob>;
  createWarmupJob(input: {
    request: {
      mode: WarmupMode;
      source: 'manual';
      baseToken?: string;
      tableId?: string;
      fieldMapping?: Record<string, string>;
      startDate?: string;
      endDate?: string;
    };
    triggerType: 'sync_followup';
  }): Promise<{ jobId: string }>;
  enqueueWarmupJob(jobId: string): void;
};

export function createSyncWarmupFollowupQueue(options: SyncWarmupFollowupQueueOptions) {
  return {
    createWarmupJob: options.createWarmupJob,
    enqueueWarmupJob: options.enqueueWarmupJob,

    async runSyncJobWithWarmup(
      syncJobId: string,
      sourceKey: ReviewSyncSourceKey | undefined,
      warmup: SyncWarmupOptions | undefined,
    ): Promise<ReviewSyncJob> {
      const syncJob = await options.runSyncJob(syncJobId);
      if (syncJob.status !== 'success' || !warmup || !sourceKey) {
        return syncJob;
      }
      const warmupJob = await options.createWarmupJob({
        request: {
          mode: warmup.mode,
          source: 'manual',
          baseToken: sourceKey.baseToken,
          tableId: sourceKey.tableId,
          fieldMapping: sourceKey.fieldMapping,
          startDate: warmup.startDate,
          endDate: warmup.endDate,
        },
        triggerType: 'sync_followup',
      });
      options.enqueueWarmupJob(warmupJob.jobId);
      return syncJob;
    },
  };
}
