import {
  type AnalysisBackendStore,
  type AnalysisJob,
  type AnalysisJobStatus,
  type AnalysisResult,
  type AnalysisStage,
  type BackendAnalysisConfig,
  type BackendAnalysisConfigUpsertRequest,
  type BackendAnalysisSourceDescriptor,
  type JsonValue,
  type SourceVersion,
  type TopicEvidence,
} from './backendAnalysis';
import type { PostgresQueryClient } from './postgresReviewSyncStore';

export function createPostgresAnalysisBackendStore(client: PostgresQueryClient): AnalysisBackendStore {
  return {
    async upsertConfig(input) {
      const { rows } = await client.query<AnalysisConfigRow>(
        `insert into analysis_configs (
          tenant_key, plugin_instance_id, created_by_base_user_id, source_kind,
          source_ref_json, field_mapping_json, filters_json, dashboard_data_conditions_json, ai_profile_id
        ) values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9)
        on conflict (tenant_key, plugin_instance_id, created_by_base_user_id)
        do update set
          source_kind = excluded.source_kind,
          source_ref_json = excluded.source_ref_json,
          field_mapping_json = excluded.field_mapping_json,
          filters_json = excluded.filters_json,
          dashboard_data_conditions_json = excluded.dashboard_data_conditions_json,
          ai_profile_id = excluded.ai_profile_id,
          config_version = analysis_configs.config_version + 1,
          updated_at = now()
        returning *`,
        [
          input.tenantKey,
          input.pluginInstanceId,
          input.baseUserId,
          input.source.kind,
          JSON.stringify(sourceRefJson(input)),
          JSON.stringify(input.source.fieldMapping),
          JSON.stringify(input.filters ?? null),
          JSON.stringify(input.dashboardDataConditions ?? null),
          input.model ?? null,
        ],
      );
      return analysisConfigFromRow(requireSingleRow(rows, 'saved analysis config missing'));
    },

    async getConfig(configId) {
      const { rows } = await client.query<AnalysisConfigRow>('select * from analysis_configs where id = $1 limit 1', [configId]);
      return rows[0] ? analysisConfigFromRow(rows[0]) : undefined;
    },

    async findActiveJob(input) {
      const { rows } = await client.query<AnalysisJobRow>(
        `select * from analysis_jobs
        where tenant_key = $1 and base_user_id = $2 and plugin_instance_id = $3 and scope_key = $4
          and status in ('queued', 'running')
        order by created_at desc
        limit 1`,
        [input.tenantKey, input.baseUserId, input.pluginInstanceId, input.scopeKey],
      );
      return rows[0] ? analysisJobFromRow(rows[0]) : undefined;
    },

    async getLatestJob(input) {
      const { rows } = await client.query<AnalysisJobRow>(
        `select * from analysis_jobs
        where tenant_key = $1 and base_user_id = $2 and plugin_instance_id = $3 and scope_key = $4
        order by updated_at desc, created_at desc
        limit 1`,
        [input.tenantKey, input.baseUserId, input.pluginInstanceId, input.scopeKey],
      );
      return rows[0] ? analysisJobFromRow(rows[0]) : undefined;
    },

    async createJob(input) {
      const { rows } = await client.query<AnalysisJobRow>(
        `insert into analysis_jobs (
          tenant_key, base_user_id, plugin_instance_id, config_id, config_version, scope_key,
          status, stage, progress_json, started_at, finished_at, error_stage, error_message, result_id
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
        returning *`,
        [
          input.tenantKey,
          input.baseUserId,
          input.pluginInstanceId,
          input.configId,
          input.configVersion,
          input.scopeKey,
          input.status,
          input.stage,
          JSON.stringify({ value: input.progress }),
          input.startedAt ?? null,
          input.finishedAt ?? null,
          input.errorStage ?? null,
          input.errorMessage ?? null,
          input.resultId ?? null,
        ],
      );
      return analysisJobFromRow(requireSingleRow(rows, 'created analysis job missing'));
    },

    async createOrGetActiveJob(input) {
      const existing = await this.findActiveJob(input);
      if (existing) {
        return { job: existing, created: false };
      }
      const job = await this.createJob(input);
      return { job, created: true };
    },

    async claimJob(jobId, startedAt) {
      const { rows } = await client.query<AnalysisJobRow>(
        `update analysis_jobs
          set status = 'running', stage = 'load_config', progress_json = $2::jsonb, started_at = $3, updated_at = $3
        where id = $1 and status = 'queued'
        returning *`,
        [jobId, JSON.stringify({ value: 5 }), startedAt],
      );
      return rows[0] ? analysisJobFromRow(rows[0]) : undefined;
    },

    async updateJobScopeIfNoActiveConflict(input) {
      return withTransaction(client, async (transactionClient) => {
        const { rows: jobRows } = await transactionClient.query<AnalysisJobRow>('select * from analysis_jobs where id = $1 for update', [input.jobId]);
        const job = jobRows[0] ? analysisJobFromRow(jobRows[0]) : undefined;
        if (!job || job.status !== 'running') {
          return undefined;
        }
        const { rows: conflictRows } = await transactionClient.query<AnalysisJobRow>(
          `select * from analysis_jobs
          where tenant_key = $1 and base_user_id = $2 and plugin_instance_id = $3 and scope_key = $4
            and status in ('queued', 'running') and id <> $5
          limit 1`,
          [job.tenantKey, job.baseUserId, job.pluginInstanceId, input.scopeKey, input.jobId],
        );
        if (conflictRows[0]) {
          return undefined;
        }
        const { rows: updatedRows } = await transactionClient.query<AnalysisJobRow>(
          `update analysis_jobs set scope_key = $2, updated_at = now() where id = $1 returning *`,
          [input.jobId, input.scopeKey],
        );
        return updatedRows[0] ? analysisJobFromRow(updatedRows[0]) : undefined;
      });
    },

    async getJob(jobId) {
      const { rows } = await client.query<AnalysisJobRow>('select * from analysis_jobs where id = $1 limit 1', [jobId]);
      return rows[0] ? analysisJobFromRow(rows[0]) : undefined;
    },

    async updateJob(job) {
      const { rows } = await client.query<AnalysisJobRow>(
        `update analysis_jobs
          set scope_key = $2, status = $3, stage = $4, progress_json = $5::jsonb,
            config_version = $6, error_stage = $7, error_message = $8, started_at = $9,
            finished_at = $10, result_id = $11, updated_at = now()
        where id = $1
        returning *`,
        [
          job.jobId,
          job.scopeKey,
          job.status,
          job.stage,
          JSON.stringify({ value: job.progress }),
          job.configVersion,
          job.errorStage ?? null,
          job.errorMessage ?? null,
          job.startedAt ?? null,
          job.finishedAt ?? null,
          job.resultId ?? null,
        ],
      );
      return analysisJobFromRow(requireSingleRow(rows, `analysis job ${job.jobId} not found`));
    },

    async saveResult(input) {
      const result = await withTransaction(client, async (transactionClient) => {
        const sourceVersionId = await ensureSourceVersion(transactionClient, input);
        const cacheDiagnostics = readCacheDiagnostics(input.summary);
        const { rows } = await transactionClient.query<AnalysisResultRow>(
          `insert into analysis_results (
            tenant_key, base_user_id, plugin_instance_id, config_id, config_version, job_id, scope_key,
            source_version_id, model, pipeline_version, result_json, summary_json,
            evidence_cache_requested, evidence_cache_hits, evidence_cache_misses, evidence_cache_hit_rate,
            topic_mapping_cache_requested, topic_mapping_cache_hits, topic_mapping_cache_misses,
            topic_mapping_cache_hit_rate, ai_called, ai_evidence_extraction_called, ai_topic_mapping_called,
            generated_at
          ) values (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
            $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
          )
          returning *`,
          [
            input.tenantKey,
            input.baseUserId,
            input.pluginInstanceId,
            input.configId,
            input.configVersion,
            input.jobId,
            input.scopeKey,
            sourceVersionId,
            resolveModelFromSummary(input.summary),
            input.pipelineVersion,
            JSON.stringify({ topics: input.topics, sourceVersion: input.sourceVersion }),
            JSON.stringify(input.summary),
            cacheDiagnostics.evidenceCache.requested,
            cacheDiagnostics.evidenceCache.hits,
            cacheDiagnostics.evidenceCache.misses,
            cacheDiagnostics.evidenceCache.hitRate,
            cacheDiagnostics.topicMappingCache.requested,
            cacheDiagnostics.topicMappingCache.hits,
            cacheDiagnostics.topicMappingCache.misses,
            cacheDiagnostics.topicMappingCache.hitRate,
            cacheDiagnostics.aiCalled,
            cacheDiagnostics.aiTriggered.evidenceExtraction,
            cacheDiagnostics.aiTriggered.topicMapping,
            input.sourceVersion.generatedAt,
          ],
        );
        return analysisResultFromRow(requireSingleRow(rows, 'created analysis result missing'), input.sourceVersion);
      });
      return result;
    },

    async finalizeSuccessfulJob(input) {
      const result = await this.getPublishedResult(input.resultId) ?? await getAnyResult(client, input.resultId);
      if (!result || result.jobId !== input.jobId) {
        return undefined;
      }
      const { rows } = await client.query<AnalysisJobRow>(
        `update analysis_jobs
          set status = 'success', stage = 'save_result', progress_json = $3::jsonb,
            finished_at = $4, result_id = $2, error_stage = null, error_message = null, updated_at = $4
        where id = $1 and status = 'running'
        returning *`,
        [input.jobId, input.resultId, JSON.stringify({ value: 100, resultId: input.resultId }), result.createdAt],
      );
      return rows[0] ? { ...analysisJobFromRow(rows[0]), resultId: input.resultId } : undefined;
    },

    async getPublishedResult(resultId) {
      const { rows } = await client.query<AnalysisResultJoinedRow>(
        `select result.*, version.source_kind, version.source_id, version.version, version.content_hash, version.record_count, version.generated_at as source_generated_at
        from analysis_results result
        join analysis_jobs job on job.id = result.job_id
        left join review_source_versions version on version.id = result.source_version_id
        where result.id = $1 and job.status = 'success'
        limit 1`,
        [resultId],
      );
      return rows[0] ? analysisResultFromJoinedRow(rows[0]) : undefined;
    },

    async getLatestResult(input) {
      const { rows } = await client.query<AnalysisResultJoinedRow>(
        `select result.*, version.source_kind, version.source_id, version.version, version.content_hash, version.record_count, version.generated_at as source_generated_at
        from analysis_results result
        join analysis_jobs job on job.id = result.job_id
        left join review_source_versions version on version.id = result.source_version_id
        where result.tenant_key = $1 and result.base_user_id = $2 and result.plugin_instance_id = $3 and result.scope_key = $4
          and job.status = 'success'
        order by result.generated_at desc, result.created_at desc
        limit 1`,
        [input.tenantKey, input.baseUserId, input.pluginInstanceId, input.scopeKey],
      );
      return rows[0] ? analysisResultFromJoinedRow(rows[0]) : undefined;
    },

    async saveEvidence(resultId, evidenceByTopic) {
      await withTransaction(client, async (transactionClient) => {
        await transactionClient.query('delete from analysis_topic_evidence where result_id = $1', [resultId]);
        for (const [topicId, evidenceItems] of Object.entries(evidenceByTopic)) {
          for (const [index, evidence] of evidenceItems.entries()) {
            await transactionClient.query(
              `insert into analysis_topic_evidence (result_id, topic_id, evidence_index, evidence_json)
              values ($1, $2, $3, $4::jsonb)`,
              [resultId, topicId, index, JSON.stringify(evidence)],
            );
          }
        }
      });
    },

    async getTopicEvidence(input) {
      const result = await this.getPublishedResult(input.resultId);
      if (
        !result ||
        result.tenantKey !== input.tenantKey ||
        result.baseUserId !== input.baseUserId ||
        result.pluginInstanceId !== input.pluginInstanceId ||
        result.scopeKey !== input.scopeKey
      ) {
        return undefined;
      }

      const offset = (input.page - 1) * input.pageSize;
      const [{ rows: countRows }, { rows }] = await Promise.all([
        client.query<{ count: string }>(
          `select count(*)::text as count from analysis_topic_evidence where result_id = $1 and topic_id = $2`,
          [input.resultId, input.topicId],
        ),
        client.query<AnalysisTopicEvidenceRow>(
          `select * from analysis_topic_evidence
          where result_id = $1 and topic_id = $2
          order by evidence_index asc
          limit $3 offset $4`,
          [input.resultId, input.topicId, input.pageSize, offset],
        ),
      ]);
      const total = Number(countRows[0]?.count ?? 0);
      if (total === 0) {
        return undefined;
      }
      return {
        resultId: input.resultId,
        topicId: input.topicId,
        page: input.page,
        pageSize: input.pageSize,
        total,
        evidence: rows.map((row) => parseJson(row.evidence_json) as TopicEvidence),
      };
    },
  };
}

