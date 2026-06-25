import { createHash } from 'node:crypto';
import type { BackendAnalysisSourceKind, SourceVersion } from './backendAnalysis';
import type { ReviewRecord } from './reviewSource';
import { computeDurationMs, type ReviewSyncMode, type ReviewSyncSourceKey, type ReviewSyncTriggerType } from './reviewSync';

export type ReviewSyncStage =
  | 'queued'
  | 'read_source'
  | 'write_records'
  | 'write_source_version'
  | 'success'
  | 'failed';

export type ReviewSyncJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export type ReviewSyncJob = {
  jobId: string;
  sourceKey: ReviewSyncSourceKey;
  tenantKey: string;
  sourceKind: BackendAnalysisSourceKind;
  sourceId: string;
  mode: ReviewSyncMode;
  triggerType: ReviewSyncTriggerType;
  status: ReviewSyncJobStatus;
  stage: ReviewSyncStage;
  recordsRead: number;
  recordsUpserted: number;
  recordsDeleted: number;
  recordsUnchanged: number;
  errorStage?: ReviewSyncStage;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredReviewRecord = {
  tenantKey: string;
  sourceKind: BackendAnalysisSourceKind;
  sourceId: string;
  sourceKeyHash: string;
  baseToken?: string;
  tableId?: string;
  recordId: string;
  fields: Record<string, unknown>;
  parsedReview: Record<string, unknown>;
  content?: string;
  contentHash: string;
  sourceUpdatedAt?: string;
  syncedAt: string;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ReviewSyncStore = {
  createSyncJob(input: {
    sourceKey: ReviewSyncSourceKey;
    mode: ReviewSyncMode;
    triggerType: ReviewSyncTriggerType;
    createdAt: string;
  }): Promise<ReviewSyncJob>;
  getSyncJob(jobId: string): Promise<ReviewSyncJob | undefined>;
  listReplayableSyncJobs(limit: number): Promise<ReviewSyncJob[]>;
  claimSyncJob(jobId: string, startedAt: string): Promise<ReviewSyncJob | undefined>;
  updateSyncJob(job: ReviewSyncJob): Promise<ReviewSyncJob>;
  upsertReviewRecords(input: {
    sourceKey: ReviewSyncSourceKey;
    reviews: ReviewRecord[];
    syncedAt: string;
  }): Promise<number>;
  softDeleteMissingRecords(input: {
    sourceKey: ReviewSyncSourceKey;
    activeRecordIds: string[];
    syncedAt: string;
  }): Promise<number>;
  softDeleteReviewRecord(input: {
    sourceKey: ReviewSyncSourceKey;
    recordId: string;
    syncedAt: string;
  }): Promise<boolean>;
  getReviewRecord(sourceKey: ReviewSyncSourceKey, recordId: string): Promise<StoredReviewRecord | undefined>;
  listReviewRecords(sourceKey: ReviewSyncSourceKey): Promise<StoredReviewRecord[]>;
  saveSourceVersion(sourceKey: ReviewSyncSourceKey, sourceVersion: SourceVersion): Promise<SourceVersion>;
  getLatestSourceVersion(sourceKey: ReviewSyncSourceKey): Promise<SourceVersion | undefined>;
  completeSyncJob(input: {
    job: ReviewSyncJob;
    sourceKey: ReviewSyncSourceKey;
    reviews: ReviewRecord[];
    activeRecordIds?: string[];
    recordsRead?: number;
    recordsUnchanged?: number;
    sourceVersion: SourceVersion;
    syncedAt: string;
  }): Promise<ReviewSyncJob>;
};

export type PostgresQueryClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  connect?: () => Promise<PostgresQueryClient & { release: () => void }>;
};

export function createInMemoryReviewSyncStore(): ReviewSyncStore {
  const jobs = new Map<string, ReviewSyncJob>();
  const records = new Map<string, StoredReviewRecord>();
  const versionsBySource = new Map<string, SourceVersion[]>();
  let jobSequence = 1;

  return {
    async createSyncJob(input) {
      const activeJob = findActiveJob(jobs, input.sourceKey, input.mode);
      if (activeJob) {
        return deepClone(activeJob);
      }
      const job: ReviewSyncJob = {
        jobId: `sync-job-${jobSequence++}`,
        sourceKey: deepClone(input.sourceKey),
        tenantKey: input.sourceKey.tenantKey,
        sourceKind: input.sourceKey.sourceKind,
        sourceId: input.sourceKey.sourceId,
        mode: input.mode,
        triggerType: input.triggerType,
        status: 'queued',
        stage: 'queued',
        recordsRead: 0,
        recordsUpserted: 0,
        recordsDeleted: 0,
        recordsUnchanged: 0,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      };
      jobs.set(job.jobId, deepClone(job));
      return deepClone(job);
    },

    async getSyncJob(jobId) {
      return cloneOrUndefined(jobs.get(jobId));
    },

    async listReplayableSyncJobs(limit) {
      return Array.from(jobs.values())
        .filter((job) => job.status === 'queued' || job.status === 'running')
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, limit)
        .map((job) => deepClone(job));
    },

    async claimSyncJob(jobId, startedAt) {
      const job = jobs.get(jobId);
      if (!job || (job.status !== 'queued' && job.status !== 'running')) {
        return undefined;
      }
      const claimed: ReviewSyncJob = {
        ...job,
        status: 'running',
        stage: 'read_source',
        startedAt,
        updatedAt: startedAt,
      };
      jobs.set(jobId, deepClone(claimed));
      return deepClone(claimed);
    },

    async updateSyncJob(job) {
      jobs.set(job.jobId, deepClone(job));
      return deepClone(job);
    },

    async upsertReviewRecords(input) {
      for (const review of input.reviews) {
        const key = makeRecordKey(input.sourceKey, review.recordId);
        const existing = records.get(key);
        const stored: StoredReviewRecord = {
          tenantKey: input.sourceKey.tenantKey,
          sourceKind: input.sourceKey.sourceKind,
          sourceId: input.sourceKey.sourceId,
          sourceKeyHash: makeSourceKeyHash(input.sourceKey),
          baseToken: input.sourceKey.baseToken,
          tableId: input.sourceKey.tableId,
          recordId: review.recordId,
          fields: deepClone(review.fields),
          parsedReview: deepClone(review.mappedFields),
          content: review.content ?? resolveContentFromParsedReview(review.mappedFields),
          contentHash: review.contentHash,
          sourceUpdatedAt: input.syncedAt,
          syncedAt: input.syncedAt,
          isDeleted: false,
          createdAt: existing?.createdAt ?? input.syncedAt,
          updatedAt: input.syncedAt,
        };
        records.set(key, stored);
      }
      return input.reviews.length;
    },

    async softDeleteMissingRecords(input) {
      const activeIds = new Set(input.activeRecordIds);
      let deleted = 0;
      for (const [key, record] of records.entries()) {
        if (!matchesSource(record, input.sourceKey) || record.isDeleted || activeIds.has(record.recordId)) {
          continue;
        }
        records.set(key, {
          ...record,
          isDeleted: true,
          syncedAt: input.syncedAt,
          updatedAt: input.syncedAt,
        });
        deleted += 1;
      }
      return deleted;
    },

    async softDeleteReviewRecord(input) {
      const key = makeRecordKey(input.sourceKey, input.recordId);
      const record = records.get(key);
      if (!record) {
        return false;
      }
      records.set(key, {
        ...record,
        isDeleted: true,
        syncedAt: input.syncedAt,
        updatedAt: input.syncedAt,
      });
      return true;
    },

    async getReviewRecord(sourceKey, recordId) {
      return cloneOrUndefined(records.get(makeRecordKey(sourceKey, recordId)));
    },

    async listReviewRecords(sourceKey) {
      return Array.from(records.values())
        .filter((record) => matchesSource(record, sourceKey) && !record.isDeleted)
        .sort((left, right) => left.recordId.localeCompare(right.recordId))
        .map((record) => deepClone(record));
    },

    async saveSourceVersion(sourceKey, sourceVersion) {
      const key = makeSourceKey(sourceKey);
      const versions = versionsBySource.get(key) ?? [];
      const withoutSameVersion = versions.filter((version) => version.version !== sourceVersion.version);
      const nextVersions = [...withoutSameVersion, deepClone(sourceVersion)].sort((left, right) =>
        left.generatedAt.localeCompare(right.generatedAt),
      );
      versionsBySource.set(key, nextVersions);
      return deepClone(sourceVersion);
    },

    async getLatestSourceVersion(sourceKey) {
      const versions = versionsBySource.get(makeSourceKey(sourceKey)) ?? [];
      return cloneOrUndefined(versions[versions.length - 1]);
    },

    async completeSyncJob(input) {
      const recordsUpserted = await this.upsertReviewRecords({
        sourceKey: input.sourceKey,
        reviews: input.reviews,
        syncedAt: input.syncedAt,
      });
      const recordsDeleted = await this.softDeleteMissingRecords({
        sourceKey: input.sourceKey,
        activeRecordIds: input.activeRecordIds ?? input.reviews.map((review) => review.recordId),
        syncedAt: input.syncedAt,
      });
      await this.saveSourceVersion(input.sourceKey, input.sourceVersion);
      return this.updateSyncJob({
        ...input.job,
        status: 'success',
        stage: 'success',
        recordsRead: input.recordsRead ?? input.reviews.length,
        recordsUpserted,
        recordsDeleted,
        recordsUnchanged: input.recordsUnchanged ?? 0,
        finishedAt: input.syncedAt,
        durationMs: computeDurationMs(input.job.startedAt, input.syncedAt),
        updatedAt: input.syncedAt,
        errorStage: undefined,
        errorMessage: undefined,
      });
    },
  };
}

