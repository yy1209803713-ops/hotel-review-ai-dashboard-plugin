import type { PostgresQueryClient } from './postgresReviewSyncStore';
import type { ReviewSyncSourceKey } from './reviewSync';
import type { WarmupMode, WarmupRequest, WarmupResponse, WarmupStage } from './warmupTypes';

export type WarmupTriggerType = 'manual_api' | 'sync_followup' | 'feishu_workflow' | 'dashboard_button';
export type WarmupJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export type WarmupJob = {
  jobId: string;
  sourceKey: ReviewSyncSourceKey;
  tenantKey: string;
  sourceKind: ReviewSyncSourceKey['sourceKind'];
  sourceId: string;
  baseToken?: string;
  tableId?: string;
  mode: WarmupMode;
  triggerType: WarmupTriggerType;
  status: WarmupJobStatus;
  stage: WarmupStage | 'queued' | 'success' | 'failed';
  request: WarmupRequest;
  acceptedResponse: WarmupResponse;
  result: WarmupResponse | Record<string, never>;
  reviewStartDate?: string;
  reviewEndDate?: string;
  recordsScanned: number;
  evidenceCacheHits: number;
  evidenceCacheMisses: number;
  evidenceCacheInserts: number;
  evidenceCacheUpdates: number;
  topicMappingCacheHits: number;
  topicMappingCacheMisses: number;
  topicMappingCacheInserts: number;
  topicMappingCacheUpdates: number;
  errorStage?: WarmupStage;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
};

export type WarmupJobCreateInput = {
  sourceKey: ReviewSyncSourceKey;
  mode: WarmupMode;
  triggerType: WarmupTriggerType;
  request: WarmupRequest;
  acceptedResponse: WarmupResponse;
  createdAt: string;
};

export type WarmupJobStore = {
  createWarmupJob(input: WarmupJobCreateInput): Promise<WarmupJob>;
  getWarmupJob(jobId: string): Promise<WarmupJob | undefined>;
  listReplayableWarmupJobs(limit: number): Promise<WarmupJob[]>;
  claimWarmupJob(jobId: string, startedAt: string): Promise<WarmupJob | undefined>;
  updateWarmupJob(job: WarmupJob): Promise<WarmupJob>;
  completeWarmupJob(input: {
    job: WarmupJob;
    result: WarmupResponse;
    finishedAt: string;
  }): Promise<WarmupJob>;
  failWarmupJob(input: {
    job: WarmupJob;
    result: WarmupResponse;
    finishedAt: string;
  }): Promise<WarmupJob>;
};

export function createInMemoryWarmupJobStore(): WarmupJobStore {
  const jobs = new Map<string, WarmupJob>();
  let sequence = 1;

  return {
    async createWarmupJob(input) {
      const job = createQueuedWarmupJob(`warmup-job-${sequence++}`, input);
      jobs.set(job.jobId, deepClone(job));
      return deepClone(job);
    },

    async getWarmupJob(jobId) {
      return cloneOrUndefined(jobs.get(jobId));
    },

    async listReplayableWarmupJobs(limit) {
      return Array.from(jobs.values())
        .filter((job) => job.status === 'queued' || job.status === 'running')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit)
        .map((job) => deepClone(job));
    },

    async claimWarmupJob(jobId, startedAt) {
      const job = jobs.get(jobId);
      if (!job || (job.status !== 'queued' && job.status !== 'running')) {
        return undefined;
      }
      const claimed: WarmupJob = {
        ...job,
        status: 'running',
        stage: 'read_reviews',
        startedAt,
        updatedAt: startedAt,
      };
      jobs.set(jobId, deepClone(claimed));
      return deepClone(claimed);
    },

    async updateWarmupJob(job) {
      jobs.set(job.jobId, deepClone(job));
      return deepClone(job);
    },

    async completeWarmupJob(input) {
      const completed = finalizeWarmupJob(input.job, input.result, input.finishedAt, 'success');
      jobs.set(completed.jobId, deepClone(completed));
      return deepClone(completed);
    },

    async failWarmupJob(input) {
      const failed = finalizeWarmupJob(input.job, input.result, input.finishedAt, 'failed');
      jobs.set(failed.jobId, deepClone(failed));
      return deepClone(failed);
    },
  };
}