type AnalysisConfigRow = {
  id: string;
  tenant_key: string;
  plugin_instance_id: string;
  created_by_base_user_id: string;
  source_kind: BackendAnalysisSourceDescriptor['kind'];
  source_ref_json: Record<string, unknown> | string;
  field_mapping_json: Record<string, string> | string;
  filters_json: JsonValue | string | null;
  dashboard_data_conditions_json: JsonValue | string | null;
  ai_profile_id?: string | null;
  config_version: number;
  updated_at: string | Date;
};

type AnalysisJobRow = {
  id: string;
  tenant_key: string;
  base_user_id: string;
  plugin_instance_id: string;
  config_id: string;
  config_version: number;
  scope_key: string;
  status: AnalysisJobStatus;
  stage: AnalysisStage;
  progress_json: { value?: number; resultId?: string } | string | null;
  result_id?: string | null;
  error_stage?: AnalysisStage | null;
  error_message?: string | null;
  started_at?: string | Date | null;
  finished_at?: string | Date | null;
  created_at: string | Date;
};

type AnalysisResultRow = {
  id: string;
  tenant_key: string;
  base_user_id: string;
  plugin_instance_id: string;
  config_id: string;
  config_version: number;
  job_id: string;
  scope_key: string;
  model: string;
  pipeline_version: string;
  result_json: { topics?: JsonValue[]; sourceVersion?: SourceVersion } | string;
  summary_json: JsonValue | string;
  generated_at: string | Date;
  created_at: string | Date;
};

