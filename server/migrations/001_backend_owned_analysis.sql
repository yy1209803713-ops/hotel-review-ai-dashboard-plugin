CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS analysis_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  plugin_instance_id text NOT NULL,
  created_by_base_user_id text NOT NULL,
  source_kind text NOT NULL,
  source_ref_json jsonb NOT NULL,
  field_mapping_json jsonb NOT NULL,
  filters_json jsonb NOT NULL,
  dashboard_data_conditions_json jsonb NOT NULL,
  ai_profile_id text,
  config_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_configs_instance_idx
  ON analysis_configs (tenant_key, plugin_instance_id, created_by_base_user_id, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_configs_identity_uidx
  ON analysis_configs (tenant_key, plugin_instance_id, created_by_base_user_id);

COMMENT ON TABLE analysis_configs IS '分析配置表，保存一次分析所需的来源、字段映射、过滤条件和 AI 配置。';
COMMENT ON COLUMN analysis_configs.id IS '配置主键。';
COMMENT ON COLUMN analysis_configs.tenant_key IS '租户标识。';
COMMENT ON COLUMN analysis_configs.plugin_instance_id IS '插件实例标识。';
COMMENT ON COLUMN analysis_configs.created_by_base_user_id IS '创建该配置的 Base 用户标识。';
COMMENT ON COLUMN analysis_configs.source_kind IS '数据来源类型。';
COMMENT ON COLUMN analysis_configs.source_ref_json IS '来源引用信息，JSON 格式。';
COMMENT ON COLUMN analysis_configs.field_mapping_json IS '字段映射配置，JSON 格式。';
COMMENT ON COLUMN analysis_configs.filters_json IS '分析筛选条件，JSON 格式。';
COMMENT ON COLUMN analysis_configs.dashboard_data_conditions_json IS '仪表盘数据条件，JSON 格式。';
COMMENT ON COLUMN analysis_configs.ai_profile_id IS '关联的 AI 配置标识。';
COMMENT ON COLUMN analysis_configs.config_version IS '配置版本号。';
COMMENT ON COLUMN analysis_configs.created_at IS '创建时间。';
COMMENT ON COLUMN analysis_configs.updated_at IS '更新时间。';

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  base_user_id text NOT NULL,
  plugin_instance_id text NOT NULL,
  config_id uuid NOT NULL REFERENCES analysis_configs(id),
  config_version integer NOT NULL DEFAULT 1,
  scope_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage text NOT NULL,
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_id uuid,
  error_stage text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_active_scope_uidx
  ON analysis_jobs (tenant_key, base_user_id, plugin_instance_id, scope_key)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS analysis_jobs_scope_idx
  ON analysis_jobs (tenant_key, base_user_id, plugin_instance_id, scope_key, created_at DESC);

ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS result_id uuid;

COMMENT ON TABLE analysis_jobs IS '分析任务表，记录一次分析执行的状态、阶段和错误信息。';
COMMENT ON COLUMN analysis_jobs.id IS '任务主键。';
COMMENT ON COLUMN analysis_jobs.tenant_key IS '租户标识。';
COMMENT ON COLUMN analysis_jobs.base_user_id IS '发起任务的 Base 用户标识。';
COMMENT ON COLUMN analysis_jobs.plugin_instance_id IS '插件实例标识。';
COMMENT ON COLUMN analysis_jobs.config_id IS '关联的分析配置。';
COMMENT ON COLUMN analysis_jobs.config_version IS '任务创建时对应的分析配置版本号。';
COMMENT ON COLUMN analysis_jobs.scope_key IS '分析作用域键。';
COMMENT ON COLUMN analysis_jobs.status IS '任务状态。';
COMMENT ON COLUMN analysis_jobs.stage IS '当前执行阶段。';
COMMENT ON COLUMN analysis_jobs.progress_json IS '任务进度信息，JSON 格式。';
COMMENT ON COLUMN analysis_jobs.result_id IS '成功任务关联的分析结果标识。';
COMMENT ON COLUMN analysis_jobs.error_stage IS '出错阶段。';
COMMENT ON COLUMN analysis_jobs.error_message IS '错误信息。';
COMMENT ON COLUMN analysis_jobs.started_at IS '开始时间。';
COMMENT ON COLUMN analysis_jobs.finished_at IS '结束时间。';
COMMENT ON COLUMN analysis_jobs.created_at IS '创建时间。';
COMMENT ON COLUMN analysis_jobs.updated_at IS '更新时间。';

ALTER TABLE analysis_jobs DROP CONSTRAINT IF EXISTS analysis_jobs_status_check;

UPDATE analysis_jobs
SET status = CASE
  WHEN status = 'succeeded' THEN 'success'
  WHEN status = 'cancelled' THEN 'canceled'
  ELSE status
END
WHERE status IN ('succeeded', 'cancelled');

ALTER TABLE analysis_jobs
  ADD CONSTRAINT analysis_jobs_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled'));

CREATE TABLE IF NOT EXISTS review_source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_key_hash text NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  version text NOT NULL,
  record_count integer NOT NULL,
  content_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE review_source_versions ADD COLUMN IF NOT EXISTS source_key_hash text NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

COMMENT ON TABLE review_source_versions IS '来源版本表，记录原始评论数据源的生成版本与摘要。';
COMMENT ON COLUMN review_source_versions.id IS '版本记录主键。';
COMMENT ON COLUMN review_source_versions.tenant_key IS '租户标识。';
COMMENT ON COLUMN review_source_versions.source_kind IS '来源类型。';
COMMENT ON COLUMN review_source_versions.source_id IS '来源标识。';
COMMENT ON COLUMN review_source_versions.source_key_hash IS '同步字段映射哈希，仅用于审计；不参与原始镜像 identity。';
COMMENT ON COLUMN review_source_versions.version IS '版本号。';
COMMENT ON COLUMN review_source_versions.record_count IS '记录数量。';
COMMENT ON COLUMN review_source_versions.content_hash IS '内容哈希。';
COMMENT ON COLUMN review_source_versions.generated_at IS '生成时间。';
COMMENT ON COLUMN review_source_versions.created_at IS '创建时间。';

DO $$
BEGIN
  IF to_regclass(current_schema() || '.review_source_versions_source_version_uidx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'review_source_versions_source_version_uidx');
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass(current_schema() || '.analysis_results') IS NOT NULL THEN
    WITH ranked_versions AS (
      SELECT
        id,
        first_value(id) OVER (
          PARTITION BY tenant_key, source_kind, source_id, version
          ORDER BY generated_at DESC, created_at DESC, id::text DESC
        ) AS kept_id,
        row_number() OVER (
          PARTITION BY tenant_key, source_kind, source_id, version
          ORDER BY generated_at DESC, created_at DESC, id::text DESC
        ) AS row_number
      FROM review_source_versions
    )
    UPDATE analysis_results
    SET source_version_id = ranked_versions.kept_id
    FROM ranked_versions
    WHERE analysis_results.source_version_id = ranked_versions.id
      AND ranked_versions.row_number > 1;
  END IF;
END $$;

DELETE FROM review_source_versions
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY tenant_key, source_kind, source_id, version
        ORDER BY generated_at DESC, created_at DESC, id::text DESC
      ) AS row_number
    FROM review_source_versions
  ) ranked_versions
  WHERE ranked_versions.row_number > 1
);

