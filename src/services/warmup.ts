import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type {
  AnalysisResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
} from '../types/analysis';
import type {
  AnalysisCacheUsage,
  ReadTopicMappingsImpl,
  SourceTopicMapping,
  TopicMappingUsage,
} from './analysisPipeline';

export type WarmupMode = 'bootstrap' | 'incremental';
export type WarmupSource = 'dashboard-button' | 'feishu-workflow' | 'manual';
export type WarmupStatus = 'accepted' | 'running' | 'success' | 'partial_success' | 'failed' | 'skipped';
export type WarmupStage =
  | 'validate_request'
  | 'lock'
  | 'read_reviews'
  | 'read_evidence_cache'
  | 'extract_evidence'
  | 'save_evidence_cache'
  | 'read_topic_mapping_cache'
  | 'merge_topics'
  | 'save_topic_mapping_cache';

export type WarmupRequest = {
  mode: WarmupMode;
  source: WarmupSource;
  baseToken?: string;
  tableId: string;
  viewId?: string;
  fieldMapping?: Record<string, string>;
  startDate?: string;
  endDate?: string;
  configId?: string;
  dryRun?: boolean;
};

export type WarmupSummary = {
  recordsScanned?: number;
  totalReviews: number;
  evidenceCacheHits: number;
  evidenceCacheMisses: number;
  evidenceRecordsSaved: number;
  evidenceCacheInserts?: number;
  evidenceCacheUpdates?: number;
  topicMappingHits: number;
  topicMappingMisses: number;
  topicMappingsSaved: number;
  topicMappingCacheInserts?: number;
  topicMappingCacheUpdates?: number;
};

export type WarmupError = {
  stage: WarmupStage;
  message: string;
  recordId?: string;
};

export type WarmupResponse = {
  jobId: string;
  status: WarmupStatus;
  mode: WarmupMode;
  summary: WarmupSummary;
  errors: WarmupError[];
};

export type WarmupEvidenceCacheReadResult = {
  tableId?: string;
  hits: Array<{
    cacheRecordId: string;
    record: ReviewRecord;
    evidenceItems: TopicEvidenceItem[];
  }>;
  misses: ReviewRecord[];
};

export type WarmupTopicMappingCacheReadResult = {
  tableId?: string;
  hits: Array<{
    cacheRecordId: string;
    candidate: TopicMergeCandidate;
    mapping: SourceTopicMapping;
  }>;
  misses: TopicMergeCandidate[];
};

export type WarmupLock = {
  acquire(key: string): Promise<boolean>;
  release(key: string): Promise<void>;
};

export type WarmupAnalysisParams = {
  records: ReviewRecord[];
  config: AiConfig;
  filters: FilterState;
  fields: FieldMapping;
  now?: string;
  cachedEvidenceItems?: TopicEvidenceItem[];
  cacheMissRecords?: ReviewRecord[];
  readTopicMappingsImpl?: ReadTopicMappingsImpl;
  onCacheUsage?: (usage: AnalysisCacheUsage) => void | Promise<void>;
  onTopicMappingUsage?: (usage: TopicMappingUsage) => void | Promise<void>;
};

export type WarmupAnalysisCacheParams = {
  request: WarmupRequest;
  config: AiConfig;
  filters: FilterState;
  fields: FieldMapping;
  readReviews(): Promise<ReviewRecord[]>;
  readEvidenceCache(params: {
    tableId: string;
    model: string;
    records: ReviewRecord[];
  }): Promise<WarmupEvidenceCacheReadResult>;
  readTopicMappingCache(params: {
    tableId: string;
    model: string;
    candidates: TopicMergeCandidate[];
  }): Promise<WarmupTopicMappingCacheReadResult>;
  saveEvidenceCacheEntries(params: {
    tableId: string;
    model: string;
    records: ReviewRecord[];
    evidenceItems: TopicEvidenceItem[];
    now?: string;
  }): Promise<void>;
  saveTopicMappingCacheEntries(params: {
    tableId: string;
    model: string;
    candidates: TopicMergeCandidate[];
    groups: TopicMergeGroup[];
    now?: string;
  }): Promise<void>;
  runAnalysis(params: WarmupAnalysisParams): Promise<AnalysisResult>;
  lock?: WarmupLock;
  now?: () => string;
};

const EMPTY_SUMMARY: WarmupSummary = {
  recordsScanned: 0,
  totalReviews: 0,
  evidenceCacheHits: 0,
  evidenceCacheMisses: 0,
  evidenceRecordsSaved: 0,
  topicMappingHits: 0,
  topicMappingMisses: 0,
  topicMappingsSaved: 0,
};

