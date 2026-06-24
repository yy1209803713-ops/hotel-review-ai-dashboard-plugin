import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve('server/migrations/001_backend_owned_analysis.sql');
const migrationSql = readFileSync(migrationPath, 'utf8');
const syncJobsActiveIndexMigrationPath = resolve('server/migrations/002_sync_jobs_active_source_trigger_index.sql');
const syncJobsActiveIndexMigrationSql = readFileSync(syncJobsActiveIndexMigrationPath, 'utf8');

describe('backend owned migration', () => {
  it('contains explicit legacy sync_jobs upgrade statements', () => {
    expect(migrationSql).toContain('ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS base_token text;');
    expect(migrationSql).toContain('ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS table_id text;');
    expect(migrationSql).toContain('ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS view_id text;');
    expect(migrationSql).toContain(
      "ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS field_mapping_json jsonb NOT NULL DEFAULT '{}'::jsonb;",
    );
    expect(migrationSql).toContain("ALTER TABLE sync_jobs ADD COLUMN IF NOT EXISTS source_key_hash text NOT NULL DEFAULT '';");
    expect(migrationSql).toContain("to_regclass(current_schema() || '.sync_jobs_active_source_trigger_uidx')");
    expect(migrationSql).toContain("to_regclass(current_schema() || '.review_source_versions_source_version_uidx')");
    expect(migrationSql).toContain("to_regclass(current_schema() || '.review_records_identity_uidx')");
    expect(migrationSql).toContain("to_regclass(current_schema() || '.review_records_source_idx')");
    expect(migrationSql).toContain("DROP INDEX %I.%I");
    expect(migrationSql).not.toContain('DROP INDEX IF EXISTS sync_jobs_active_source_trigger_uidx;');
    expect(migrationSql).not.toContain('DROP INDEX IF EXISTS review_source_versions_source_version_uidx;');
    expect(migrationSql).not.toContain('DROP INDEX IF EXISTS review_records_identity_uidx;');
    expect(migrationSql).not.toContain('DROP INDEX IF EXISTS review_records_source_idx;');
    expect(migrationSql).not.toContain('jsonb_pretty(field_mapping_json)');
    expect(migrationSql).toContain("COALESCE(string_agg(to_json(field_mapping.key)::text || ':' || to_json(field_mapping.value)::text, ',' ORDER BY field_mapping.key), '')");
    expect(migrationSql).toMatch(/ON sync_jobs \(tenant_key, source_kind, source_id, trigger_type, source_key_hash\)/);
    expect(migrationSql).toMatch(/ON review_records \(tenant_key, source_kind, source_id, source_key_hash, record_id\)/);
    expect(migrationSql).toMatch(/ON review_source_versions \(tenant_key, source_kind, source_id, source_key_hash, version\)/);
    expect(migrationSql).toMatch(/DROP CONSTRAINT IF EXISTS sync_jobs_status_check/);
    expect(migrationSql).toMatch(/status IN \('queued', 'running', 'success', 'failed', 'canceled'\)/);
    expect(migrationSql).toMatch(/UPDATE sync_jobs\s+SET status = CASE/);
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX sync_jobs_active_source_trigger_uidx/);
    expect(migrationSql).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_active_source_trigger_uidx/);
  });

  it('keeps a standalone migration for the active sync job unique index', () => {
    expect(syncJobsActiveIndexMigrationSql).toContain(
      "to_regclass(current_schema() || '.sync_jobs_active_source_trigger_uidx')",
    );
    expect(syncJobsActiveIndexMigrationSql).toContain("DROP INDEX %I.%I");
    expect(syncJobsActiveIndexMigrationSql).not.toContain('DROP INDEX IF EXISTS sync_jobs_active_source_trigger_uidx;');
    expect(syncJobsActiveIndexMigrationSql).toMatch(/CREATE UNIQUE INDEX sync_jobs_active_source_trigger_uidx/);
    expect(syncJobsActiveIndexMigrationSql).not.toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_active_source_trigger_uidx/);
    expect(syncJobsActiveIndexMigrationSql).toMatch(
      /ON sync_jobs \(tenant_key, source_kind, source_id, trigger_type, source_key_hash\)/,
    );
    expect(syncJobsActiveIndexMigrationSql).toMatch(/WHERE status IN \('queued', 'running'\)/);
  });

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    it.skip('applies the migration to a legacy sync_jobs schema when DATABASE_URL is available', () => {});
    it.skip('backfills non-empty legacy field mapping hashes with the runtime compact JSON hash when DATABASE_URL is available', () => {});
    it.skip('does not drop same-named sync job indexes from later search_path schemas when DATABASE_URL is available', () => {});
    it.skip('does not drop same-named review read-model indexes from later search_path schemas when DATABASE_URL is available', () => {});
    it.skip('standalone sync job index migration does not drop same-named indexes from later search_path schemas when DATABASE_URL is available', () => {});
    it.skip('recreates drifted active sync job unique index for runtime ON CONFLICT when DATABASE_URL is available', () => {});
  } else {
    it('applies the migration to a legacy sync_jobs schema when DATABASE_URL is available', async () => {
    const schemaName = `backend_owned_migration_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
      await client.query(`
        CREATE TABLE sync_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          trigger_type text NOT NULL CHECK (trigger_type IN ('event', 'schedule', 'manual', 'analysis_preflight')),
          status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'cancelled', 'failed')),
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
        )
      `);
      await client.query(`
        INSERT INTO sync_jobs (tenant_key, source_kind, source_id, trigger_type, status, stage, records_read, records_upserted, records_deleted)
        VALUES
          ('tenant-a', 'feishu_base', 'base-token-a:tbl-review:vew-active', 'event', 'succeeded', 'done', 3, 3, 0),
          ('tenant-a', 'feishu_base', 'base-token-a:tbl-review:vew-active', 'manual', 'cancelled', 'failed', 1, 0, 0)
      `);

      await client.query(migrationSql);

      await expectColumnExists(client, schemaName, 'sync_jobs', 'base_token', 'text');
      await expectColumnExists(client, schemaName, 'sync_jobs', 'table_id', 'text');
      await expectColumnExists(client, schemaName, 'sync_jobs', 'view_id', 'text');
      await expectColumnExists(client, schemaName, 'sync_jobs', 'field_mapping_json', 'jsonb');
      await expectColumnExists(client, schemaName, 'sync_jobs', 'source_key_hash', 'text');

      const rows = await client.query<{
        trigger_type: string;
        status: string;
        base_token: string | null;
        table_id: string | null;
        view_id: string | null;
        field_mapping_json: Record<string, unknown> | null;
        source_key_hash: string;
      }>(
        `
          SELECT trigger_type, status, base_token, table_id, view_id, field_mapping_json, source_key_hash
          FROM sync_jobs
          ORDER BY trigger_type
        `,
      );
      const expectedEmptyFieldMappingHash = hashFieldMapping({});

      expect(rows.rows).toEqual([
        {
          trigger_type: 'event',
          status: 'success',
          base_token: null,
          table_id: null,
          view_id: null,
          field_mapping_json: {},
          source_key_hash: expectedEmptyFieldMappingHash,
        },
        {
          trigger_type: 'manual',
          status: 'canceled',
          base_token: null,
          table_id: null,
          view_id: null,
          field_mapping_json: {},
          source_key_hash: expectedEmptyFieldMappingHash,
        },
      ]);

      await client.query(`INSERT INTO sync_jobs (
        tenant_key,
        source_kind,
        source_id,
        base_token,
        table_id,
        view_id,
        field_mapping_json,
        source_key_hash,
        trigger_type,
        status,
        stage
      ) VALUES (
        'tenant-a',
        'feishu_base',
        'base-token-a:tbl-review:vew-active',
        'base-token-a',
        'tbl-review',
        'vew-active',
        '{}'::jsonb,
        '${expectedEmptyFieldMappingHash}',
        'event',
        'success',
        'queued'
      )`);
      await client.query(`INSERT INTO sync_jobs (
        tenant_key,
        source_kind,
        source_id,
        base_token,
        table_id,
        view_id,
        field_mapping_json,
        source_key_hash,
        trigger_type,
        status,
        stage
      ) VALUES (
        'tenant-a',
        'feishu_base',
        'base-token-a:tbl-review:vew-active',
        'base-token-a',
        'tbl-review',
        'vew-active',
        '{}'::jsonb,
        '${expectedEmptyFieldMappingHash}',
        'manual',
        'canceled',
        'queued'
      )`);

      await client.query(migrationSql);
      await client.query(`SELECT 1 FROM sync_jobs WHERE status IN ('success', 'canceled') LIMIT 1`);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await client.end();
    }
    });

    it('does not drop same-named sync job indexes from later search_path schemas', async () => {
    const outerSchemaName = `backend_owned_outer_${randomUUID().replace(/-/g, '_')}`;
    const migrationSchemaName = `backend_owned_migration_isolation_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(outerSchemaName)}`);
      await client.query(`CREATE SCHEMA ${quoteIdentifier(migrationSchemaName)}`);
      await client.query(`
        CREATE TABLE ${quoteIdentifier(outerSchemaName)}.sync_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          trigger_type text NOT NULL,
          status text NOT NULL,
          stage text NOT NULL,
          records_read integer NOT NULL DEFAULT 0,
          records_upserted integer NOT NULL DEFAULT 0,
          records_deleted integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX sync_jobs_active_source_trigger_uidx
          ON ${quoteIdentifier(outerSchemaName)}.sync_jobs (tenant_key, source_kind, source_id, trigger_type)
          WHERE status IN ('queued', 'running')
      `);
      await client.query(
        `SET search_path TO ${quoteIdentifier(migrationSchemaName)}, ${quoteIdentifier(outerSchemaName)}, public`,
      );

      await client.query(migrationSql);

      const indexes = await client.query<{ indexdef: string }>(
        `
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = $1
            AND tablename = 'sync_jobs'
            AND indexname = 'sync_jobs_active_source_trigger_uidx'
        `,
        [outerSchemaName],
      );

      expect(indexes.rows).toHaveLength(1);
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(migrationSchemaName)} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(outerSchemaName)} CASCADE`);
      await client.end();
    }
    });

    it('does not drop same-named review read-model indexes from later search_path schemas', async () => {
    const outerSchemaName = `bo_outer_review_${randomUUID().replace(/-/g, '_')}`;
    const migrationSchemaName = `bo_review_iso_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(outerSchemaName)}`);
      await client.query(`CREATE SCHEMA ${quoteIdentifier(migrationSchemaName)}`);
      await client.query(`
        CREATE TABLE ${quoteIdentifier(outerSchemaName)}.review_source_versions (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          source_key_hash text NOT NULL DEFAULT '',
          version text NOT NULL,
          record_count integer NOT NULL,
          content_hash text NOT NULL,
          generated_at timestamptz NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX review_source_versions_source_version_uidx
          ON ${quoteIdentifier(outerSchemaName)}.review_source_versions
          (tenant_key, source_kind, source_id, source_key_hash, version)
      `);
      await client.query(`
        CREATE TABLE ${quoteIdentifier(outerSchemaName)}.review_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          source_key_hash text NOT NULL DEFAULT '',
          record_id text NOT NULL,
          is_deleted boolean NOT NULL DEFAULT false,
          synced_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX review_records_identity_uidx
          ON ${quoteIdentifier(outerSchemaName)}.review_records
          (tenant_key, source_kind, source_id, source_key_hash, record_id)
      `);
      await client.query(`
        CREATE INDEX review_records_source_idx
          ON ${quoteIdentifier(outerSchemaName)}.review_records
          (tenant_key, source_kind, source_id, source_key_hash, is_deleted, synced_at DESC)
      `);
      await client.query(
        `SET search_path TO ${quoteIdentifier(migrationSchemaName)}, ${quoteIdentifier(outerSchemaName)}, public`,
      );

      await client.query(migrationSql);

      const indexes = await client.query<{ indexname: string }>(
        `
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = $1
            AND indexname IN (
              'review_source_versions_source_version_uidx',
              'review_records_identity_uidx',
              'review_records_source_idx'
            )
          ORDER BY indexname
        `,
        [outerSchemaName],
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'review_records_identity_uidx',
        'review_records_source_idx',
        'review_source_versions_source_version_uidx',
      ]);
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(migrationSchemaName)} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(outerSchemaName)} CASCADE`);
      await client.end();
    }
    });

    it('backfills non-empty legacy field mapping hashes with the runtime compact JSON hash', async () => {
    const schemaName = `backend_owned_mapping_hash_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
      await client.query(`
        CREATE TABLE sync_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
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
        )
      `);
      await client.query(
        `
          INSERT INTO sync_jobs (
            tenant_key, source_kind, source_id, field_mapping_json, source_key_hash,
            trigger_type, status, stage
          )
          VALUES (
            'tenant-a', 'feishu_base', 'base-token-a:tbl-review:vew-active',
            $1::jsonb, $2, 'manual', 'queued', 'queued'
          )
        `,
        [
          JSON.stringify({ rating: 'fld-rating', content: 'fld-review', hotelName: 'fld-hotel' }),
          createHash('sha256')
            .update('{\n    "content": "fld-review",\n    "hotelName": "fld-hotel",\n    "rating": "fld-rating"\n}')
            .digest('hex'),
        ],
      );

      await client.query(migrationSql);

      const rows = await client.query<{ source_key_hash: string }>('SELECT source_key_hash FROM sync_jobs');
      expect(rows.rows).toEqual([
        {
          source_key_hash: hashFieldMapping({
            content: 'fld-review',
            hotelName: 'fld-hotel',
            rating: 'fld-rating',
          }),
        },
      ]);
      expect(rows.rows[0].source_key_hash).not.toBe(
        createHash('sha256')
          .update(JSON.stringify({ content: 'fld-review', hotelName: 'fld-hotel', rating: 'fld-rating' }, null, 4))
          .digest('hex'),
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await client.end();
    }
    });

    it('standalone sync job index migration does not drop same-named indexes from later search_path schemas', async () => {
    const outerSchemaName = `bo_outer_${randomUUID().replace(/-/g, '_')}`;
    const migrationSchemaName = `bo_idx_iso_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(outerSchemaName)}`);
      await client.query(`CREATE SCHEMA ${quoteIdentifier(migrationSchemaName)}`);
      await client.query(`
        CREATE TABLE ${quoteIdentifier(outerSchemaName)}.sync_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          trigger_type text NOT NULL,
          status text NOT NULL,
          source_key_hash text NOT NULL DEFAULT '',
          stage text NOT NULL
        )
      `);
      await client.query(`
        CREATE INDEX sync_jobs_active_source_trigger_uidx
          ON ${quoteIdentifier(outerSchemaName)}.sync_jobs (tenant_key, source_kind, source_id, trigger_type)
          WHERE status IN ('queued', 'running')
      `);
      await client.query(`
        CREATE TABLE ${quoteIdentifier(migrationSchemaName)}.sync_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_key text NOT NULL,
          source_kind text NOT NULL,
          source_id text NOT NULL,
          trigger_type text NOT NULL,
          status text NOT NULL,
          source_key_hash text NOT NULL DEFAULT '',
          stage text NOT NULL
        )
      `);
      await client.query(
        `SET search_path TO ${quoteIdentifier(migrationSchemaName)}, ${quoteIdentifier(outerSchemaName)}, public`,
      );

      await client.query(syncJobsActiveIndexMigrationSql);

      const indexes = await client.query<{ schemaname: string; indexdef: string }>(
        `
          SELECT schemaname, indexdef
          FROM pg_indexes
          WHERE tablename = 'sync_jobs'
            AND indexname = 'sync_jobs_active_source_trigger_uidx'
            AND schemaname IN ($1, $2)
          ORDER BY schemaname
        `,
        [outerSchemaName, migrationSchemaName],
      );

      expect(indexes.rows).toHaveLength(2);
      expect(indexes.rows.map((row) => row.schemaname).sort()).toEqual([migrationSchemaName, outerSchemaName].sort());
    } finally {
      await client.query('RESET search_path');
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(migrationSchemaName)} CASCADE`);
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(outerSchemaName)} CASCADE`);
      await client.end();
    }
    });

    it('recreates drifted active sync job unique index for runtime ON CONFLICT', async () => {
    const schemaName = `backend_owned_sync_jobs_index_${randomUUID().replace(/-/g, '_')}`;
    const client = new Client({ connectionString: databaseUrl });

    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await client.query(`SET search_path TO ${quoteIdentifier(schemaName)}, public`);
      await client.query(`
        CREATE TABLE sync_jobs (
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
        )
      `);
      await client.query(`
        CREATE INDEX sync_jobs_active_source_trigger_uidx
          ON sync_jobs (tenant_key, source_kind, source_id, trigger_type)
          WHERE status IN ('queued', 'running')
      `);

      await client.query(syncJobsActiveIndexMigrationSql);

      const indexes = await client.query<{ indexdef: string }>(
        `
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = $1
            AND tablename = 'sync_jobs'
            AND indexname = 'sync_jobs_active_source_trigger_uidx'
        `,
        [schemaName],
      );

      expect(indexes.rows).toHaveLength(1);
      expect(indexes.rows[0].indexdef).toContain(
        '(tenant_key, source_kind, source_id, trigger_type, source_key_hash)',
      );

      await client.query(`
        INSERT INTO sync_jobs (
          tenant_key,
          source_kind,
          source_id,
          base_token,
          table_id,
          view_id,
          field_mapping_json,
          source_key_hash,
          trigger_type,
          status,
          stage,
          records_read,
          records_upserted,
          records_deleted
        ) VALUES (
          'tenant-a',
          'feishu_base',
          'base-token-a:tbl-review:vew-active',
          'base-token-a',
          'tbl-review',
          'vew-active',
          '{}'::jsonb,
          '${hashFieldMapping({})}',
          'analysis_preflight',
          'queued',
          'queued',
          0,
          0,
          0
        )
        ON CONFLICT (tenant_key, source_kind, source_id, trigger_type, source_key_hash)
          WHERE status IN ('queued', 'running')
        DO UPDATE SET updated_at = sync_jobs.updated_at
        RETURNING *
      `);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await client.end();
    }
    });
  }
});

function hashFieldMapping(fieldMapping: Record<string, string>): string {
  const compactJson = JSON.stringify(
    Object.entries(fieldMapping)
      .sort(([left], [right]) => left.localeCompare(right))
      .reduce<Record<string, string>>((result, [key, value]) => {
        result[key] = value;
        return result;
      }, {}),
  );
  return createHash('sha256').update(compactJson).digest('hex');
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function expectColumnExists(
  client: Client,
  schema: string,
  table: string,
  column: string,
  dataType: string,
): Promise<void> {
  const result = await client.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
  }>(
    `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND column_name = $3
    `,
    [schema, table, column],
  );

  expect(result.rows).toHaveLength(1);
  if (dataType === 'jsonb') {
    expect(result.rows[0].udt_name).toBe('jsonb');
    return;
  }
  expect(result.rows[0].data_type).toBe(dataType);
}