CREATE UNIQUE INDEX review_source_versions_source_version_uidx
  ON review_source_versions (tenant_key, source_kind, source_id, version);

CREATE TABLE IF NOT EXISTS analysis_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  base_user_id text NOT NULL,
  plugin_instance_id text NOT NULL,
  config_id uuid NOT NULL REFERENCES analysis_configs(id),
  config_version integer NOT NULL DEFAULT 1,
  job_id uuid NOT NULL REFERENCES analysis_jobs(id),
  scope_key text NOT NULL,
  source_version_id uuid REFERENCES review_source_versions(id),
  model text NOT NULL,
  pipeline_version text NOT NULL,
  result_json jsonb NOT NULL,
  summary_json jsonb NOT NULL,
  evidence_cache_requested integer NOT NULL DEFAULT 0,
  evidence_cache_hits integer NOT NULL DEFAULT 0,
  evidence_cache_misses integer NOT NULL DEFAULT 0,
  evidence_cache_hit_rate double precision NOT NULL DEFAULT 0,
  topic_mapping_cache_requested integer NOT NULL DEFAULT 0,
  topic_mapping_cache_hits integer NOT NULL DEFAULT 0,
  topic_mapping_cache_misses integer NOT NULL DEFAULT 0,
  topic_mapping_cache_hit_rate double precision NOT NULL DEFAULT 0,
  ai_called boolean NOT NULL DEFAULT false,
  ai_evidence_extraction_called boolean NOT NULL DEFAULT false,
  ai_topic_mapping_called boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_results_latest_idx
  ON analysis_results (tenant_key, base_user_id, plugin_instance_id, scope_key, generated_at DESC);

ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS evidence_cache_requested integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS evidence_cache_hits integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS evidence_cache_misses integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS evidence_cache_hit_rate double precision NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS topic_mapping_cache_requested integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS topic_mapping_cache_hits integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS topic_mapping_cache_misses integer NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS topic_mapping_cache_hit_rate double precision NOT NULL DEFAULT 0;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS ai_called boolean NOT NULL DEFAULT false;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS ai_evidence_extraction_called boolean NOT NULL DEFAULT false;
ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS ai_topic_mapping_called boolean NOT NULL DEFAULT false;

