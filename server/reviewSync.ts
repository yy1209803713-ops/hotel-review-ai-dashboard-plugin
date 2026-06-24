import { createHash } from 'node:crypto';
import {
  BackendAnalysisError,
  canonicalJson,
  type BackendAnalysisSourceKind,
  type SourceVersion,
} from './backendAnalysis';
import type { ReviewSyncJob, ReviewSyncStore } from './postgresReviewSyncStore';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';

export type ReviewSyncTriggerType = 'event' | 'schedule' | 'manual' | 'analysis_preflight';

export type ReviewSyncSourceKey = {
  tenantKey: string;
  sourceKind: BackendAnalysisSourceKind;
  sourceId: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldMapping: Record<string, string>;
};

export type FeishuRecordChangedOperation = 'create' | 'update' | 'delete';

export type FeishuRecordChangedEvent = {
  sourceKey: ReviewSyncSourceKey;
  recordId: string;
  operation: FeishuRecordChangedOperation;
};

export type ReviewSyncServiceOptions = {
  store: ReviewSyncStore;
  sourceReaders: Partial<Record<BackendAnalysisSourceKind, ReviewSource>>;
  now?: () => string;
};

export class ReviewSyncService {
  private readonly store: ReviewSyncStore;
  private readonly sourceReaders: Partial<Record<BackendAnalysisSourceKind, ReviewSource>>;
  private readonly now: () => string;

  constructor(options: ReviewSyncServiceOptions) {
    this.store = options.store;
    this.sourceReaders = options.sourceReaders;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async enqueueSyncJob(sourceKey: ReviewSyncSourceKey, triggerType: ReviewSyncTriggerType): Promise<ReviewSyncJob> {
    validateSourceKey(sourceKey);
    return this.store.createSyncJob({
      sourceKey,
      triggerType,
      createdAt: this.now(),
    });
  }

  async runFullSync(sourceKey: ReviewSyncSourceKey, triggerType: ReviewSyncTriggerType = 'manual'): Promise<ReviewSyncJob> {
    const createdJob = await this.enqueueSyncJob(sourceKey, triggerType);
    return this.runQueuedSyncJob(createdJob.jobId, sourceKey);
  }

  async runQueuedSyncJob(jobId: string, sourceKey?: ReviewSyncSourceKey): Promise<ReviewSyncJob> {
    const queuedJob = await this.store.getSyncJob(jobId);
    const resolvedSourceKey = sourceKey ?? queuedJob?.sourceKey;
    validateSourceKey(resolvedSourceKey);
    const claimedJob = await this.store.claimSyncJob(jobId, this.now());
    if (!claimedJob) {
      throw new BackendAnalysisError(409, 'sync_source', 'sync job is not queued');
    }
    let currentJob = claimedJob;
    const jobSourceKey = claimedJob.sourceKey ?? resolvedSourceKey;

    try {
      const source = this.sourceReaders[jobSourceKey.sourceKind];
      if (!source) {
        throw new BackendAnalysisError(400, 'sync_source', `review source ${jobSourceKey.sourceKind} is not configured for sync`);
      }

      const reviews = await source.listReviews(toReviewSourceQuery(jobSourceKey));
      currentJob = await this.store.updateSyncJob({
        ...claimedJob,
        stage: 'write_records',
        recordsRead: reviews.length,
        updatedAt: this.now(),
      });

      currentJob = await this.store.updateSyncJob({
        ...currentJob,
        stage: 'write_source_version',
        recordsRead: reviews.length,
        updatedAt: this.now(),
      });
      const generatedAt = this.now();
      const sourceVersion = buildSyncedSourceVersion(jobSourceKey, reviews, generatedAt);
      currentJob = await this.store.completeSyncJob({
        job: currentJob,
        sourceKey: jobSourceKey,
        reviews,
        sourceVersion,
        syncedAt: generatedAt,
      });
      return currentJob;
    } catch (cause) {
      const failedAt = this.now();
      const error = normalizeSyncError(cause);
      await this.store.updateSyncJob({
        ...currentJob,
        status: 'failed',
        stage: 'failed',
        errorStage: currentJob.stage,
        errorMessage: error.message,
        finishedAt: failedAt,
        updatedAt: failedAt,
      });
      throw error;
    }
  }

  async handleFeishuRecordChangedEvent(event: FeishuRecordChangedEvent): Promise<ReviewSyncJob> {
    validateSourceKey(event.sourceKey);
    if (!isNonEmptyString(event.recordId)) {
      throw new BackendAnalysisError(400, 'validate_request', 'recordId is required');
    }
    if (!['create', 'update', 'delete'].includes(event.operation)) {
      throw new BackendAnalysisError(400, 'validate_request', 'operation must be create, update, or delete');
    }

    return this.runFullSync(event.sourceKey, 'event');
  }
}

function toReviewSourceQuery(sourceKey: ReviewSyncSourceKey): ReviewSourceQuery {
  return {
    tenantKey: sourceKey.tenantKey,
    baseToken: sourceKey.baseToken,
    tableId: sourceKey.tableId,
    viewId: sourceKey.viewId,
    fieldMapping: sourceKey.fieldMapping,
  };
}

function buildSyncedSourceVersion(sourceKey: ReviewSyncSourceKey, reviews: ReviewRecord[], generatedAt: string): SourceVersion {
  const stableRecords = reviews
    .map((review) => ({
      recordId: review.recordId,
      contentHash: review.contentHash,
      mappedFields: review.mappedFields,
    }))
    .sort((left, right) => left.recordId.localeCompare(right.recordId));
  const contentHash = sha256(
    canonicalJson({
      sourceId: sourceKey.sourceId,
      records: stableRecords,
    }),
  );

  return {
    kind: sourceKey.sourceKind,
    sourceId: sourceKey.sourceId,
    version: `source-${contentHash.slice(0, 16)}`,
    contentHash,
    recordCount: reviews.length,
    generatedAt,
  };
}

function validateSourceKey(sourceKey: ReviewSyncSourceKey | undefined): asserts sourceKey is ReviewSyncSourceKey {
  if (!sourceKey || typeof sourceKey !== 'object') {
    throw new BackendAnalysisError(400, 'validate_request', 'sourceKey is required');
  }
  const missing = ['tenantKey', 'sourceKind', 'sourceId'].filter((key) => !isNonEmptyString(sourceKey[key as keyof ReviewSyncSourceKey]));
  if (missing.length > 0) {
    throw new BackendAnalysisError(400, 'validate_request', `missing sourceKey fields: ${missing.join(', ')}`);
  }
  if (!sourceKey.fieldMapping || typeof sourceKey.fieldMapping !== 'object' || Array.isArray(sourceKey.fieldMapping)) {
    throw new BackendAnalysisError(400, 'validate_request', 'sourceKey.fieldMapping is required');
  }
  for (const [fieldName, fieldId] of Object.entries(sourceKey.fieldMapping)) {
    if (!isNonEmptyString(fieldId)) {
      throw new BackendAnalysisError(400, 'validate_request', `sourceKey.fieldMapping.${fieldName} must be a non-empty string`);
    }
  }
}

function normalizeSyncError(cause: unknown): BackendAnalysisError {
  if (cause instanceof BackendAnalysisError) {
    return cause;
  }
  return new BackendAnalysisError(500, 'sync_source', cause instanceof Error ? cause.message : String(cause));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
