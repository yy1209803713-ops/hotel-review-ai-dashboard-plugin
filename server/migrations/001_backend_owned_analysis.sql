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

DROP INDEX IF EXISTS review_source_versions_source_version_uidx;

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

DROP INDEX IF EXISTS review_records_identity_uidx;
DROP INDEX IF EXISTS review_records_source_idx;

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

UPDATE sync_jobs
SET source_key_hash = encode(digest(
  '{' || (
    SELECT COALESCE(string_agg(to_json(field_mapping.key)::text || ':' || to_json(field_mapping.value)::text, ',' ORDER BY field_mapping.key), '')
    FROM jsonb_each_text(field_mapping_json) AS field_mapping(key, value)
  ) || '}',
  'sha256'
), 'hex')
;

DROP INDEX IF EXISTS sync_jobs_active_source_trigger_uidx;

CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_active_source_trigger_uidx
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