export function createPostgresReviewSyncStore(client: PostgresQueryClient): ReviewSyncStore {
  return {
    async createSyncJob(input) {
      const { rows } = await client.query<SyncJobRow>(
        `insert into sync_jobs (
          tenant_key, source_kind, source_id, base_token, table_id, view_id, field_mapping_json, source_key_hash,
          mode, trigger_type, status, stage,
          records_read, records_upserted, records_deleted, records_unchanged, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'queued', 'queued', 0, 0, 0, 0, $11, $11)
        on conflict (tenant_key, source_kind, source_id, mode)
          where status in ('queued', 'running')
        do update set updated_at = sync_jobs.updated_at
        returning *`,
        [
          input.sourceKey.tenantKey,
          input.sourceKey.sourceKind,
          input.sourceKey.sourceId,
          input.sourceKey.baseToken ?? null,
          input.sourceKey.tableId ?? null,
          input.sourceKey.viewId ?? null,
          JSON.stringify(input.sourceKey.fieldMapping),
          makeSourceKeyHash(input.sourceKey),
          input.mode,
          input.triggerType,
          input.createdAt,
        ],
      );
      return syncJobFromRow(requireSingleRow(rows, 'created sync job missing'));
    },

    async getSyncJob(jobId) {
      const { rows } = await client.query<SyncJobRow>('select * from sync_jobs where id = $1 limit 1', [jobId]);
      return rows[0] ? syncJobFromRow(rows[0]) : undefined;
    },

    async listReplayableSyncJobs(limit) {
      const { rows } = await client.query<SyncJobRow>(
        `select * from sync_jobs
        where status in ('queued', 'running')
        order by created_at asc
        limit $1`,
        [limit],
      );
      return rows.map(syncJobFromRow);
    },

    async claimSyncJob(jobId, startedAt) {
      const { rows } = await client.query<SyncJobRow>(
        `update sync_jobs
          set status = 'running', stage = 'read_source', started_at = $2, updated_at = $2
        where id = $1 and status in ('queued', 'running')
        returning *`,
        [jobId, startedAt],
      );
      return rows[0] ? syncJobFromRow(rows[0]) : undefined;
    },

    async updateSyncJob(job) {
      const { rows } = await client.query<SyncJobRow>(
        `update sync_jobs
          set status = $2, stage = $3, records_read = $4, records_upserted = $5,
            records_deleted = $6, records_unchanged = $7, error_stage = $8, error_message = $9,
            started_at = $10, finished_at = $11, duration_ms = $12, updated_at = $13
        where id = $1
        returning *`,
        [
          job.jobId,
          job.status,
          job.stage,
          job.recordsRead,
          job.recordsUpserted,
          job.recordsDeleted,
          job.recordsUnchanged,
          job.errorStage ?? null,
          job.errorMessage ?? null,
          job.startedAt ?? null,
          job.finishedAt ?? null,
          job.durationMs ?? computeDurationMs(job.startedAt, job.finishedAt) ?? null,
          job.updatedAt,
        ],
      );
      return syncJobFromRow(requireSingleRow(rows, `sync job ${job.jobId} not found`));
    },

    async upsertReviewRecords(input) {
      return upsertReviewRecordsWithClient(client, input);
    },

    async softDeleteMissingRecords(input) {
      return softDeleteMissingRecordsWithClient(client, input);
    },

    async softDeleteReviewRecord(input) {
      const { rows } = await client.query<{ id: string }>(
        `update review_records
          set is_deleted = true, synced_at = $5, updated_at = $5
        where tenant_key = $1 and source_kind = $2 and source_id = $3 and record_id = $4
        returning id`,
        [
          input.sourceKey.tenantKey,
          input.sourceKey.sourceKind,
          input.sourceKey.sourceId,
          input.recordId,
          input.syncedAt,
        ],
      );
      return rows.length > 0;
    },

    async getReviewRecord(sourceKey, recordId) {
      const { rows } = await client.query<ReviewRecordRow>(
        `select * from review_records
        where tenant_key = $1 and source_kind = $2 and source_id = $3 and record_id = $4
        limit 1`,
        [sourceKey.tenantKey, sourceKey.sourceKind, sourceKey.sourceId, recordId],
      );
      return rows[0] ? reviewRecordFromRow(rows[0]) : undefined;
    },

    async listReviewRecords(sourceKey) {
      const { rows } = await client.query<ReviewRecordRow>(
        `select * from review_records
        where tenant_key = $1 and source_kind = $2 and source_id = $3 and is_deleted = false
        order by record_id asc`,
        [sourceKey.tenantKey, sourceKey.sourceKind, sourceKey.sourceId],
      );
      return rows.map(reviewRecordFromRow);
    },

    async saveSourceVersion(sourceKey, sourceVersion) {
      return saveSourceVersionWithClient(client, sourceKey, sourceVersion);
    },

    async getLatestSourceVersion(sourceKey) {
      const { rows } = await client.query<SourceVersionRow>(
        `select * from review_source_versions
        where tenant_key = $1 and source_kind = $2 and source_id = $3
        order by generated_at desc, created_at desc
        limit 1`,
        [sourceKey.tenantKey, sourceKey.sourceKind, sourceKey.sourceId],
      );
      return rows[0] ? sourceVersionFromRow(rows[0]) : undefined;
    },

    async completeSyncJob(input) {
      return withTransaction(client, async (transactionClient) => {
        await upsertReviewRecordsWithClient(transactionClient, {
          sourceKey: input.sourceKey,
          reviews: input.reviews,
          syncedAt: input.syncedAt,
        });
        const recordsDeleted = await softDeleteMissingRecordsWithClient(transactionClient, {
          sourceKey: input.sourceKey,
          activeRecordIds: input.activeRecordIds ?? input.reviews.map((review) => review.recordId),
          syncedAt: input.syncedAt,
        });
        await saveSourceVersionWithClient(transactionClient, input.sourceKey, input.sourceVersion);
        const recordsUpserted = input.reviews.length;
        const { rows } = await transactionClient.query<SyncJobRow>(
          `update sync_jobs
            set status = 'success', stage = 'success', records_read = $2, records_upserted = $3,
              records_deleted = $4, records_unchanged = $5, error_stage = null, error_message = null,
              finished_at = $6, duration_ms = $7, updated_at = $6
          where id = $1
          returning *`,
          [
            input.job.jobId,
            input.recordsRead ?? input.reviews.length,
            recordsUpserted,
            recordsDeleted,
            input.recordsUnchanged ?? 0,
            input.syncedAt,
            computeDurationMs(input.job.startedAt, input.syncedAt) ?? null,
          ],
        );
        return syncJobFromRow(requireSingleRow(rows, `sync job ${input.job.jobId} not found`));
      });
    },
  };
}

