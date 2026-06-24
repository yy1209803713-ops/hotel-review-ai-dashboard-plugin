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
COMMENT ON COLUMN review_source_versions.source_key_hash IS '来源字段映射等上下文的哈希，用于区分同一来源下不同读取口径。';
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

CREATE UNIQUE INDEX review_source_versions_source_version_uidx
  ON review_source_versions (tenant_key, source_kind, source_id, source_key_hash, version);

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
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_results_latest_idx
  ON analysis_results (tenant_key, base_user_id, plugin_instance_id, scope_key, generated_at DESC);

ALTER TABLE analysis_results ADD COLUMN IF NOT EXISTS config_version integer NOT NULL DEFAULT 1;

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
COMMENT ON COLUMN review_records.source_key_hash IS '来源字段映射等上下文的哈希，用于区分同一来源下不同读取口径。';
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

CREATE UNIQUE INDEX review_records_identity_uidx
  ON review_records (tenant_key, source_kind, source_id, source_key_hash, record_id);

CREATE INDEX review_records_source_idx
  ON review_records (tenant_key, source_kind, source_id, source_key_hash, is_deleted, synced_at DESC);

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
  trigger_type text NOT NULL CHECK (trigger_type IN ('event', 'schedule', 'manual', 'analysis_preflight')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage text NOT NULL,
  records_read integer NOT NULL DEFAULT 0,
  records_upserted integer NOT NULL DEFAULT 0,
  records_deleted integer NOT NULL DEFAULT 0,
  error_stage text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
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

COMMENT ON TABLE sync_jobs IS '同步任务表，记录评论同步执行过程、统计与错误信息。';
COMMENT ON COLUMN sync_jobs.id IS '任务主键。';
COMMENT ON COLUMN sync_jobs.tenant_key IS '租户标识。';
COMMENT ON COLUMN sync_jobs.source_kind IS '来源类型。';
COMMENT ON COLUMN sync_jobs.source_id IS '来源标识。';
COMMENT ON COLUMN sync_jobs.base_token IS 'Base 访问令牌。';
COMMENT ON COLUMN sync_jobs.table_id IS 'Base 表 ID。';
COMMENT ON COLUMN sync_jobs.view_id IS 'Base 视图 ID。';
COMMENT ON COLUMN sync_jobs.field_mapping_json IS '同步使用的字段映射，JSON 格式。';
COMMENT ON COLUMN sync_jobs.source_key_hash IS '来源字段映射等上下文的哈希，用于区分同一来源下不同读取口径。';
COMMENT ON COLUMN sync_jobs.trigger_type IS '触发类型。';
COMMENT ON COLUMN sync_jobs.status IS '任务状态。';
COMMENT ON COLUMN sync_jobs.stage IS '当前执行阶段。';
COMMENT ON COLUMN sync_jobs.records_read IS '读取到的记录数。';
COMMENT ON COLUMN sync_jobs.records_upserted IS '已写入或更新的记录数。';
COMMENT ON COLUMN sync_jobs.records_deleted IS '已删除的记录数。';
COMMENT ON COLUMN sync_jobs.error_stage IS '出错阶段。';
COMMENT ON COLUMN sync_jobs.error_message IS '错误信息。';
COMMENT ON COLUMN sync_jobs.started_at IS '开始时间。';
COMMENT ON COLUMN sync_jobs.finished_at IS '结束时间。';
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
  ON sync_jobs (tenant_key, source_kind, source_id, trigger_type, source_key_hash)
  WHERE status IN ('queued', 'running');

ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_status_check;

UPDATE sync_jobs
SET status = CASE
  WHEN status = 'succeeded' THEN 'success'
  WHEN status = 'cancelled' THEN 'canceled'
  ELSE status
END
WHERE status IN ('succeeded', 'cancelled');

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_status_check
  CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled'));

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