export async function warmupAnalysisCache(params: WarmupAnalysisCacheParams): Promise<WarmupResponse> {
  const startedAt = params.now?.() ?? new Date().toISOString();
  const mode = isWarmupMode(params.request.mode) ? params.request.mode : 'incremental';
  const jobId = createWarmupJobId(startedAt, params.request.tableId);
  logWarmupTrigger(params.request, jobId, mode);
  const validationErrors = validateWarmupRequest(params.request);

  if (validationErrors.length) {
    return {
      jobId,
      status: 'failed',
      mode,
      summary: { ...EMPTY_SUMMARY },
      errors: [
        {
          stage: 'validate_request',
          message: validationErrors.join('; '),
        },
      ],
    };
  }

  const lockKey = buildWarmupLockKey(params.request);
  const acquired = params.lock ? await params.lock.acquire(lockKey) : true;
  if (!acquired) {
    return {
      jobId,
      status: 'skipped',
      mode,
      summary: { ...EMPTY_SUMMARY },
      errors: [
        {
          stage: 'lock',
          message: `warmup lock is already held for ${lockKey}`,
        },
      ],
    };
  }

  try {
    const summary: WarmupSummary = { ...EMPTY_SUMMARY };
    const records = await runStage('read_reviews', () => params.readReviews());
    summary.recordsScanned = records.length;
    summary.totalReviews = records.length;

    const evidenceCache = await runStage('read_evidence_cache', () =>
      params.readEvidenceCache({
        tableId: params.request.tableId,
        model: params.config.model,
        records,
      }),
    );
    summary.evidenceCacheHits = evidenceCache.hits.length;
    summary.evidenceCacheMisses = evidenceCache.misses.length;

    if (!evidenceCache.misses.length) {
      return {
        jobId,
        status: 'success',
        mode,
        summary,
        errors: [],
      };
    }

    await runStage('extract_evidence', () =>
      params.runAnalysis({
        records,
        config: params.config,
        filters: params.filters,
        fields: params.fields,
        now: startedAt,
        cachedEvidenceItems: evidenceCache.hits.flatMap((hit) => hit.evidenceItems),
        cacheMissRecords: evidenceCache.misses,
        readTopicMappingsImpl: async ({ candidates }) => {
          const topicCache = await runStage('read_topic_mapping_cache', () =>
            params.readTopicMappingCache({
              tableId: params.request.tableId,
              model: params.config.model,
              candidates,
            }),
          );
          summary.topicMappingHits = topicCache.hits.length;
          summary.topicMappingMisses = topicCache.misses.length;
          return {
            cachedMappings: topicCache.hits.map((hit) => hit.mapping),
            cachedCandidates: topicCache.hits.map((hit) => hit.candidate),
          };
        },
        onCacheUsage: async (usage) => {
          if (!usage.newEvidenceItems.length) {
            return;
          }
          await runStage('save_evidence_cache', () =>
            params.saveEvidenceCacheEntries({
              tableId: params.request.tableId,
              model: params.config.model,
              records: evidenceCache.misses,
              evidenceItems: usage.newEvidenceItems,
              now: startedAt,
            }),
          );
          summary.evidenceRecordsSaved = evidenceCache.misses.length;
        },
        onTopicMappingUsage: async (usage) => {
          summary.topicMappingHits = usage.cachedMappingCount;
          summary.topicMappingMisses = usage.missedCandidateCount;
          if (!usage.newCandidates.length || !usage.newGroups.length) {
            return;
          }
          await runStage('save_topic_mapping_cache', () =>
            params.saveTopicMappingCacheEntries({
              tableId: params.request.tableId,
              model: params.config.model,
              candidates: usage.newCandidates,
              groups: usage.newGroups,
              now: startedAt,
            }),
          );
          summary.topicMappingsSaved = usage.newCandidates.length;
        },
      }),
    );

    return {
      jobId,
      status: 'success',
      mode,
      summary,
      errors: [],
    };
  } catch (cause) {
    const warmupError = toWarmupStageError(cause);
    return {
      jobId,
      status: 'failed',
      mode,
      summary: { ...EMPTY_SUMMARY },
      errors: [warmupError],
    };
  } finally {
    await params.lock?.release(lockKey);
  }
}

export function buildWarmupLockKey(request: Pick<WarmupRequest, 'baseToken' | 'tableId'>): string {
  return `warmup:${request.baseToken?.trim() || 'local'}:${request.tableId.trim()}`;
}

function logWarmupTrigger(request: WarmupRequest, jobId: string, mode: WarmupMode): void {
  if (request.source !== 'feishu-workflow') {
    return;
  }
  console.info(
    '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
    JSON.stringify({
      jobId,
      source: request.source,
      mode,
      baseToken: request.baseToken,
      tableId: request.tableId,
      viewId: request.viewId,
      dryRun: Boolean(request.dryRun),
    }),
  );
}

function createWarmupJobId(startedAt: string, tableId: string): string {
  return `warmup-${startedAt}-${tableId || 'unknown-table'}`;
}

function validateWarmupRequest(request: WarmupRequest): string[] {
  const errors: string[] = [];
  if (!isWarmupMode(request.mode)) {
    errors.push('mode must be bootstrap or incremental');
  }
  if (!request.tableId?.trim()) {
    errors.push('tableId is required');
  }
  return errors;
}

function isWarmupMode(mode: unknown): mode is WarmupMode {
  return mode === 'bootstrap' || mode === 'incremental';
}

async function runStage<T>(stage: WarmupStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new WarmupStageError(stage, getErrorMessage(cause));
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

function toWarmupStageError(cause: unknown): WarmupError {
  if (cause instanceof WarmupStageError) {
    return {
      stage: cause.stage,
      message: cause.message,
    };
  }
  return {
    stage: 'extract_evidence',
    message: getErrorMessage(cause),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
