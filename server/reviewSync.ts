import { createHash } from 'node:crypto';
import {
  BackendAnalysisError,
  canonicalJson,
  type BackendAnalysisSourceKind,
  type SourceVersion,
} from './backendAnalysis';
import type { ReviewSyncJob, ReviewSyncStore } from './postgresReviewSyncStore';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';

export const GLOBAL_REVIEW_SOURCE_TENANT_KEY = 'global-review-source';

export type ReviewSyncMode = 'full' | 'incremental';
export type ReviewSyncTriggerType = 'manual_api';

export type ReviewSyncSourceKey = {
  tenantKey: string;
  sourceKind: BackendAnalysisSourceKind;
  sourceId: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldMapping: Record<string, string>;
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

  async enqueueSyncJob(
    sourceKey: ReviewSyncSourceKey,
    mode: ReviewSyncMode,
    triggerType: ReviewSyncTriggerType = 'manual_api',
  ): Promise<ReviewSyncJob> {
    validateSourceKey(sourceKey);
    return this.store.createSyncJob({
      sourceKey,
      mode,
      triggerType,
      createdAt: this.now(),
    });
  }

  async runFullSync(sourceKey: ReviewSyncSourceKey): Promise<ReviewSyncJob> {
    const createdJob = await this.enqueueSyncJob(sourceKey, 'full');
    return this.runQueuedSyncJob(createdJob.jobId, sourceKey);
  }

  async runIncrementalSync(sourceKey: ReviewSyncSourceKey): Promise<ReviewSyncJob> {
    const createdJob = await this.enqueueSyncJob(sourceKey, 'incremental');
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

      const existingRecords = claimedJob.mode === 'incremental'
        ? await this.store.listReviewRecords(jobSourceKey)
        : [];
      const reviewsToUpsert = claimedJob.mode === 'incremental'
        ? diffChangedReviews(existingRecords, reviews)
        : reviews;
      const recordsUnchanged = claimedJob.mode === 'incremental'
        ? reviews.length - reviewsToUpsert.length
        : 0;

      currentJob = await this.store.updateSyncJob({
        ...currentJob,
        stage: 'write_source_version',
        recordsRead: reviews.length,
        recordsUnchanged,
        updatedAt: this.now(),
      });
      const generatedAt = this.now();
      const sourceVersion = buildSyncedSourceVersion(jobSourceKey, reviews, generatedAt);
      currentJob = await this.store.completeSyncJob({
        job: currentJob,
        sourceKey: jobSourceKey,
        reviews: reviewsToUpsert,
        activeRecordIds: reviews.map((review) => review.recordId),
        recordsRead: reviews.length,
        recordsUnchanged,
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
        durationMs: computeDurationMs(currentJob.startedAt, failedAt),
        updatedAt: failedAt,
      });
      throw error;
    }
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

function diffChangedReviews(existingRecords: Array<{ recordId: string; contentHash: string; parsedReview: Record<string, unknown> }>, reviews: ReviewRecord[]): ReviewRecord[] {
  const existingByRecordId = new Map(existingRecords.map((record) => [record.recordId, record]));
  return reviews.filter((review) => {
    const existing = existingByRecordId.get(review.recordId);
    if (!existing) {
      return true;
    }
    return canonicalJson(existing.parsedReview) !== canonicalJson(review.mappedFields);
  });
}

export function buildCanonicalReviewSyncSourceKey(input: {
  baseToken: string;
  tableId: string;
  fieldMapping: Record<string, string>;
}): ReviewSyncSourceKey {
  validateSyncSourceInput(input);
  const baseToken = input.baseToken.trim();
  const tableId = input.tableId.trim();
  return {
    tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
    sourceKind: 'feishu_base',
    sourceId: `${baseToken}:${tableId}`,
    baseToken,
    tableId,
    fieldMapping: input.fieldMapping,
  };
}

function validateSyncSourceInput(input: { baseToken?: unknown; tableId?: unknown; fieldMapping?: unknown }): void {
  const missing = ['baseToken', 'tableId', 'fieldMapping'].filter((fieldName) => !hasRequiredSyncSourceField(input, fieldName));
  if (missing.length) {
    throw new BackendAnalysisError(400, 'validate_request', `missing sync source fields: ${missing.join(', ')}`);
  }
  for (const [fieldName, fieldId] of Object.entries(input.fieldMapping as Record<string, unknown>)) {
    if (!isNonEmptyString(fieldId)) {
      throw new BackendAnalysisError(400, 'validate_request', `fieldMapping.${fieldName} must be a non-empty string`);
    }
  }
}

function hasRequiredSyncSourceField(input: { baseToken?: unknown; tableId?: unknown; fieldMapping?: unknown }, fieldName: string): boolean {
  const value = input[fieldName as keyof typeof input];
  if (fieldName === 'fieldMapping') {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
  return isNonEmptyString(value);
}

export function computeDurationMs(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
  if (!startedAt || !finishedAt) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return undefined;
  }
  return Math.max(0, finished - started);
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
