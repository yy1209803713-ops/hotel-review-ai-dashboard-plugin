DO $$
BEGIN
  IF to_regclass(current_schema() || '.sync_jobs_active_source_trigger_uidx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'sync_jobs_active_source_trigger_uidx');
  END IF;
END $$;

ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'full';

ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_trigger_type_check;
ALTER TABLE sync_jobs DROP CONSTRAINT IF EXISTS sync_jobs_mode_check;

UPDATE sync_jobs
SET trigger_type = 'manual_api'
WHERE trigger_type <> 'manual_api';

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_trigger_type_check
  CHECK (trigger_type IN ('manual_api'));

ALTER TABLE sync_jobs
  ADD CONSTRAINT sync_jobs_mode_check
  CHECK (mode IN ('full', 'incremental'));

CREATE UNIQUE INDEX sync_jobs_active_source_trigger_uidx
  ON sync_jobs (tenant_key, source_kind, source_id, mode)
  WHERE status IN ('queued', 'running');
