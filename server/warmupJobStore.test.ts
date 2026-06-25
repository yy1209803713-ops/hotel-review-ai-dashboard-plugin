import { describe, expect, it } from 'vitest';
import { createInMemoryWarmupJobStore, createPostgresWarmupJobStore, type WarmupJob } from './warmupJobStore';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY } from './reviewSync';

describe('createInMemoryWarmupJobStore', () => {
  it('records warmup request, accepted response, final result, and cache statistics', async () => {
    const store = createInMemoryWarmupJobStore();

    const queued = await store.createWarmupJob({
      sourceKey: {
        tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
        sourceKind: 'feishu_base',
        sourceId: 'base-token-a:tbl-review',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
      },
      mode: 'incremental',
      triggerType: 'manual_api',
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
      },
      acceptedResponse: {
        jobId: 'pending',
        status: 'accepted',
        mode: 'incremental',
        summary: emptySummary(),
        errors: [],
      },
      createdAt: '2026-06-25T08:00:00.000Z',
    });

    expect(queued).toMatchObject({
      jobId: 'warmup-job-1',
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceKind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review',
      mode: 'incremental',
      triggerType: 'manual_api',
      status: 'queued',
      stage: 'queued',
      reviewStartDate: '2026-06-01',
      reviewEndDate: '2026-06-30',
      recordsScanned: 0,
    });
    expect(queued.request).toMatchObject({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
    });
    expect(queued.acceptedResponse).toMatchObject({ status: 'accepted' });

    const claimed = await store.claimWarmupJob(queued.jobId, '2026-06-25T08:00:01.000Z');
    expect(claimed).toMatchObject({
      status: 'running',
      stage: 'read_reviews',
      startedAt: '2026-06-25T08:00:01.000Z',
    });

    const completed = await store.completeWarmupJob({
      job: claimed as WarmupJob,
      result: {
        jobId: queued.jobId,
        status: 'success',
        mode: 'incremental',
        summary: {
          recordsScanned: 3,
          totalReviews: 2,
          evidenceCacheHits: 1,
          evidenceCacheMisses: 1,
          evidenceRecordsSaved: 1,
          topicMappingHits: 1,
          topicMappingMisses: 1,
          topicMappingsSaved: 1,
          evidenceCacheInserts: 1,
          evidenceCacheUpdates: 0,
          topicMappingCacheInserts: 0,
          topicMappingCacheUpdates: 1,
        },
        errors: [],
      },
      finishedAt: '2026-06-25T08:00:03.000Z',
    });

    expect(completed).toMatchObject({
      status: 'success',
      stage: 'success',
      recordsScanned: 3,
      evidenceCacheHits: 1,
      evidenceCacheMisses: 1,
      evidenceCacheInserts: 1,
      evidenceCacheUpdates: 0,
      topicMappingCacheHits: 1,
      topicMappingCacheMisses: 1,
      topicMappingCacheInserts: 0,
      topicMappingCacheUpdates: 1,
      durationMs: 2000,
      finishedAt: '2026-06-25T08:00:03.000Z',
    });
    expect(completed.result).toMatchObject({ status: 'success' });
  });

  it('persists the accepted response with the real Postgres-generated job id', async () => {
    const client = new RecordingPostgresClient();
    const store = createPostgresWarmupJobStore(client);

    const job = await store.createWarmupJob({
      sourceKey: {
        tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
        sourceKind: 'feishu_base',
        sourceId: 'base-token-a:tbl-review',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
      },
      mode: 'incremental',
      triggerType: 'manual_api',
      request: {
        mode: 'incremental',
        source: 'manual',
        baseToken: 'base-token-a',
        tableId: 'tbl-review',
      },
      acceptedResponse: {
        jobId: 'pending',
        status: 'accepted',
        mode: 'incremental',
        summary: emptySummary(),
        errors: [],
      },
      createdAt: '2026-06-25T08:00:00.000Z',
    });

    expect(client.sqlLog.join('\n')).toContain("jsonb_set($9::jsonb, '{jobId}'");
    expect(job).toMatchObject({
      jobId: '11111111-1111-4111-8111-111111111111',
      acceptedResponse: {
        jobId: '11111111-1111-4111-8111-111111111111',
        status: 'accepted',
      },
    });
  });
});

function emptySummary() {
  return {
    recordsScanned: 0,
    totalReviews: 0,
    evidenceCacheHits: 0,
    evidenceCacheMisses: 0,
    evidenceRecordsSaved: 0,
    topicMappingHits: 0,
    topicMappingMisses: 0,
    topicMappingsSaved: 0,
    evidenceCacheInserts: 0,
    evidenceCacheUpdates: 0,
    topicMappingCacheInserts: 0,
    topicMappingCacheUpdates: 0,
  };
}

class RecordingPostgresClient {
  readonly sqlLog: string[] = [];

  async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    this.sqlLog.push(text.trim().replace(/\s+/g, ' '));
    return {
      rows: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          tenant_key: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
          source_kind: 'feishu_base',
          source_id: 'base-token-a:tbl-review',
          base_token: 'base-token-a',
          table_id: 'tbl-review',
          mode: 'incremental',
          trigger_type: 'manual_api',
          status: 'queued',
          stage: 'queued',
          request_json: {
            mode: 'incremental',
            source: 'manual',
            baseToken: 'base-token-a',
            tableId: 'tbl-review',
          },
          accepted_response_json: {
            jobId: '11111111-1111-4111-8111-111111111111',
            status: 'accepted',
            mode: 'incremental',
            summary: emptySummary(),
            errors: [],
          },
          result_json: {},
          review_start_date: null,
          review_end_date: null,
          records_scanned: 0,
          evidence_cache_hits: 0,
          evidence_cache_misses: 0,
          evidence_cache_inserts: 0,
          evidence_cache_updates: 0,
          topic_mapping_cache_hits: 0,
          topic_mapping_cache_misses: 0,
          topic_mapping_cache_inserts: 0,
          topic_mapping_cache_updates: 0,
          error_stage: null,
          error_message: null,
          started_at: null,
          finished_at: null,
          duration_ms: null,
          created_at: new Date('2026-06-25T08:00:00.000Z'),
          updated_at: new Date('2026-06-25T08:00:00.000Z'),
        },
      ] as T[],
    };
  }
}
