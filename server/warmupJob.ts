import { BackendAnalysisError, type JsonValue } from './backendAnalysis';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY, type ReviewSyncSourceKey } from './reviewSync';
import type { WarmupJob, WarmupJobStore, WarmupTriggerType } from './warmupJobStore';
import type { WarmupMode, WarmupRequest, WarmupResponse, WarmupStage } from './warmupTypes';
import { DEFAULT_CONFIG } from '../src/constants/defaults';
import { isReviewDateRangeBoundaryString } from '../src/services/filtering';

export type WarmupServiceOptions = {
  store: WarmupJobStore;
  now?: () => string;
};

export type CreateWarmupJobInput = {
  request: WarmupRequest;
  triggerType: WarmupTriggerType;
};

export type WarmupService = {
  createWarmupJob(input: CreateWarmupJobInput): Promise<WarmupJob>;
};

export type WarmupJobWorkerOptions = {
  store: WarmupJobStore;
  reviewSource: ReviewSource;
  runner: AnalysisRunner;
  now?: () => string;
};

type CacheDiagnostics = {
  evidenceCache?: {
    hits?: number;
    misses?: number;
  };
  topicMappingCache?: {
    hits?: number;
    misses?: number;
  };
};

type CacheWriteDiagnostics = {
  evidenceCache?: {
    inserts?: number;
    updates?: number;
  };
  topicMappingCache?: {
    inserts?: number;
    updates?: number;
  };
};

const EMPTY_SUMMARY: WarmupResponse['summary'] = {
  recordsScanned: 0,
  totalReviews: 0,
  evidenceCacheHits: 0,
  evidenceCacheMisses: 0,
  evidenceRecordsSaved: 0,
  evidenceCacheInserts: 0,
  evidenceCacheUpdates: 0,
  topicMappingHits: 0,
  topicMappingMisses: 0,
  topicMappingsSaved: 0,
  topicMappingCacheInserts: 0,
  topicMappingCacheUpdates: 0,
};

export function createWarmupService(options: WarmupServiceOptions): WarmupService {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async createWarmupJob(input) {
      const mode = isWarmupMode(input.request.mode) ? input.request.mode : 'incremental';
      const validationMessage = validateWarmupRequest(input.request);
      if (validationMessage) {
        throw new BackendAnalysisError(400, 'validate_request', validationMessage);
      }
      const sourceKey = buildWarmupSourceKey(input.request);
      const acceptedResponse: WarmupResponse = {
        jobId: 'pending',
        status: 'accepted',
        mode,
        summary: { ...EMPTY_SUMMARY },
        errors: [],
      };
      return options.store.createWarmupJob({
        sourceKey,
        mode,
        triggerType: input.triggerType,
        request: normalizeWarmupRequest(input.request, mode),
        acceptedResponse,
        createdAt: now(),
      });
    },
  };
}

export class WarmupJobWorker {
  private readonly store: WarmupJobStore;
  private readonly reviewSource: ReviewSource;
  private readonly runner: AnalysisRunner;
  private readonly now: () => string;