export function createPostgresWarmupJobStore(client: PostgresQueryClient): WarmupJobStore {
  return {
    async createWarmupJob(input) {
      const { rows } = await client.query<WarmupJobRow>(
        `with new_job as (
          select gen_random_uuid() as id
        )
        insert into warmup_jobs (
          id, tenant_key, source_kind, source_id, base_token, table_id,
          mode, trigger_type, status, stage, request_json, accepted_response_json,
          review_start_date, review_end_date, created_at, updated_at
        )
        select
          new_job.id, $1, $2, $3, $4, $5,
          $6, $7, 'queued', 'queued', $8::jsonb, jsonb_set($9::jsonb, '{jobId}', to_jsonb(new_job.id::text), true),
          $10, $11, $12, $12
        from new_job
        returning *`,
        [
          input.sourceKey.tenantKey,
          input.sourceKey.sourceKind,
          input.sourceKey.sourceId,
          input.sourceKey.baseToken ?? null,
          input.sourceKey.tableId ?? null,
          input.mode,
          input.triggerType,
          JSON.stringify(input.request),
          JSON.stringify(input.acceptedResponse),
          input.request.startDate ?? null,
          input.request.endDate ?? null,
          input.createdAt,
        ],
      );
      return warmupJobFromRow(requireSingleRow(rows, 'created warmup job missing'), input.sourceKey);
    },

    async getWarmupJob(jobId) {
      const { rows } = await client.query<WarmupJobRow>('select * from warmup_jobs where id = $1 limit 1', [jobId]);
      return rows[0] ? warmupJobFromRow(rows[0]) : undefined;
    },

    async listReplayableWarmupJobs(limit) {
      const { rows } = await client.query<WarmupJobRow>(
        `select * from warmup_jobs
        where status in ('queued', 'running')
        order by created_at asc
        limit $1`,
        [limit],
      );
      return rows.map((row) => warmupJobFromRow(row));
    },

    async claimWarmupJob(jobId, startedAt) {
      const { rows } = await client.query<WarmupJobRow>(
        `update warmup_jobs
          set status = 'running', stage = 'read_reviews', started_at = $2, updated_at = $2
        where id = $1 and status in ('queued', 'running')
        returning *`,
        [jobId, startedAt],
      );
      return rows[0] ? warmupJobFromRow(rows[0]) : undefined;
    },

    async updateWarmupJob(job) {
      const { rows } = await client.query<WarmupJobRow>(
        `update warmup_jobs
          set status = $2, stage = $3, request_json = $4::jsonb, accepted_response_json = $5::jsonb,
            result_json = $6::jsonb, records_scanned = $7,
            evidence_cache_hits = $8, evidence_cache_misses = $9,
            evidence_cache_inserts = $10, evidence_cache_updates = $11,
            topic_mapping_cache_hits = $12, topic_mapping_cache_misses = $13,
            topic_mapping_cache_inserts = $14, topic_mapping_cache_updates = $15,
            error_stage = $16, error_message = $17,
            started_at = $18, finished_at = $19, duration_ms = $20, updated_at = $21
        where id = $1
        returning *`,
        [
          job.jobId,
          job.status,
          job.stage,
          JSON.stringify(job.request),
          JSON.stringify(job.acceptedResponse),
          JSON.stringify(job.result),
          job.recordsScanned,
          job.evidenceCacheHits,
          job.evidenceCacheMisses,
          job.evidenceCacheInserts,
          job.evidenceCacheUpdates,
          job.topicMappingCacheHits,
          job.topicMappingCacheMisses,
          job.topicMappingCacheInserts,
          job.topicMappingCacheUpdates,
          job.errorStage ?? null,
          job.errorMessage ?? null,
          job.startedAt ?? null,
          job.finishedAt ?? null,
          job.durationMs ?? computeDurationMs(job.startedAt, job.finishedAt) ?? null,
          job.updatedAt,
        ],
      );
      return warmupJobFromRow(requireSingleRow(rows, `warmup job ${job.jobId} not found`), job.sourceKey);
    },

    async completeWarmupJob(input) {
      const completed = finalizeWarmupJob(input.job, input.result, input.finishedAt, 'success');
      return this.updateWarmupJob(completed);
    },

    async failWarmupJob(input) {
      const failed = finalizeWarmupJob(input.job, input.result, input.finishedAt, 'failed');
      return this.updateWarmupJob(failed);
    },
  };
}