type AnalysisResultJoinedRow = AnalysisResultRow & {
  source_kind?: SourceVersion['kind'] | null;
  source_id?: string | null;
  version?: string | null;
  content_hash?: string | null;
  record_count?: number | null;
  source_generated_at?: string | Date | null;
};

type AnalysisTopicEvidenceRow = {
  evidence_json: TopicEvidence | string;
};

async function ensureSourceVersion(client: PostgresQueryClient, input: Omit<AnalysisResult, 'resultId' | 'createdAt'>): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into review_source_versions (
      tenant_key, source_kind, source_id, version, record_count, content_hash, generated_at
    ) values ($1, $2, $3, $4, $5, $6, $7)
    on conflict (tenant_key, source_kind, source_id, version)
    do update set
      record_count = excluded.record_count,
      content_hash = excluded.content_hash,
      generated_at = excluded.generated_at
    returning id`,
    [
      input.tenantKey,
      input.sourceVersion.kind,
      input.sourceVersion.sourceId,
      input.sourceVersion.version,
      input.sourceVersion.recordCount,
      input.sourceVersion.contentHash,
      input.sourceVersion.generatedAt,
    ],
  );
  return requireSingleRow(rows, 'saved source version missing').id;
}

async function getAnyResult(client: PostgresQueryClient, resultId: string): Promise<AnalysisResult | undefined> {
  const { rows } = await client.query<AnalysisResultJoinedRow>(
    `select result.*, version.source_kind, version.source_id, version.version, version.content_hash, version.record_count, version.generated_at as source_generated_at
    from analysis_results result
    left join review_source_versions version on version.id = result.source_version_id
    where result.id = $1
    limit 1`,
    [resultId],
  );
  return rows[0] ? analysisResultFromJoinedRow(rows[0]) : undefined;
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

function sourceRefJson(input: BackendAnalysisConfigUpsertRequest): Record<string, unknown> {
  const { fieldMapping: _fieldMapping, ...sourceRef } = input.source;
  return {
    ...sourceRef,
    baseToken: input.baseToken ?? null,
  };
}

function analysisConfigFromRow(row: AnalysisConfigRow): BackendAnalysisConfig {
  const sourceRef = parseJson(row.source_ref_json) as Record<string, JsonValue | undefined>;
  const fieldMapping = parseJson(row.field_mapping_json) as Record<string, string>;
  const { baseToken, ...sourceConfig } = sourceRef;
  return {
    tenantKey: row.tenant_key,
    baseUserId: row.created_by_base_user_id,
    pluginInstanceId: row.plugin_instance_id,
    baseToken: typeof baseToken === 'string' ? baseToken : undefined,
    model: row.ai_profile_id ?? undefined,
    source: {
      ...sourceConfig,
      kind: row.source_kind,
      fieldMapping,
    },
    filters: parseJson(row.filters_json) as JsonValue,
    dashboardDataConditions: parseJson(row.dashboard_data_conditions_json) as JsonValue,
    configId: row.id,
    configVersion: Number(row.config_version),
    updatedAt: toIsoString(row.updated_at),
  };
}

function analysisJobFromRow(row: AnalysisJobRow): AnalysisJob {
  const progress = parseJson(row.progress_json) as { value?: number; resultId?: string } | null;
  return {
    jobId: row.id,
    tenantKey: row.tenant_key,
    baseUserId: row.base_user_id,
    pluginInstanceId: row.plugin_instance_id,
    configId: row.config_id,
    configVersion: Number(row.config_version),
    scopeKey: row.scope_key,
    status: row.status,
    stage: row.stage,
    progress: Number(progress?.value ?? 0),
    createdAt: toIsoString(row.created_at),
    startedAt: row.started_at ? toIsoString(row.started_at) : undefined,
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : undefined,
    errorStage: row.error_stage ?? undefined,
    errorMessage: row.error_message ?? undefined,
    resultId: row.result_id ?? progress?.resultId,
  };
}

function analysisResultFromRow(row: AnalysisResultRow, sourceVersion: SourceVersion): AnalysisResult {
  const resultJson = parseJson(row.result_json) as { topics?: JsonValue[] };
  return {
    resultId: row.id,
    tenantKey: row.tenant_key,
    baseUserId: row.base_user_id,
    pluginInstanceId: row.plugin_instance_id,
    scopeKey: row.scope_key,
    jobId: row.job_id,
    configId: row.config_id,
    configVersion: Number(row.config_version),
    sourceVersion,
    pipelineVersion: row.pipeline_version,
    summary: parseJson(row.summary_json) as JsonValue,
    topics: resultJson.topics ?? [],
    createdAt: toIsoString(row.created_at),
  };
}

function analysisResultFromJoinedRow(row: AnalysisResultJoinedRow): AnalysisResult {
  const resultJson = parseJson(row.result_json) as { topics?: JsonValue[]; sourceVersion?: SourceVersion };
  const sourceVersion = resultJson.sourceVersion ?? {
    kind: row.source_kind ?? 'postgres',
    sourceId: row.source_id ?? 'unknown',
    version: row.version ?? 'unknown',
    contentHash: row.content_hash ?? '',
    recordCount: Number(row.record_count ?? 0),
    generatedAt: row.source_generated_at ? toIsoString(row.source_generated_at) : toIsoString(row.generated_at),
  };
  return analysisResultFromRow(row, sourceVersion);
}

function resolveModelFromSummary(summary: JsonValue): string {
  if (summary && typeof summary === 'object' && !Array.isArray(summary) && typeof summary.model === 'string') {
    return summary.model;
  }
  return 'unknown';
}

type PersistedCacheDiagnostics = {
  evidenceCache: {
    requested: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  topicMappingCache: {
    requested: number;
    hits: number;
    misses: number;
    hitRate: number;
  };
  aiCalled: boolean;
  aiTriggered: {
    evidenceExtraction: boolean;
    topicMapping: boolean;
  };
};

function readCacheDiagnostics(summary: JsonValue): PersistedCacheDiagnostics {
  const diagnostics = isJsonObject(summary) ? summary.cacheDiagnostics : undefined;
  const diagnosticsObject = isJsonObject(diagnostics) ? diagnostics : {};
  const aiTriggered = isJsonObject(diagnosticsObject.aiTriggered) ? diagnosticsObject.aiTriggered : {};
  const evidenceExtraction = readBoolean(aiTriggered.evidenceExtraction);
  const topicMapping = readBoolean(aiTriggered.topicMapping);
  return {
    evidenceCache: readCacheLayerDiagnostics(diagnosticsObject.evidenceCache),
    topicMappingCache: readCacheLayerDiagnostics(diagnosticsObject.topicMappingCache),
    aiCalled: evidenceExtraction || topicMapping,
    aiTriggered: {
      evidenceExtraction,
      topicMapping,
    },
  };
}

function readCacheLayerDiagnostics(value: unknown): PersistedCacheDiagnostics['evidenceCache'] {
  const layer = isJsonObject(value) ? value : {};
  return {
    requested: readNonNegativeInteger(layer.requested),
    hits: readNonNegativeInteger(layer.hits),
    misses: readNonNegativeInteger(layer.misses),
    hitRate: readFiniteNumber(layer.hitRate),
  };
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue | undefined> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return JSON.parse(value) as unknown;
  }
  return value;
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