UPDATE analysis_results
SET
  evidence_cache_requested = COALESCE((summary_json #>> '{cacheDiagnostics,evidenceCache,requested}')::integer, evidence_cache_requested),
  evidence_cache_hits = COALESCE((summary_json #>> '{cacheDiagnostics,evidenceCache,hits}')::integer, evidence_cache_hits),
  evidence_cache_misses = COALESCE((summary_json #>> '{cacheDiagnostics,evidenceCache,misses}')::integer, evidence_cache_misses),
  evidence_cache_hit_rate = COALESCE((summary_json #>> '{cacheDiagnostics,evidenceCache,hitRate}')::double precision, evidence_cache_hit_rate),
  topic_mapping_cache_requested = COALESCE((summary_json #>> '{cacheDiagnostics,topicMappingCache,requested}')::integer, topic_mapping_cache_requested),
  topic_mapping_cache_hits = COALESCE((summary_json #>> '{cacheDiagnostics,topicMappingCache,hits}')::integer, topic_mapping_cache_hits),
  topic_mapping_cache_misses = COALESCE((summary_json #>> '{cacheDiagnostics,topicMappingCache,misses}')::integer, topic_mapping_cache_misses),
  topic_mapping_cache_hit_rate = COALESCE((summary_json #>> '{cacheDiagnostics,topicMappingCache,hitRate}')::double precision, topic_mapping_cache_hit_rate),
  ai_evidence_extraction_called = COALESCE((summary_json #>> '{cacheDiagnostics,aiTriggered,evidenceExtraction}')::boolean, ai_evidence_extraction_called),
  ai_topic_mapping_called = COALESCE((summary_json #>> '{cacheDiagnostics,aiTriggered,topicMapping}')::boolean, ai_topic_mapping_called),
  ai_called = COALESCE((summary_json #>> '{cacheDiagnostics,aiTriggered,evidenceExtraction}')::boolean, ai_evidence_extraction_called)
    OR COALESCE((summary_json #>> '{cacheDiagnostics,aiTriggered,topicMapping}')::boolean, ai_topic_mapping_called)
WHERE summary_json ? 'cacheDiagnostics';

COMMENT ON TABLE analysis_results IS '分析结果表，保存一次任务输出的明细结果和摘要。';
COMMENT ON COLUMN analysis_results.id IS '结果主键。';
COMMENT ON COLUMN analysis_results.tenant_key IS '租户标识。';
COMMENT ON COLUMN analysis_results.base_user_id IS '发起结果查询的 Base 用户标识。';
COMMENT ON COLUMN analysis_results.plugin_instance_id IS '插件实例标识。';
COMMENT ON COLUMN analysis_results.config_id IS '关联的分析配置。';
COMMENT ON COLUMN analysis_results.config_version IS '生成结果时对应的分析配置版本号。';
COMMENT ON COLUMN analysis_results.job_id IS '关联的分析任务。';
COMMENT ON COLUMN analysis_results.scope_key IS '分析作用域键。';
COMMENT ON COLUMN analysis_results.source_version_id IS '关联的来源版本。';
COMMENT ON COLUMN analysis_results.model IS '使用的模型标识。';
COMMENT ON COLUMN analysis_results.pipeline_version IS '分析流水线版本。';
COMMENT ON COLUMN analysis_results.result_json IS '分析结果明细，JSON 格式。';
COMMENT ON COLUMN analysis_results.summary_json IS '分析摘要，JSON 格式。';
COMMENT ON COLUMN analysis_results.evidence_cache_requested IS '本次分析证据缓存请求数量。';
COMMENT ON COLUMN analysis_results.evidence_cache_hits IS '本次分析证据缓存命中数量。';
COMMENT ON COLUMN analysis_results.evidence_cache_misses IS '本次分析证据缓存未命中数量。';
COMMENT ON COLUMN analysis_results.evidence_cache_hit_rate IS '本次分析证据缓存命中率。';
COMMENT ON COLUMN analysis_results.topic_mapping_cache_requested IS '本次分析主题映射缓存请求数量。';
COMMENT ON COLUMN analysis_results.topic_mapping_cache_hits IS '本次分析主题映射缓存命中数量。';
COMMENT ON COLUMN analysis_results.topic_mapping_cache_misses IS '本次分析主题映射缓存未命中数量。';
COMMENT ON COLUMN analysis_results.topic_mapping_cache_hit_rate IS '本次分析主题映射缓存命中率。';
COMMENT ON COLUMN analysis_results.ai_called IS '本次分析是否调用过 AI。';
COMMENT ON COLUMN analysis_results.ai_evidence_extraction_called IS '本次分析是否调用过 AI 证据抽取。';
COMMENT ON COLUMN analysis_results.ai_topic_mapping_called IS '本次分析是否调用过 AI 主题归并。';
COMMENT ON COLUMN analysis_results.generated_at IS '结果生成时间。';
COMMENT ON COLUMN analysis_results.created_at IS '创建时间。';

CREATE TABLE IF NOT EXISTS analysis_topic_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
  topic_id text NOT NULL,
  evidence_index integer NOT NULL,
  evidence_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_topic_evidence_result_topic_index_uidx
  ON analysis_topic_evidence (result_id, topic_id, evidence_index);

CREATE INDEX IF NOT EXISTS analysis_topic_evidence_topic_idx
  ON analysis_topic_evidence (result_id, topic_id, evidence_index);

COMMENT ON TABLE analysis_topic_evidence IS '分析主题证据表，按主题拆分保存分析结果中的证据明细。';
COMMENT ON COLUMN analysis_topic_evidence.id IS '证据记录主键。';
COMMENT ON COLUMN analysis_topic_evidence.result_id IS '关联的分析结果。';
COMMENT ON COLUMN analysis_topic_evidence.topic_id IS '主题标识。';
COMMENT ON COLUMN analysis_topic_evidence.evidence_index IS '该主题下证据排序序号。';
COMMENT ON COLUMN analysis_topic_evidence.evidence_json IS '证据明细，JSON 格式。';
COMMENT ON COLUMN analysis_topic_evidence.created_at IS '创建时间。';

CREATE TABLE IF NOT EXISTS evidence_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_record_id text NOT NULL,
  content_hash text NOT NULL,
  model text NOT NULL,
  extractor_version text NOT NULL,
  evidence_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_cache_identity_uidx
  ON evidence_cache (tenant_key, source_kind, source_id, source_record_id, content_hash, model, extractor_version);

COMMENT ON TABLE evidence_cache IS '证据缓存表，缓存从原始来源中抽取的证据片段。';
COMMENT ON COLUMN evidence_cache.id IS '缓存主键。';
COMMENT ON COLUMN evidence_cache.tenant_key IS '租户标识。';
COMMENT ON COLUMN evidence_cache.source_kind IS '来源类型。';
COMMENT ON COLUMN evidence_cache.source_id IS '来源标识。';
COMMENT ON COLUMN evidence_cache.source_record_id IS '来源记录标识。';
COMMENT ON COLUMN evidence_cache.content_hash IS '内容哈希。';
COMMENT ON COLUMN evidence_cache.model IS '抽取证据时使用的模型标识。';
COMMENT ON COLUMN evidence_cache.extractor_version IS '抽取器版本。';
COMMENT ON COLUMN evidence_cache.evidence_json IS '证据内容，JSON 格式。';
COMMENT ON COLUMN evidence_cache.created_at IS '创建时间。';
COMMENT ON COLUMN evidence_cache.updated_at IS '更新时间。';
COMMENT ON COLUMN evidence_cache.last_used_at IS '最近使用时间。';

CREATE TABLE IF NOT EXISTS topic_mapping_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  sentiment text NOT NULL,
  normalized_source_label text NOT NULL,
  model text NOT NULL,
  mapping_version text NOT NULL,
  mapping_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS topic_mapping_cache_identity_uidx
  ON topic_mapping_cache (tenant_key, source_kind, source_id, sentiment, normalized_source_label, model, mapping_version);

COMMENT ON TABLE topic_mapping_cache IS '主题映射缓存表，缓存情感标签到标准主题的归一化结果。';
COMMENT ON COLUMN topic_mapping_cache.id IS '缓存主键。';
COMMENT ON COLUMN topic_mapping_cache.tenant_key IS '租户标识。';
COMMENT ON COLUMN topic_mapping_cache.source_kind IS '来源类型。';
COMMENT ON COLUMN topic_mapping_cache.source_id IS '来源标识。';
COMMENT ON COLUMN topic_mapping_cache.sentiment IS '情感标签。';
COMMENT ON COLUMN topic_mapping_cache.normalized_source_label IS '归一化后的来源标签。';
COMMENT ON COLUMN topic_mapping_cache.model IS '映射时使用的模型标识。';
COMMENT ON COLUMN topic_mapping_cache.mapping_version IS '映射版本。';
COMMENT ON COLUMN topic_mapping_cache.mapping_json IS '映射结果，JSON 格式。';
COMMENT ON COLUMN topic_mapping_cache.created_at IS '创建时间。';
COMMENT ON COLUMN topic_mapping_cache.updated_at IS '更新时间。';
COMMENT ON COLUMN topic_mapping_cache.last_used_at IS '最近使用时间。';

CREATE TABLE IF NOT EXISTS ai_batch_diagnostics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL,
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  table_id text,
  model text NOT NULL,
  extractor_version text NOT NULL,
  batch_index integer NOT NULL,
  batch_number integer NOT NULL,
  batch_count integer NOT NULL,
  record_ids_json jsonb NOT NULL,
  records_json jsonb NOT NULL,
  error_code text,
  error_message text NOT NULL,
  raw_content text,
  raw_length integer,
  preview text,
  details_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_batch_diagnostics_job_idx
  ON ai_batch_diagnostics (job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ai_batch_diagnostics_source_idx
  ON ai_batch_diagnostics (tenant_key, source_kind, source_id, model, created_at DESC);

COMMENT ON TABLE ai_batch_diagnostics IS 'AI 批次失败诊断表，保存失败批次的输入记录、模型原始输出和错误详情。';
COMMENT ON COLUMN ai_batch_diagnostics.id IS '诊断记录主键。';
COMMENT ON COLUMN ai_batch_diagnostics.job_id IS '关联分析任务 ID。';
COMMENT ON COLUMN ai_batch_diagnostics.tenant_key IS '租户标识。';
COMMENT ON COLUMN ai_batch_diagnostics.source_kind IS '来源类型。';
COMMENT ON COLUMN ai_batch_diagnostics.source_id IS '来源标识。';
COMMENT ON COLUMN ai_batch_diagnostics.table_id IS '来源表 ID。';
COMMENT ON COLUMN ai_batch_diagnostics.model IS '使用的模型标识。';
COMMENT ON COLUMN ai_batch_diagnostics.extractor_version IS '证据抽取器版本。';
COMMENT ON COLUMN ai_batch_diagnostics.batch_index IS '批次下标，从 0 开始。';
COMMENT ON COLUMN ai_batch_diagnostics.batch_number IS '批次序号，从 1 开始。';
COMMENT ON COLUMN ai_batch_diagnostics.batch_count IS '总批次数。';
COMMENT ON COLUMN ai_batch_diagnostics.record_ids_json IS '失败批次记录 ID 列表。';
COMMENT ON COLUMN ai_batch_diagnostics.records_json IS '失败批次输入记录快照。';
COMMENT ON COLUMN ai_batch_diagnostics.error_code IS '错误代码。';
COMMENT ON COLUMN ai_batch_diagnostics.error_message IS '错误信息。';
COMMENT ON COLUMN ai_batch_diagnostics.raw_content IS '模型返回的完整原始内容。';
COMMENT ON COLUMN ai_batch_diagnostics.raw_length IS '模型原始内容长度。';
COMMENT ON COLUMN ai_batch_diagnostics.preview IS '模型原始内容预览。';
COMMENT ON COLUMN ai_batch_diagnostics.details_json IS '错误详情 JSON。';
COMMENT ON COLUMN ai_batch_diagnostics.created_at IS '诊断记录创建时间。';

CREATE TABLE IF NOT EXISTS review_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_key_hash text NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  base_token text,
  table_id text,
  record_id text NOT NULL,
  fields_json jsonb NOT NULL,
  parsed_review_json jsonb NOT NULL,
  content_hash text NOT NULL,
  source_updated_at timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now(),
  is_deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE review_records ADD COLUMN IF NOT EXISTS source_key_hash text NOT NULL DEFAULT '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

COMMENT ON TABLE review_records IS '评论原始记录表，保存从 Base 同步的评论字段和解析结果。';
COMMENT ON COLUMN review_records.id IS '记录主键。';
COMMENT ON COLUMN review_records.tenant_key IS '租户标识。';
COMMENT ON COLUMN review_records.source_kind IS '来源类型。';
COMMENT ON COLUMN review_records.source_id IS '来源标识。';
COMMENT ON COLUMN review_records.source_key_hash IS '同步字段映射哈希，仅用于审计；不参与原始镜像 identity。';
COMMENT ON COLUMN review_records.base_token IS 'Base 访问令牌。';
COMMENT ON COLUMN review_records.table_id IS 'Base 表 ID。';
COMMENT ON COLUMN review_records.record_id IS 'Base 记录 ID。';
COMMENT ON COLUMN review_records.fields_json IS '原始字段数据，JSON 格式。';
COMMENT ON COLUMN review_records.parsed_review_json IS '解析后的评论数据，JSON 格式。';
COMMENT ON COLUMN review_records.content_hash IS '内容哈希。';
COMMENT ON COLUMN review_records.source_updated_at IS '来源记录更新时间。';
COMMENT ON COLUMN review_records.synced_at IS '同步时间。';
COMMENT ON COLUMN review_records.is_deleted IS '是否已删除。';
COMMENT ON COLUMN review_records.created_at IS '创建时间。';
COMMENT ON COLUMN review_records.updated_at IS '更新时间。';

DO $$
BEGIN
  IF to_regclass(current_schema() || '.review_records_identity_uidx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'review_records_identity_uidx');
  END IF;
  IF to_regclass(current_schema() || '.review_records_source_idx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'review_records_source_idx');
  END IF;
END $$;

DELETE FROM review_records
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY tenant_key, source_kind, source_id, record_id
        ORDER BY updated_at DESC, created_at DESC, id::text DESC
      ) AS row_number
    FROM review_records
  ) ranked_records
  WHERE ranked_records.row_number > 1
);

CREATE UNIQUE INDEX review_records_identity_uidx
  ON review_records (tenant_key, source_kind, source_id, record_id);

CREATE INDEX review_records_source_idx
  ON review_records (tenant_key, source_kind, source_id, is_deleted, synced_at DESC);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  base_token text,
  table_id text,
  view_id text,
  field_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_key_hash text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'incremental')),
  trigger_type text NOT NULL DEFAULT 'manual_api' CHECK (trigger_type IN ('manual_api')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage text NOT NULL,
  records_read integer NOT NULL DEFAULT 0,
  records_upserted integer NOT NULL DEFAULT 0,
  records_deleted integer NOT NULL DEFAULT 0,
  records_unchanged integer NOT NULL DEFAULT 0,
  error_stage text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_jobs_source_idx
  ON sync_jobs (tenant_key, source_kind, source_id, created_at DESC);

ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS base_token text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS table_id text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS view_id text;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS field_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS source_key_hash text NOT NULL DEFAULT '';
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'full';
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS records_unchanged integer NOT NULL DEFAULT 0;
ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS duration_ms integer;

COMMENT ON TABLE sync_jobs IS '同步任务表，记录评论同步执行过程、统计与错误信息。';
COMMENT ON COLUMN sync_jobs.id IS '任务主键。';
COMMENT ON COLUMN sync_jobs.tenant_key IS '租户标识。';
COMMENT ON COLUMN sync_jobs.source_kind IS '来源类型。';
COMMENT ON COLUMN sync_jobs.source_id IS '来源标识。';
COMMENT ON COLUMN sync_jobs.base_token IS 'Base 访问令牌。';
COMMENT ON COLUMN sync_jobs.table_id IS 'Base 表 ID。';
COMMENT ON COLUMN sync_jobs.view_id IS 'Base 视图 ID。';
COMMENT ON COLUMN sync_jobs.field_mapping_json IS '同步使用的字段映射，JSON 格式。';
COMMENT ON COLUMN sync_jobs.source_key_hash IS '同步字段映射哈希，仅用于审计和历史排查；不参与原始镜像 identity。';
COMMENT ON COLUMN sync_jobs.mode IS '同步模式：full 全量同步，incremental 扫描飞书全量后只写入差异。';
COMMENT ON COLUMN sync_jobs.trigger_type IS '触发类型。';
COMMENT ON COLUMN sync_jobs.status IS '任务状态。';
COMMENT ON COLUMN sync_jobs.stage IS '当前执行阶段。';
COMMENT ON COLUMN sync_jobs.records_read IS '读取到的记录数。';
COMMENT ON COLUMN sync_jobs.records_upserted IS '已写入或更新的记录数。';
COMMENT ON COLUMN sync_jobs.records_deleted IS '已删除的记录数。';
COMMENT ON COLUMN sync_jobs.records_unchanged IS '增量同步中判断为未变化的记录数。';
COMMENT ON COLUMN sync_jobs.error_stage IS '出错阶段。';
COMMENT ON COLUMN sync_jobs.error_message IS '错误信息。';
COMMENT ON COLUMN sync_jobs.started_at IS '开始时间。';
COMMENT ON COLUMN sync_jobs.finished_at IS '结束时间。';
COMMENT ON COLUMN sync_jobs.duration_ms IS '任务耗时，单位毫秒。';
COMMENT ON COLUMN sync_jobs.created_at IS '创建时间。';
COMMENT ON COLUMN sync_jobs.updated_at IS '更新时间。';

UPDATE sync_jobs
SET source_key_hash = encode(digest(
  '{' || (
    SELECT COALESCE(string_agg(to_json(field_mapping.key)::text || ':' || to_json(field_mapping.value)::text, ',' ORDER BY field_mapping.key), '')
    FROM jsonb_each_text(field_mapping_json) AS field_mapping(key, value)
  ) || '}',
  'sha256'
), 'hex')
;

DO $$
BEGIN
  IF to_regclass(current_schema() || '.sync_jobs_active_source_trigger_uidx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'sync_jobs_active_source_trigger_uidx');
  END IF;
END $$;

CREATE UNIQUE INDEX sync_jobs_active_source_trigger_uidx
  ON sync_jobs (tenant_key, source_kind, source_id, mode)
  WHERE status IN ('queued', 'running');

ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_status_check;
ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_trigger_type_check;
ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_mode_check;

UPDATE sync_jobs
SET status = CASE
  WHEN status = 'succeeded' THEN 'success'
  WHEN status = 'cancelled' THEN 'canceled'
  ELSE status
END
WHERE status IN ('succeeded', 'cancelled');

UPDATE sync_jobs
SET trigger_type = 'manual_api'
WHERE trigger_type <> 'manual_api';

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled'));

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_trigger_type_check
  CHECK (trigger_type IN ('manual_api'));

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_mode_check
  CHECK (mode IN ('full', 'incremental'));

CREATE TABLE IF NOT EXISTS warmup_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  base_token text,
  table_id text,
  mode text NOT NULL CHECK (mode IN ('bootstrap', 'incremental')),
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual_api', 'sync_followup', 'feishu_workflow', 'dashboard_button')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage text NOT NULL,
  request_json jsonb NOT NULL,
  accepted_response_json jsonb NOT NULL,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_start_date text,
  review_end_date text,
  records_scanned integer NOT NULL DEFAULT 0,
  evidence_cache_hits integer NOT NULL DEFAULT 0,
  evidence_cache_misses integer NOT NULL DEFAULT 0,
  evidence_cache_inserts integer NOT NULL DEFAULT 0,
  evidence_cache_updates integer NOT NULL DEFAULT 0,
  topic_mapping_cache_hits integer NOT NULL DEFAULT 0,
  topic_mapping_cache_misses integer NOT NULL DEFAULT 0,
  topic_mapping_cache_inserts integer NOT NULL DEFAULT 0,
  topic_mapping_cache_updates integer NOT NULL DEFAULT 0,
  error_stage text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warmup_jobs_source_idx
  ON warmup_jobs (tenant_key, source_kind, source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS warmup_jobs_status_idx
  ON warmup_jobs (status, created_at ASC);

COMMENT ON TABLE warmup_jobs IS '缓存预热任务表，记录每次 warmup 触发、入参、返回、执行结果和两层缓存构建统计。';
COMMENT ON COLUMN warmup_jobs.id IS '预热任务主键。';
COMMENT ON COLUMN warmup_jobs.tenant_key IS '共享来源租户标识，通常为 global-review-source。';
COMMENT ON COLUMN warmup_jobs.source_kind IS '来源类型。';
COMMENT ON COLUMN warmup_jobs.source_id IS '来源标识，按 baseToken:tableId 规范化。';
COMMENT ON COLUMN warmup_jobs.base_token IS 'Base 访问令牌。';
COMMENT ON COLUMN warmup_jobs.table_id IS 'Base 表 ID。';
COMMENT ON COLUMN warmup_jobs.mode IS '预热模式：bootstrap 初始化，incremental 增量补齐。';
COMMENT ON COLUMN warmup_jobs.trigger_type IS '触发类型：手动 API、同步后联动、飞书工作流或插件按钮。';
COMMENT ON COLUMN warmup_jobs.status IS '任务状态。';
COMMENT ON COLUMN warmup_jobs.stage IS '当前执行阶段。';
COMMENT ON COLUMN warmup_jobs.request_json IS '原始 warmup 请求入参，JSON 格式。';
COMMENT ON COLUMN warmup_jobs.accepted_response_json IS '接口接受任务时返回给调用方的响应，JSON 格式。';
COMMENT ON COLUMN warmup_jobs.result_json IS '任务完成或失败后的最终 WarmupResponse，JSON 格式。';
COMMENT ON COLUMN warmup_jobs.review_start_date IS '评论时间筛选开始边界，支持 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss。';
COMMENT ON COLUMN warmup_jobs.review_end_date IS '评论时间筛选结束边界，支持 YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss。';
COMMENT ON COLUMN warmup_jobs.records_scanned IS '本次预热扫描到的原始评论数量。';
COMMENT ON COLUMN warmup_jobs.evidence_cache_hits IS '证据缓存命中数量。';
COMMENT ON COLUMN warmup_jobs.evidence_cache_misses IS '证据缓存未命中数量。';
COMMENT ON COLUMN warmup_jobs.evidence_cache_inserts IS '证据缓存新增数量。';
COMMENT ON COLUMN warmup_jobs.evidence_cache_updates IS '证据缓存更新数量。';
COMMENT ON COLUMN warmup_jobs.topic_mapping_cache_hits IS '主题映射缓存命中数量。';
COMMENT ON COLUMN warmup_jobs.topic_mapping_cache_misses IS '主题映射缓存未命中数量。';
COMMENT ON COLUMN warmup_jobs.topic_mapping_cache_inserts IS '主题映射缓存新增数量。';
COMMENT ON COLUMN warmup_jobs.topic_mapping_cache_updates IS '主题映射缓存更新数量。';
COMMENT ON COLUMN warmup_jobs.error_stage IS '出错阶段。';
COMMENT ON COLUMN warmup_jobs.error_message IS '错误信息。';
COMMENT ON COLUMN warmup_jobs.started_at IS '开始时间。';
COMMENT ON COLUMN warmup_jobs.finished_at IS '结束时间。';
COMMENT ON COLUMN warmup_jobs.duration_ms IS '任务耗时，单位毫秒。';
COMMENT ON COLUMN warmup_jobs.created_at IS '创建时间。';
COMMENT ON COLUMN warmup_jobs.updated_at IS '更新时间。';

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  plugin_instance_id text NOT NULL,
  config_id uuid NOT NULL REFERENCES analysis_configs(id),
  enabled boolean NOT NULL DEFAULT false,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schedules_due_idx
  ON schedules (enabled, next_run_at);

COMMENT ON TABLE schedules IS '调度配置表，保存分析任务的定时执行设置。';
COMMENT ON COLUMN schedules.id IS '调度主键。';
COMMENT ON COLUMN schedules.tenant_key IS '租户标识。';
COMMENT ON COLUMN schedules.plugin_instance_id IS '插件实例标识。';
COMMENT ON COLUMN schedules.config_id IS '关联的分析配置。';
COMMENT ON COLUMN schedules.enabled IS '是否启用调度。';
COMMENT ON COLUMN schedules.cron IS 'Cron 表达式。';
COMMENT ON COLUMN schedules.timezone IS '时区。';
COMMENT ON COLUMN schedules.next_run_at IS '下次执行时间。';
COMMENT ON COLUMN schedules.last_run_at IS '上次执行时间。';
COMMENT ON COLUMN schedules.created_at IS '创建时间。';
COMMENT ON COLUMN schedules.updated_at IS '更新时间。';

CREATE TABLE IF NOT EXISTS facility_analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  base_token text NOT NULL,
  table_id text NOT NULL,
  view_id text,
  collection_date date NOT NULL,
  source_record_count integer NOT NULL,
  result_json jsonb NOT NULL,
  generated_at timestamptz NOT NULL,
  export_status text NOT NULL DEFAULT 'pending',
  export_stage text,
  export_error text,
  exported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS facility_analysis_runs_latest_idx
  ON facility_analysis_runs (tenant_key, base_token, table_id, view_id, collection_date DESC, created_at DESC);

COMMENT ON TABLE facility_analysis_runs IS '设施和政策变动分析运行表，保存每次设施分析结果及导出状态。';
COMMENT ON COLUMN facility_analysis_runs.id IS '运行记录主键。';
COMMENT ON COLUMN facility_analysis_runs.tenant_key IS '租户标识。';
COMMENT ON COLUMN facility_analysis_runs.base_token IS 'Base 访问令牌。';
COMMENT ON COLUMN facility_analysis_runs.table_id IS 'Base 表 ID。';
COMMENT ON COLUMN facility_analysis_runs.view_id IS 'Base 视图 ID。';
COMMENT ON COLUMN facility_analysis_runs.collection_date IS '本次分析对应的采集日期。';
COMMENT ON COLUMN facility_analysis_runs.source_record_count IS '参与本次分析的来源记录数。';
COMMENT ON COLUMN facility_analysis_runs.result_json IS '设施和政策变动分析结果，JSON 格式。';
COMMENT ON COLUMN facility_analysis_runs.generated_at IS '分析结果生成时间。';
COMMENT ON COLUMN facility_analysis_runs.export_status IS '导出状态。';
COMMENT ON COLUMN facility_analysis_runs.export_stage IS '导出阶段。';
COMMENT ON COLUMN facility_analysis_runs.export_error IS '导出错误信息。';
COMMENT ON COLUMN facility_analysis_runs.exported_at IS '导出完成时间。';
COMMENT ON COLUMN facility_analysis_runs.created_at IS '创建时间。';
