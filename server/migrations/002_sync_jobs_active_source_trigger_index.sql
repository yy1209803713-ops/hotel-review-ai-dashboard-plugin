DO $$
BEGIN
  IF to_regclass(current_schema() || '.sync_jobs_active_source_trigger_uidx') IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', current_schema(), 'sync_jobs_active_source_trigger_uidx');
  END IF;
END $$;

CREATE UNIQUE INDEX sync_jobs_active_source_trigger_uidx
  ON sync_jobs (tenant_key, source_kind, source_id, trigger_type, source_key_hash)
  WHERE status IN ('queued', 'running');