  constructor(options: WarmupJobWorkerOptions) {
    this.store = options.store;
    this.reviewSource = options.reviewSource;
    this.runner = options.runner;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runWarmupJob(jobId: string): Promise<WarmupResponse> {
    const startedAt = this.now();
    const job = await this.store.claimWarmupJob(jobId, startedAt);
    if (!job) {
      throw new BackendAnalysisError(409, 'lock', 'warmup job is not queued');
    }

    let recordsScanned = 0;
    try {
      const query = buildWarmupReviewSourceQuery(job);
      await runStage('read_reviews', () => this.reviewSource.getSourceVersion(query));
      const reviews = await runStage('read_reviews', () => this.reviewSource.listReviews(query));
      recordsScanned = reviews.length;
      const runnerResult = await runStage('extract_evidence', () =>
        this.runner.run({
          reviews,
          query,
          jobId,
          pipelineVersion: 'warmup-cache-v1',
        }),
      );
      const result = buildSuccessResponse(job, runnerResult.summary, recordsScanned);
      await this.store.completeWarmupJob({
        job,
        result,
        finishedAt: this.now(),
      });
      return result;
    } catch (cause) {
      const error = toWarmupError(cause);
      const result: WarmupResponse = {
        jobId,
        status: 'failed',
        mode: job.mode,
        summary: { ...EMPTY_SUMMARY, recordsScanned },
        errors: [error],
      };
      await this.store.failWarmupJob({
        job,
        result,
        finishedAt: this.now(),
      });
      return result;
    }
  }
}

function buildSuccessResponse(job: WarmupJob, summary: JsonValue, recordsScanned: number): WarmupResponse {
  const source = isRecord(summary) ? summary : {};
  const overview = readObject(source.overview);
  const cacheDiagnostics = readObject(source.cacheDiagnostics) as CacheDiagnostics;
  const cacheWriteDiagnostics = readObject(source.cacheWriteDiagnostics) as CacheWriteDiagnostics;
  const evidenceHits = readNumber(cacheDiagnostics.evidenceCache?.hits);
  const evidenceMisses = readNumber(cacheDiagnostics.evidenceCache?.misses);
  const topicHits = readNumber(cacheDiagnostics.topicMappingCache?.hits);
  const topicMisses = readNumber(cacheDiagnostics.topicMappingCache?.misses);
  const evidenceInserts = readNumber(cacheWriteDiagnostics.evidenceCache?.inserts);
  const evidenceUpdates = readNumber(cacheWriteDiagnostics.evidenceCache?.updates);
  const topicInserts = readNumber(cacheWriteDiagnostics.topicMappingCache?.inserts);
  const topicUpdates = readNumber(cacheWriteDiagnostics.topicMappingCache?.updates);
  return {
    jobId: job.jobId,
    status: 'success',
    mode: job.mode,
    summary: {
      recordsScanned,
      totalReviews: readNumber(source.totalReviews ?? overview.totalReviews),
      evidenceCacheHits: evidenceHits,
      evidenceCacheMisses: evidenceMisses,
      evidenceRecordsSaved: evidenceInserts + evidenceUpdates || evidenceMisses,
      evidenceCacheInserts: evidenceInserts,
      evidenceCacheUpdates: evidenceUpdates,
      topicMappingHits: topicHits,
      topicMappingMisses: topicMisses,
      topicMappingsSaved: topicInserts + topicUpdates || topicMisses,
      topicMappingCacheInserts: topicInserts,
      topicMappingCacheUpdates: topicUpdates,
    },
    errors: [],
  };
}

function buildWarmupReviewSourceQuery(job: WarmupJob): ReviewSourceQuery {
  const filters = {
    ...DEFAULT_CONFIG.filters,
    periodType: 'custom',
    startDate: job.request.startDate ?? '',
    endDate: job.request.endDate ?? '',
  };
  return {
    tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
    baseToken: job.baseToken,
    tableId: job.tableId,
    fieldMapping: job.request.fieldMapping ?? {},
    filters,
    sourceConfig: {
      sourceId: job.sourceId,
      upstreamSourceKind: job.sourceKind,
    },
  };
}

export function buildWarmupSourceKey(request: Pick<WarmupRequest, 'baseToken' | 'tableId' | 'fieldMapping'>): ReviewSyncSourceKey {
  const baseToken = requireNonEmptyString(request.baseToken, 'baseToken is required');
  const tableId = requireNonEmptyString(request.tableId, 'tableId is required');
  return {
    tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
    sourceKind: 'feishu_base',
    sourceId: `${baseToken}:${tableId}`,
    baseToken,
    tableId,
    fieldMapping: request.fieldMapping ?? {},
  };
}

export function createWarmupAcceptedResponse(job: WarmupJob): WarmupResponse {
  return {
    ...job.acceptedResponse,
    jobId: job.jobId,
  };
}

function normalizeWarmupRequest(request: WarmupRequest, mode: WarmupMode): WarmupRequest {
  return {
    ...request,
    mode,
    baseToken: request.baseToken?.trim(),
    tableId: request.tableId.trim(),
    viewId: request.viewId?.trim() || undefined,
    startDate: request.startDate?.trim() || undefined,
    endDate: request.endDate?.trim() || undefined,
  };
}

function validateWarmupRequest(request: WarmupRequest): string {
  const errors: string[] = [];
  if (!isWarmupMode(request.mode)) {
    errors.push('mode must be bootstrap or incremental');
  }
  if (!request.baseToken?.trim()) {
    errors.push('baseToken is required');
  }
  if (!request.tableId?.trim()) {
    errors.push('tableId is required');
  }
  if (request.startDate && !isDateString(request.startDate)) {
    errors.push('startDate must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss');
  }
  if (request.endDate && !isDateString(request.endDate)) {
    errors.push('endDate must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss');
  }
  return errors.join('; ');
}

function isWarmupMode(mode: unknown): mode is WarmupMode {
  return mode === 'bootstrap' || mode === 'incremental';
}

function isDateString(value: string): boolean {
  return isReviewDateRangeBoundaryString(value);
}

async function runStage<T>(stage: WarmupStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new WarmupStageError(stage, errorMessage(cause));
  }
}

class WarmupStageError extends Error {
  constructor(
    public readonly stage: WarmupStage,
    message: string,
  ) {
    super(message);
    this.name = 'WarmupStageError';
  }
}

function toWarmupError(cause: unknown): WarmupResponse['errors'][number] {
  if (cause instanceof WarmupStageError) {
    return {
      stage: cause.stage,
      message: cause.message,
    };
  }
  return {
    stage: 'extract_evidence',
    message: errorMessage(cause),
  };
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BackendAnalysisError(400, 'validate_request', message);
  }
  return value.trim();
}

function readObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
