import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKEND_ANALYSIS_PIPELINE_VERSION, type BackendAnalysisConfigUpsertRequest } from './backendAnalysis';
import { createPostgresAnalysisBackendStore } from './postgresAnalysisStore';

const migrationSql = readFileSync(resolve('server/migrations/001_backend_owned_analysis.sql'), 'utf8');

const baseConfigRequest: BackendAnalysisConfigUpsertRequest = {
  tenantKey: 'tenant-a',
  baseUserId: 'user-a',
  pluginInstanceId: 'plugin-a',
  baseToken: 'base-token-a',
  model: 'qwen-plus',
  source: {
    kind: 'postgres',
    sourceId: 'base-token-a:tbl-review',
    upstreamSourceKind: 'feishu_base',
    tableId: 'tbl-review',
    viewId: 'vew-active',
    fieldMapping: {
      content: 'fld-review',
      rating: 'fld-rating',
      hotelName: 'fld-hotel',
    },
  },
  filters: {
    periodType: 'month',
    startDate: '2026-05-24',
    endDate: '2026-06-24',
  },
  dashboardDataConditions: {
    groups: [{ fieldId: 'fld-review' }],
  },
};

const databaseUrl = process.env.DATABASE_URL?.trim();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('createPostgresAnalysisBackendStore', () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it('persists configs, jobs, published results, and topic evidence in Postgres', async () => {
    const schemaName = `postgres_analysis_store_${randomUUID().replace(/-/g, '_')}`;
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName},public`,
    });
    const adminPool = new Pool({ connectionString: databaseUrl });

    try {
      await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
      await pool.query(migrationSql);

      const store = createPostgresAnalysisBackendStore(pool);
      const firstConfig = await store.upsertConfig(baseConfigRequest);
      const secondConfig = await store.upsertConfig({
        ...baseConfigRequest,
        filters: { ...baseConfigRequest.filters, hotelName: 'all' },
      });

      expect(firstConfig.configVersion).toBe(1);
      expect(secondConfig.configId).toBe(firstConfig.configId);
      expect(secondConfig.configVersion).toBe(2);
      await expect(store.getConfig(secondConfig.configId)).resolves.toMatchObject({
        configId: secondConfig.configId,
        configVersion: 2,
        source: {
          kind: 'postgres',
          sourceId: 'base-token-a:tbl-review',
        },
      });

      const job = await store.createJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: secondConfig.configId,
        configVersion: secondConfig.configVersion,
        scopeKey: 'scope-a',
        status: 'queued',
        stage: 'validate_request',
        progress: 0,
      });
      const claimed = await store.claimJob(job.jobId, '2026-06-24T01:00:00.000Z');
      expect(claimed).toMatchObject({
        jobId: job.jobId,
        status: 'running',
        stage: 'load_config',
      });

      const result = await store.saveResult({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: 'scope-a',
        jobId: job.jobId,
        configId: secondConfig.configId,
        configVersion: secondConfig.configVersion,
        sourceVersion: {
          kind: 'postgres',
          sourceId: 'base-token-a:tbl-review',
          version: 'source-v1',
          contentHash: 'content-hash-v1',
          generatedAt: '2026-06-24T01:00:01.000Z',
          recordCount: 2,
        },
        pipelineVersion: BACKEND_ANALYSIS_PIPELINE_VERSION,
        summary: {
          analysisId: 'analysis-a',
          generatedAt: '2026-06-24T01:00:02.000Z',
          model: 'qwen-plus',
          status: 'complete',
          overview: { totalReviews: 2 },
          positiveTopics: [],
          negativeTopics: [],
          actionItems: [],
          cacheDiagnostics: {
            triggered: true,
            layers: ['evidence_cache', 'topic_mapping_cache'],
            evidenceCache: {
              requested: 10,
              hits: 7,
              misses: 3,
              hitRate: 0.7,
            },
            topicMappingCache: {
              requested: 4,
              hits: 1,
              misses: 3,
              hitRate: 0.25,
            },
            aiTriggered: {
              evidenceExtraction: true,
              topicMapping: true,
            },
          },
        },
        topics: [{ topicId: 'topic-clean', label: '卫生' }],
      });
      const cacheDiagnosticsRows = await pool.query<{
        evidence_cache_requested: number;
        evidence_cache_hits: number;
        evidence_cache_misses: number;
        evidence_cache_hit_rate: number;
        topic_mapping_cache_requested: number;
        topic_mapping_cache_hits: number;
        topic_mapping_cache_misses: number;
        topic_mapping_cache_hit_rate: number;
        ai_called: boolean;
        ai_evidence_extraction_called: boolean;
        ai_topic_mapping_called: boolean;
      }>(
        `
          SELECT
            evidence_cache_requested,
            evidence_cache_hits,
            evidence_cache_misses,
            evidence_cache_hit_rate,
            topic_mapping_cache_requested,
            topic_mapping_cache_hits,
            topic_mapping_cache_misses,
            topic_mapping_cache_hit_rate,
            ai_called,
            ai_evidence_extraction_called,
            ai_topic_mapping_called
          FROM analysis_results
          WHERE id = $1
        `,
        [result.resultId],
      );
      expect(cacheDiagnosticsRows.rows).toEqual([
        {
          evidence_cache_requested: 10,
          evidence_cache_hits: 7,
          evidence_cache_misses: 3,
          evidence_cache_hit_rate: 0.7,
          topic_mapping_cache_requested: 4,
          topic_mapping_cache_hits: 1,
          topic_mapping_cache_misses: 3,
          topic_mapping_cache_hit_rate: 0.25,
          ai_called: true,
          ai_evidence_extraction_called: true,
          ai_topic_mapping_called: true,
        },
      ]);
      await store.saveEvidence(result.resultId, {
        'topic-clean': [
          { evidenceId: 'ev-1', recordId: 'rec-1', quote: '房间很干净', sentiment: 'positive' },
          { evidenceId: 'ev-2', recordId: 'rec-2', quote: '卫生不错', sentiment: 'positive' },
        ],
      });
      const finalized = await store.finalizeSuccessfulJob({ jobId: job.jobId, resultId: result.resultId });

      expect(finalized).toMatchObject({
        jobId: job.jobId,
        status: 'success',
        resultId: result.resultId,
      });
      await expect(
        store.getLatestResult({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          scopeKey: 'scope-a',
        }),
      ).resolves.toMatchObject({
        resultId: result.resultId,
        configVersion: 2,
        summary: {
          overview: { totalReviews: 2 },
        },
      });
      await expect(
        store.getTopicEvidence({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          scopeKey: 'scope-a',
          resultId: result.resultId,
          topicId: 'topic-clean',
          page: 2,
          pageSize: 1,
        }),
      ).resolves.toEqual({
        resultId: result.resultId,
        topicId: 'topic-clean',
        page: 2,
        pageSize: 1,
        total: 2,
        evidence: [{ evidenceId: 'ev-2', recordId: 'rec-2', quote: '卫生不错', sentiment: 'positive' }],
      });
    } finally {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    }
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
