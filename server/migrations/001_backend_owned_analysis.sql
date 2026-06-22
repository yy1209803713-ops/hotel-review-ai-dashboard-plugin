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

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  base_user_id text NOT NULL,
  plugin_instance_id text NOT NULL,
  config_id uuid NOT NULL REFERENCES analysis_configs(id),
  scope_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'success', 'failed', 'canceled')),
  stage text NOT NULL,
  progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
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

CREATE TABLE IF NOT EXISTS review_source_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  version text NOT NULL,
  record_count integer NOT NULL,
  content_hash text NOT NULL,
  generated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS review_source_versions_source_version_uidx
  ON review_source_versions (tenant_key, source_kind, source_id, version);

CREATE TABLE IF NOT EXISTS analysis_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  base_user_id text NOT NULL,
  plugin_instance_id text NOT NULL,
  config_id uuid NOT NULL REFERENCES analysis_configs(id),
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

CREATE UNIQUE INDEX IF NOT EXISTS review_records_identity_uidx
  ON review_records (tenant_key, source_kind, source_id, record_id);

CREATE INDEX IF NOT EXISTS review_records_source_idx
  ON review_records (tenant_key, source_kind, source_id, is_deleted, synced_at DESC);

CREATE TABLE IF NOT EXISTS sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_key text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
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
