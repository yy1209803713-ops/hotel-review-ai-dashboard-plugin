import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVIDENCE_CACHE_EXTRACTOR_VERSION,
  TOPIC_MAPPING_CACHE_VERSION,
  createPostgresAnalysisCacheRepository,
} from './postgresAnalysisCache';

const migrationSql = readFileSync(resolve('server/migrations/001_backend_owned_analysis.sql'), 'utf8');
const databaseUrl = process.env.DATABASE_URL?.trim();
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase('createPostgresAnalysisCacheRepository', () => {
  let pool: Pool | undefined;

  afterEach(async () => {
    await pool?.end();
    pool = undefined;
  });

  it('upserts evidence cache by identity and updates last_used_at on reads', async () => {
    const { pool: testPool, cleanup } = await createIsolatedPool();
    pool = testPool;
    try {
      const repository = createPostgresAnalysisCacheRepository(pool);
      await repository.saveEvidenceCacheEntries({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        records: [review('rec-1', '位置很好')],
        evidenceItems: [
          {
            recordId: 'rec-1',
            quote: '位置很好',
            sentiment: 'positive',
            aspectLabel: '位置',
          },
        ],
        now: '2026-06-24T01:00:00.000Z',
      });
      await repository.saveEvidenceCacheEntries({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        records: [review('rec-1', '位置很好')],
        evidenceItems: [
          {
            recordId: 'rec-1',
            quote: '位置很好',
            sentiment: 'positive',
            aspectLabel: '位置',
            reason: '覆盖写入',
          },
        ],
        now: '2026-06-24T02:00:00.000Z',
      });

      const cache = await repository.readEvidenceCache({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        records: [review('rec-1', '位置很好'), review('rec-2', '服务很好')],
        now: '2026-06-24T03:00:00.000Z',
      });

      expect(cache.hits).toHaveLength(1);
      expect(cache.hits[0]).toMatchObject({
        record: { recordId: 'rec-1' },
        evidenceItems: [
          {
            recordId: 'rec-1',
            quote: '位置很好',
            reason: '覆盖写入',
          },
        ],
      });
      expect(cache.misses.map((record) => record.recordId)).toEqual(['rec-2']);

      const { rows } = await pool.query<{
        count: string;
        last_used_at: Date | string | null;
        extractor_version: string;
      }>(
        `select count(*)::text as count, max(last_used_at) as last_used_at, max(extractor_version) as extractor_version
        from evidence_cache
        where tenant_key = 'tenant-a' and source_record_id = 'rec-1'`,
      );
      expect(rows[0]).toMatchObject({
        count: '1',
        extractor_version: EVIDENCE_CACHE_EXTRACTOR_VERSION,
      });
      expect(toIsoString(rows[0].last_used_at)).toBe('2026-06-24T03:00:00.000Z');
    } finally {
      await cleanup();
    }
  });

  it('upserts topic mapping cache by identity and updates last_used_at on reads', async () => {
    const { pool: testPool, cleanup } = await createIsolatedPool();
    pool = testPool;
    try {
      const repository = createPostgresAnalysisCacheRepository(pool);
      const candidate = {
        id: 'candidate-1',
        sourceLabel: ' 位置，便利 ',
        sentiment: 'positive' as const,
        count: 2,
        quotes: ['位置很好', '出行方便'],
      };
      const firstGroup = {
        mergeKey: '位置优势',
        category: '位置',
        displayTopic: '位置方便',
        summary: '位置相关评论证据。',
        sentiment: 'positive' as const,
        members: [
          {
            candidateId: candidate.id,
            sourceLabel: candidate.sourceLabel,
            acceptedQuotes: ['位置很好'],
          },
        ],
      };
      const secondGroup = {
        ...firstGroup,
        summary: '覆盖后的主题摘要。',
      };

      await repository.saveTopicMappingCacheEntries({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        candidates: [candidate],
        groups: [firstGroup],
        now: '2026-06-24T01:00:00.000Z',
      });
      await repository.saveTopicMappingCacheEntries({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        candidates: [candidate],
        groups: [secondGroup],
        now: '2026-06-24T02:00:00.000Z',
      });

      const cache = await repository.readTopicMappingCache({
        tenantKey: 'tenant-a',
        sourceKind: 'feishu_base',
        sourceId: 'base-a:tbl-review:vew-active',
        tableId: 'tbl-review',
        model: 'qwen-plus',
        candidates: [
          { ...candidate, id: 'candidate-rerun' },
          {
            id: 'candidate-miss',
            sourceLabel: '服务',
            sentiment: 'positive',
            count: 1,
            quotes: ['服务热情'],
          },
        ],
        now: '2026-06-24T03:00:00.000Z',
      });

      expect(cache.hits).toHaveLength(1);
      expect(cache.hits[0]).toMatchObject({
        candidate: { id: 'candidate-rerun' },
        mapping: {
          sourceLabel: ' 位置，便利 ',
          mergeKey: '位置优势',
          summary: '覆盖后的主题摘要。',
          acceptedQuotes: ['位置很好'],
        },
      });
      expect(cache.misses.map((candidate) => candidate.id)).toEqual(['candidate-miss']);

      const { rows } = await pool.query<{
        count: string;
        last_used_at: Date | string | null;
        mapping_version: string;
      }>(
        `select count(*)::text as count, max(last_used_at) as last_used_at, max(mapping_version) as mapping_version
        from topic_mapping_cache
        where tenant_key = 'tenant-a' and sentiment = 'positive' and normalized_source_label = '位置便利'`,
      );
      expect(rows[0]).toMatchObject({
        count: '1',
        mapping_version: TOPIC_MAPPING_CACHE_VERSION,
      });
      expect(toIsoString(rows[0].last_used_at)).toBe('2026-06-24T03:00:00.000Z');
    } finally {
      await cleanup();
    }
  });
});

async function createIsolatedPool(): Promise<{ pool: Pool; cleanup: () => Promise<void> }> {
  const schemaName = `postgres_analysis_cache_${randomUUID().replace(/-/g, '_')}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schemaName},public`,
  });
  await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(schemaName)}`);
  await pool.query(migrationSql);
  return {
    pool,
    async cleanup() {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schemaName)} CASCADE`);
      await adminPool.end();
    },
  };
}

function review(recordId: string, content: string) {
  return {
    recordId,
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-15 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toIsoString(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}