function createQueuedWarmupJob(jobId: string, input: WarmupJobCreateInput): WarmupJob {
  return {
    jobId,
    sourceKey: deepClone(input.sourceKey),
    tenantKey: input.sourceKey.tenantKey,
    sourceKind: input.sourceKey.sourceKind,
    sourceId: input.sourceKey.sourceId,
    baseToken: input.sourceKey.baseToken,
    tableId: input.sourceKey.tableId,
    mode: input.mode,
    triggerType: input.triggerType,
    status: 'queued',
    stage: 'queued',
    request: deepClone(input.request),
    acceptedResponse: withAcceptedJobId(input.acceptedResponse, jobId),
    result: {},
    reviewStartDate: input.request.startDate,
    reviewEndDate: input.request.endDate,
    recordsScanned: 0,
    evidenceCacheHits: 0,
    evidenceCacheMisses: 0,
    evidenceCacheInserts: 0,
    evidenceCacheUpdates: 0,
    topicMappingCacheHits: 0,
    topicMappingCacheMisses: 0,
    topicMappingCacheInserts: 0,
    topicMappingCacheUpdates: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

function finalizeWarmupJob(
  job: WarmupJob,
  result: WarmupResponse,
  finishedAt: string,
  status: Extract<WarmupJobStatus, 'success' | 'failed'>,
): WarmupJob {
  const firstError = result.errors[0];
  return {
    ...job,
    status,
    stage: status === 'success' ? 'success' : firstError?.stage ?? 'failed',
    result: deepClone(result),
    recordsScanned: result.summary.recordsScanned ?? result.summary.totalReviews,
    evidenceCacheHits: result.summary.evidenceCacheHits,
    evidenceCacheMisses: result.summary.evidenceCacheMisses,
    evidenceCacheInserts: result.summary.evidenceCacheInserts ?? 0,
    evidenceCacheUpdates: result.summary.evidenceCacheUpdates ?? 0,
    topicMappingCacheHits: result.summary.topicMappingHits,
    topicMappingCacheMisses: result.summary.topicMappingMisses,
    topicMappingCacheInserts: result.summary.topicMappingCacheInserts ?? 0,
    topicMappingCacheUpdates: result.summary.topicMappingCacheUpdates ?? 0,
    errorStage: firstError?.stage,
    errorMessage: firstError?.message,
    finishedAt,
    durationMs: computeDurationMs(job.startedAt, finishedAt),
    updatedAt: finishedAt,
  };
}

function withAcceptedJobId(response: WarmupResponse, jobId: string): WarmupResponse {
  return {
    ...deepClone(response),
    jobId,
  };
}

function computeDurationMs(startedAt: string | undefined, finishedAt: string | undefined): number | undefined {
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

type WarmupJobRow = {
  id: string;
  tenant_key: string;
  source_kind: ReviewSyncSourceKey['sourceKind'];
  source_id: string;
  base_token: string | null;
  table_id: string | null;
  mode: WarmupMode;
  trigger_type: WarmupTriggerType;
  status: WarmupJobStatus;
  stage: WarmupJob['stage'];
  request_json: WarmupRequest | string;
  accepted_response_json: WarmupResponse | string;
  result_json: WarmupResponse | Record<string, never> | string;
  review_start_date: string | null;
  review_end_date: string | null;
  records_scanned: number;
  evidence_cache_hits: number;
  evidence_cache_misses: number;
  evidence_cache_inserts: number;
  evidence_cache_updates: number;
  topic_mapping_cache_hits: number;
  topic_mapping_cache_misses: number;
  topic_mapping_cache_inserts: number;
  topic_mapping_cache_updates: number;
  error_stage: WarmupStage | null;
  error_message: string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_ms: number | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function warmupJobFromRow(row: WarmupJobRow, sourceKey?: ReviewSyncSourceKey): WarmupJob {
  const resolvedSourceKey = sourceKey ?? {
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    baseToken: row.base_token ?? undefined,
    tableId: row.table_id ?? undefined,
    fieldMapping: readFieldMapping(row.request_json),
  };
  return {
    jobId: row.id,
    sourceKey: resolvedSourceKey,
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    baseToken: row.base_token ?? undefined,
    tableId: row.table_id ?? undefined,
    mode: row.mode,
    triggerType: row.trigger_type,
    status: row.status,
    stage: row.stage,
    request: parseJson(row.request_json) as WarmupRequest,
    acceptedResponse: parseJson(row.accepted_response_json) as WarmupResponse,
    result: parseJson(row.result_json) as WarmupResponse | Record<string, never>,
    reviewStartDate: row.review_start_date ?? undefined,
    reviewEndDate: row.review_end_date ?? undefined,
    recordsScanned: row.records_scanned,
    evidenceCacheHits: row.evidence_cache_hits,
    evidenceCacheMisses: row.evidence_cache_misses,
    evidenceCacheInserts: row.evidence_cache_inserts,
    evidenceCacheUpdates: row.evidence_cache_updates,
    topicMappingCacheHits: row.topic_mapping_cache_hits,
    topicMappingCacheMisses: row.topic_mapping_cache_misses,
    topicMappingCacheInserts: row.topic_mapping_cache_inserts,
    topicMappingCacheUpdates: row.topic_mapping_cache_updates,
    errorStage: row.error_stage ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
    durationMs: row.duration_ms ?? undefined,
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
}

function readFieldMapping(rawRequest: WarmupRequest | string): Record<string, string> {
  const request = parseJson(rawRequest) as WarmupRequest;
  return request.fieldMapping ?? {};
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function toIsoString(value: Date | string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(value).toISOString();
}

function requireSingleRow<T>(rows: T[], message: string): T {
  if (!rows.length) {
    throw new Error(message);
  }
  return rows[0];
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : deepClone(value);
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}