type SyncJobRow = {
  id: string;
  tenant_key: string;
  source_kind: BackendAnalysisSourceKind;
  source_id: string;
  base_token?: string | null;
  table_id?: string | null;
  view_id?: string | null;
  field_mapping_json?: Record<string, string> | string | null;
  source_key_hash?: string | null;
  mode?: ReviewSyncMode | null;
  trigger_type: ReviewSyncTriggerType;
  status: ReviewSyncJobStatus;
  stage: ReviewSyncStage;
  records_read: number;
  records_upserted: number;
  records_deleted: number;
  records_unchanged?: number | null;
  error_stage?: ReviewSyncStage | null;
  error_message?: string | null;
  started_at?: string | Date | null;
  finished_at?: string | Date | null;
  duration_ms?: number | string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ReviewRecordRow = {
  tenant_key: string;
  source_kind: BackendAnalysisSourceKind;
  source_id: string;
  source_key_hash?: string | null;
  base_token?: string | null;
  table_id?: string | null;
  record_id: string;
  fields_json: Record<string, unknown>;
  parsed_review_json: Record<string, unknown>;
  content_hash: string;
  source_updated_at?: string | Date | null;
  synced_at: string | Date;
  is_deleted: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

type SourceVersionRow = {
  source_kind: BackendAnalysisSourceKind;
  source_id: string;
  source_key_hash?: string | null;
  version: string;
  record_count: number;
  content_hash: string;
  generated_at: string | Date;
};

function syncJobFromRow(row: SyncJobRow): ReviewSyncJob {
  const sourceKey: ReviewSyncSourceKey = {
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    baseToken: row.base_token ?? undefined,
    tableId: row.table_id ?? undefined,
    viewId: row.view_id ?? undefined,
    fieldMapping: normalizeFieldMapping(row.field_mapping_json),
  };
  return {
    jobId: row.id,
    sourceKey,
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    mode: row.mode ?? 'full',
    triggerType: row.trigger_type,
    status: row.status,
    stage: row.stage,
    recordsRead: Number(row.records_read),
    recordsUpserted: Number(row.records_upserted),
    recordsDeleted: Number(row.records_deleted),
    recordsUnchanged: Number(row.records_unchanged ?? 0),
    errorStage: row.error_stage ?? undefined,
    errorMessage: row.error_message ?? undefined,
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function reviewRecordFromRow(row: ReviewRecordRow): StoredReviewRecord {
  return {
    tenantKey: row.tenant_key,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceKeyHash: row.source_key_hash ?? makeDefaultSourceKeyHash(),
    baseToken: row.base_token ?? undefined,
    tableId: row.table_id ?? undefined,
    recordId: row.record_id,
    fields: row.fields_json,
    parsedReview: row.parsed_review_json,
    content: resolveContentFromParsedReview(row.parsed_review_json),
    contentHash: row.content_hash,
    sourceUpdatedAt: row.source_updated_at ? toIsoString(row.source_updated_at) : undefined,
    syncedAt: toIsoString(row.synced_at),
    isDeleted: row.is_deleted,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function upsertReviewRecordsWithClient(
  client: PostgresQueryClient,
  input: {
    sourceKey: ReviewSyncSourceKey;
    reviews: ReviewRecord[];
    syncedAt: string;
  },
): Promise<number> {
  for (const review of input.reviews) {
    await client.query(
      `insert into review_records (
        tenant_key, source_kind, source_id, source_key_hash, base_token, table_id, record_id,
        fields_json, parsed_review_json, content_hash, source_updated_at,
        synced_at, is_deleted, created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $11, false, $11, $11)
      on conflict (tenant_key, source_kind, source_id, record_id)
      do update set
        source_key_hash = excluded.source_key_hash,
        base_token = excluded.base_token,
        table_id = excluded.table_id,
        fields_json = excluded.fields_json,
        parsed_review_json = excluded.parsed_review_json,
        content_hash = excluded.content_hash,
        source_updated_at = excluded.source_updated_at,
        synced_at = excluded.synced_at,
        is_deleted = false,
        updated_at = excluded.updated_at`,
      [
        input.sourceKey.tenantKey,
        input.sourceKey.sourceKind,
        input.sourceKey.sourceId,
        makeSourceKeyHash(input.sourceKey),
        input.sourceKey.baseToken ?? null,
        input.sourceKey.tableId ?? null,
        review.recordId,
        JSON.stringify(review.fields),
        JSON.stringify(review.mappedFields),
        review.contentHash,
        input.syncedAt,
      ],
    );
  }
  return input.reviews.length;
}

async function softDeleteMissingRecordsWithClient(
  client: PostgresQueryClient,
  input: {
    sourceKey: ReviewSyncSourceKey;
    activeRecordIds: string[];
    syncedAt: string;
  },
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `with updated as (
      update review_records
        set is_deleted = true, synced_at = $4, updated_at = $4
      where tenant_key = $1
        and source_kind = $2
        and source_id = $3
        and is_deleted = false
        and not (record_id = any($5::text[]))
      returning id
    )
    select count(*)::text as count from updated`,
    [
      input.sourceKey.tenantKey,
      input.sourceKey.sourceKind,
      input.sourceKey.sourceId,
      input.syncedAt,
      input.activeRecordIds,
    ],
  );
  return Number(rows[0]?.count ?? 0);
}

async function saveSourceVersionWithClient(
  client: PostgresQueryClient,
  sourceKey: ReviewSyncSourceKey,
  sourceVersion: SourceVersion,
): Promise<SourceVersion> {
  const { rows } = await client.query<SourceVersionRow>(
    `insert into review_source_versions (
      tenant_key, source_kind, source_id, source_key_hash, version, record_count, content_hash, generated_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8)
    on conflict (tenant_key, source_kind, source_id, version)
    do update set
      source_key_hash = excluded.source_key_hash,
      record_count = excluded.record_count,
      content_hash = excluded.content_hash,
      generated_at = excluded.generated_at
    returning *`,
    [
      sourceKey.tenantKey,
      sourceKey.sourceKind,
      sourceKey.sourceId,
      makeSourceKeyHash(sourceKey),
      sourceVersion.version,
      sourceVersion.recordCount,
      sourceVersion.contentHash,
      sourceVersion.generatedAt,
    ],
  );
  return sourceVersionFromRow(requireSingleRow(rows, 'saved source version missing'));
}

async function withTransaction<T>(client: PostgresQueryClient, run: (transactionClient: PostgresQueryClient) => Promise<T>): Promise<T> {
  const transactionClient = client.connect ? await client.connect() : client;
  try {
    await transactionClient.query('BEGIN');
    const result = await run(transactionClient);
    await transactionClient.query('COMMIT');
    return result;
  } catch (cause) {
    await transactionClient.query('ROLLBACK');
    throw cause;
  } finally {
    if ('release' in transactionClient && typeof transactionClient.release === 'function') {
      transactionClient.release();
    }
  }
}

function findActiveJob(
  jobs: Map<string, ReviewSyncJob>,
  sourceKey: ReviewSyncSourceKey,
  mode: ReviewSyncMode,
): ReviewSyncJob | undefined {
  return Array.from(jobs.values()).find(
    (job) =>
      (job.status === 'queued' || job.status === 'running') &&
      job.mode === mode &&
      makeActiveJobIdentity(job.sourceKey, job.mode) === makeActiveJobIdentity(sourceKey, mode),
  );
}

function resolveContentFromParsedReview(parsedReview: Record<string, unknown>): string | undefined {
  if (typeof parsedReview.content === 'string') {
    return parsedReview.content;
  }
  return typeof parsedReview.reviewText === 'string' ? parsedReview.reviewText : undefined;
}

function normalizeFieldMapping(value: Record<string, string> | string | null | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  if (typeof value === 'string') {
    return normalizeFieldMappingObject(JSON.parse(value) as unknown);
  }
  return normalizeFieldMappingObject(value);
}

function normalizeFieldMappingObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function sourceVersionFromRow(row: SourceVersionRow): SourceVersion {
  return {
    kind: row.source_kind,
    sourceId: row.source_id,
    version: row.version,
    contentHash: row.content_hash,
    recordCount: Number(row.record_count),
    generatedAt: toIsoString(row.generated_at),
  };
}

function makeSourceKey(sourceKey: Pick<ReviewSyncSourceKey, 'tenantKey' | 'sourceKind' | 'sourceId'>): string {
  return `${sourceKey.tenantKey}:${sourceKey.sourceKind}:${sourceKey.sourceId}`;
}

function makeActiveJobIdentity(sourceKey: ReviewSyncSourceKey, mode: ReviewSyncMode): string {
  return `${makeSourceKey(sourceKey)}:${mode}`;
}

function makeSourceKeyHash(sourceKey: Pick<ReviewSyncSourceKey, 'fieldMapping'>): string {
  return createHash('sha256').update(stableFieldMappingJson(sourceKey.fieldMapping)).digest('hex');
}

function makeDefaultSourceKeyHash(): string {
  return makeSourceKeyHash({ fieldMapping: {} });
}

function stableFieldMappingJson(fieldMapping: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(fieldMapping)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, string>>((result, [key, value]) => {
        result[key] = value;
        return result;
      }, {}),
  );
}

function makeRecordKey(sourceKey: ReviewSyncSourceKey, recordId: string): string {
  return `${makeSourceKey(sourceKey)}:${recordId}`;
}

function matchesSource(record: StoredReviewRecord, sourceKey: ReviewSyncSourceKey): boolean {
  return (
    record.tenantKey === sourceKey.tenantKey &&
    record.sourceKind === sourceKey.sourceKind &&
    record.sourceId === sourceKey.sourceId
  );
}

function requireSingleRow<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(message);
  }
  return row;
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : deepClone(value);
}
