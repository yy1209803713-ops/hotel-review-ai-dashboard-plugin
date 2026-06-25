import { describe, expect, it } from 'vitest';
import { createInMemoryReviewSyncStore, createPostgresReviewSyncStore } from './postgresReviewSyncStore';
import { PostgresReviewSource } from './postgresReviewSource';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY, ReviewSyncService, type ReviewSyncSourceKey } from './reviewSync';
import { handleReviewSyncRequest } from './syncHandler';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';
import type { SourceVersion } from './backendAnalysis';

const sourceKey: ReviewSyncSourceKey = {
  tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
  sourceKind: 'feishu_base',
  sourceId: 'base-token-a:tbl-review',
  baseToken: 'base-token-a',
  tableId: 'tbl-review',
  fieldMapping: {
    content: 'fld-review',
    rating: 'fld-rating',
    hotelName: 'fld-hotel',
  },
};

describe('ReviewSyncService and PostgresReviewSource', () => {
  it('seeds the global read model with full sync, applies incremental diffs, and records duration', async () => {
    const store = createInMemoryReviewSyncStore();
    const feishuSource = new MutableReviewSource([
      review('rec-1', 'Great view', 5),
      review('rec-2', 'Noisy room', 2),
    ]);
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: feishuSource },
      now: createClock([
        '2026-06-23T08:00:00.000Z',
        '2026-06-23T08:00:01.000Z',
        '2026-06-23T08:00:02.000Z',
        '2026-06-23T08:00:03.000Z',
        '2026-06-23T08:01:00.000Z',
        '2026-06-23T08:01:01.000Z',
        '2026-06-23T08:01:02.000Z',
        '2026-06-23T08:01:03.000Z',
        '2026-06-23T08:02:00.000Z',
        '2026-06-23T08:02:01.000Z',
        '2026-06-23T08:02:02.000Z',
        '2026-06-23T08:02:03.000Z',
      ]),
    });
    const postgresSource = new PostgresReviewSource({ store });

    const fullSync = await syncService.runFullSync(sourceKey);

    expect(fullSync).toMatchObject({
      status: 'success',
      mode: 'full',
      triggerType: 'manual_api',
      recordsRead: 2,
      recordsUpserted: 2,
      recordsDeleted: 0,
      recordsUnchanged: 0,
      durationMs: 59000,
    });
    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([
      review('rec-1', 'Great view', 5),
      review('rec-2', 'Noisy room', 2),
    ]);
    const firstVersion = await postgresSource.getSourceVersion(toQuery(sourceKey));
    expect(firstVersion).toMatchObject({
      kind: 'postgres',
      sourceId: 'base-token-a:tbl-review',
      recordCount: 2,
      generatedAt: '2026-06-23T08:01:00.000Z',
    });

    feishuSource.replace([
      review('rec-1', 'Great view after renovation', 5),
      review('rec-2', 'Noisy room', 2),
      review('rec-3', 'Kind staff', 5),
    ]);
    const incrementalJob = await syncService.runIncrementalSync(sourceKey);

    expect(incrementalJob).toMatchObject({
      status: 'success',
      mode: 'incremental',
      triggerType: 'manual_api',
      recordsRead: 3,
      recordsUpserted: 2,
      recordsDeleted: 0,
      recordsUnchanged: 1,
    });
    await expect(store.getReviewRecord(sourceKey, 'rec-1')).resolves.toMatchObject({
      recordId: 'rec-1',
      isDeleted: false,
      parsedReview: {
        content: 'Great view after renovation',
        rating: 5,
        hotelName: 'Hotel A',
      },
    });

    feishuSource.replace([review('rec-1', 'Great view after renovation', 5)]);
    await syncService.runIncrementalSync(sourceKey);

    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([
      review('rec-1', 'Great view after renovation', 5),
    ]);
    await expect(store.getReviewRecord(sourceKey, 'rec-2')).resolves.toMatchObject({
      recordId: 'rec-2',
      isDeleted: true,
    });
    const latestVersion = await postgresSource.getSourceVersion(toQuery(sourceKey));
    expect(latestVersion.recordCount).toBe(1);
    expect(latestVersion.version).not.toBe(firstVersion.version);
  });

  it('does not upsert existing records when only the raw content hash algorithm changes', async () => {
    const store = createInMemoryReviewSyncStore();
    const feishuSource = new MutableReviewSource([review('rec-1', 'Great view', 5, 'stable-hash')]);
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: feishuSource },
      now: createClock([
        '2026-06-23T08:00:00.000Z',
        '2026-06-23T08:00:01.000Z',
        '2026-06-23T08:00:02.000Z',
        '2026-06-23T08:00:03.000Z',
        '2026-06-23T08:01:00.000Z',
        '2026-06-23T08:01:01.000Z',
        '2026-06-23T08:01:02.000Z',
        '2026-06-23T08:01:03.000Z',
      ]),
    });

    await syncService.runFullSync(sourceKey);
    feishuSource.replace([review('rec-1', 'Great view', 5, 'new-stable-hash')]);

    const incrementalJob = await syncService.runIncrementalSync(sourceKey);

    expect(incrementalJob).toMatchObject({
      status: 'success',
      mode: 'incremental',
      recordsRead: 1,
      recordsUpserted: 0,
      recordsUnchanged: 1,
    });
    await expect(store.getReviewRecord(sourceKey, 'rec-1')).resolves.toMatchObject({
      contentHash: 'stable-hash',
      parsedReview: {
        content: 'Great view',
        rating: 5,
        hotelName: 'Hotel A',
      },
    });
  });

  it('enqueues full and incremental sync from HTTP receivers using global tenant and canonical source id', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([review('rec-1', 'Great view', 5)]) },
      now: createClock(['2026-06-23T08:00:00.000Z']),
    });
    const enqueued: Array<{ jobId: string; sourceKey: ReviewSyncSourceKey }> = [];

    const fullResponse = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/full', {
        method: 'POST',
        body: JSON.stringify({
          tenantKey: 'caller-tenant-must-be-ignored',
          baseToken: 'base-token-a',
          tableId: 'tbl-review',
          viewId: 'vew-active-must-not-enter-source-id',
          fieldMapping: sourceKey.fieldMapping,
        }),
      }),
      {
        service: syncService,
        onSyncJobCreated(jobId, enqueuedSourceKey) {
          enqueued.push({ jobId, sourceKey: enqueuedSourceKey });
        },
      },
    );

    await expect(fullResponse.json()).resolves.toMatchObject({
      jobId: 'sync-job-1',
      mode: 'full',
      status: 'queued',
      triggerType: 'manual_api',
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceId: 'base-token-a:tbl-review',
    });
    expect(fullResponse.status).toBe(202);
    expect(enqueued).toEqual([{ jobId: 'sync-job-1', sourceKey }]);
    await expect(store.listReviewRecords(sourceKey)).resolves.toEqual([]);

    const incrementalResponse = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/incremental', {
        method: 'POST',
        body: JSON.stringify({
          baseToken: 'base-token-a',
          tableId: 'tbl-review',
          fieldMapping: sourceKey.fieldMapping,
        }),
      }),
      {
        service: syncService,
        onSyncJobCreated(jobId, enqueuedSourceKey) {
          enqueued.push({ jobId, sourceKey: enqueuedSourceKey });
        },
      },
    );

    await expect(incrementalResponse.json()).resolves.toMatchObject({
      jobId: 'sync-job-2',
      mode: 'incremental',
      status: 'queued',
      triggerType: 'manual_api',
      tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
      sourceId: 'base-token-a:tbl-review',
    });
    expect(incrementalResponse.status).toBe(202);
    expect(enqueued[1]).toEqual({ jobId: 'sync-job-2', sourceKey });
  });

  it('removes Feishu record-changed HTTP receiver so events no longer enqueue sync jobs', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([review('rec-1', 'Great view', 5)]) },
    });
    const enqueued: Array<{ jobId: string; sourceKey: ReviewSyncSourceKey }> = [];

    const response = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/feishu/record-changed', {
        method: 'POST',
        body: JSON.stringify({ sourceKey, recordId: 'rec-1', operation: 'update' }),
      }),
      {
        service: syncService,
        onSyncJobCreated(jobId, enqueuedSourceKey) {
          enqueued.push({ jobId, sourceKey: enqueuedSourceKey });
        },
      },
    );

    await expect(response.json()).resolves.toEqual({ stage: 'validate_request', message: 'not found' });
    expect(response.status).toBe(404);
    expect(enqueued).toEqual([]);
    await expect(store.listReplayableSyncJobs(10)).resolves.toEqual([]);
  });

  it('responds to browser CORS preflight for sync endpoints', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
    });

    const response = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/full', { method: 'OPTIONS' }),
      { service: syncService },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
  });

  it('persists full sourceKey on jobs so queued jobs can be replayed after process restart', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([review('rec-1', 'Great view', 5)]) },
      now: createClock([
        '2026-06-23T08:00:00.000Z',
        '2026-06-23T08:00:01.000Z',
        '2026-06-23T08:00:02.000Z',
        '2026-06-23T08:00:03.000Z',
      ]),
    });

    const queued = await syncService.enqueueSyncJob(sourceKey, 'full', 'manual_api');

    expect(queued.sourceKey).toEqual(sourceKey);
    await expect(store.getSyncJob(queued.jobId)).resolves.toMatchObject({ sourceKey });
    await expect(store.listReplayableSyncJobs(10)).resolves.toEqual([expect.objectContaining({ jobId: queued.jobId, sourceKey })]);
    await expect(syncService.runQueuedSyncJob(queued.jobId)).resolves.toMatchObject({
      status: 'success',
      mode: 'full',
      recordsRead: 1,
    });
  });

  it('deduplicates active jobs for the same source and mode without hiding job stage or message', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
      now: createClock(['2026-06-23T08:00:00.000Z', '2026-06-23T08:00:01.000Z']),
    });

    const first = await syncService.enqueueSyncJob(sourceKey, 'incremental', 'manual_api');
    const second = await syncService.enqueueSyncJob(sourceKey, 'incremental', 'manual_api');
    const full = await syncService.enqueueSyncJob(sourceKey, 'full', 'manual_api');

    expect(second).toEqual(first);
    expect(full.jobId).not.toBe(first.jobId);
    await expect(store.listReplayableSyncJobs(10)).resolves.toHaveLength(2);
  });

  it('deduplicates active jobs for the same source and mode even when fieldMapping differs', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
      now: createClock(['2026-06-23T08:00:00.000Z', '2026-06-23T08:00:01.000Z', '2026-06-23T08:00:02.000Z']),
    });
    const alternateSourceKey: ReviewSyncSourceKey = {
      ...sourceKey,
      fieldMapping: {
        ...sourceKey.fieldMapping,
        content: 'fld-review-alt',
      },
    };

    const first = await syncService.enqueueSyncJob(sourceKey, 'incremental', 'manual_api');
    const second = await syncService.enqueueSyncJob(alternateSourceKey, 'incremental', 'manual_api');
    const duplicate = await syncService.enqueueSyncJob(alternateSourceKey, 'incremental', 'manual_api');

    expect(second).toEqual(first);
    expect(duplicate).toEqual(first);
    await expect(store.listReplayableSyncJobs(10)).resolves.toHaveLength(1);
  });

  it('keeps one canonical read model for the same source when fieldMapping changes', async () => {
    const store = createInMemoryReviewSyncStore();
    const alternateSourceKey: ReviewSyncSourceKey = {
      ...sourceKey,
      fieldMapping: {
        ...sourceKey.fieldMapping,
        content: 'fld-review-alt',
      },
    };
    const fieldAwareSource = new FieldMappingAwareReviewSource({
      [sourceKey.fieldMapping.content]: [review('rec-1', 'Primary mapping review', 5)],
      [alternateSourceKey.fieldMapping.content]: [review('rec-1', 'Alternate mapping review', 4)],
    });
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: fieldAwareSource },
      now: createClock([
        '2026-06-23T08:00:00.000Z',
        '2026-06-23T08:00:01.000Z',
        '2026-06-23T08:00:02.000Z',
        '2026-06-23T08:00:03.000Z',
        '2026-06-23T08:00:04.000Z',
        '2026-06-23T08:01:00.000Z',
        '2026-06-23T08:01:01.000Z',
        '2026-06-23T08:01:02.000Z',
        '2026-06-23T08:01:03.000Z',
        '2026-06-23T08:01:04.000Z',
        '2026-06-23T08:02:00.000Z',
        '2026-06-23T08:02:01.000Z',
        '2026-06-23T08:02:02.000Z',
        '2026-06-23T08:02:03.000Z',
        '2026-06-23T08:02:04.000Z',
      ]),
    });
    const postgresSource = new PostgresReviewSource({ store });

    await syncService.runFullSync(sourceKey);
    await syncService.runFullSync(alternateSourceKey);

    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-1',
        content: 'Alternate mapping review',
        mappedFields: expect.objectContaining({ content: 'Alternate mapping review', rating: 4 }),
      }),
    ]);
    await expect(postgresSource.listReviews(toQuery(alternateSourceKey))).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-1',
        content: 'Alternate mapping review',
        mappedFields: expect.objectContaining({ content: 'Alternate mapping review', rating: 4 }),
      }),
    ]);

    const primaryVersion = await postgresSource.getSourceVersion(toQuery(sourceKey));
    const alternateVersion = await postgresSource.getSourceVersion(toQuery(alternateSourceKey));
    expect(primaryVersion.contentHash).toBe(alternateVersion.contentHash);
    expect(primaryVersion.recordCount).toBe(1);
    expect(alternateVersion.recordCount).toBe(1);

    fieldAwareSource.replace(sourceKey.fieldMapping.content, []);
    await syncService.runFullSync(sourceKey);

    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([]);
    await expect(postgresSource.listReviews(toQuery(alternateSourceKey))).resolves.toEqual([]);
  });

  it('restores Postgres read-model content from reviewText when content is absent', async () => {
    const store = createInMemoryReviewSyncStore();
    await store.upsertReviewRecords({
      sourceKey,
      reviews: [
        {
          recordId: 'rec-review-text',
          fields: { 'fld-review': 'Great review text' },
          mappedFields: { reviewText: 'Great review text', rating: 5 },
          content: undefined,
          contentHash: 'hash-review-text',
        },
      ],
      syncedAt: '2026-06-23T08:00:00.000Z',
    });

    await expect(new PostgresReviewSource({ store }).listReviews(toQuery(sourceKey))).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-review-text',
        content: 'Great review text',
      }),
    ]);
  });

  it('validates sync receiver source payload and reports validate_request for missing fields and unknown route', async () => {
    const syncService = new ReviewSyncService({
      store: createInMemoryReviewSyncStore(),
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
    });

    const missingSourceKey = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/full', {
        method: 'POST',
        body: JSON.stringify({ tableId: 'tbl-review', fieldMapping: sourceKey.fieldMapping }),
      }),
      { service: syncService },
    );
    await expect(missingSourceKey.json()).resolves.toMatchObject({
      stage: 'validate_request',
      message: 'missing sync source fields: baseToken',
    });
    expect(missingSourceKey.status).toBe(400);

    const notFound = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/missing', { method: 'POST' }),
      { service: syncService },
    );
    await expect(notFound.json()).resolves.toEqual({ stage: 'validate_request', message: 'not found' });
    expect(notFound.status).toBe(404);

    const manual = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/manual', {
        method: 'POST',
        body: JSON.stringify({
          mode: 'incremental',
          baseToken: 'base-token-a',
          tableId: 'tbl-review',
          fieldMapping: sourceKey.fieldMapping,
        }),
      }),
      { service: syncService },
    );
    await expect(manual.json()).resolves.toEqual({ stage: 'validate_request', message: 'not found' });
    expect(manual.status).toBe(404);
  });

  it('wraps Postgres record/version/job success writes in a transaction', async () => {
    const client = new RecordingPostgresClient();
    const store = createPostgresReviewSyncStore(client);

    await store.completeSyncJob({
      job: {
        jobId: 'job-1',
        sourceKey,
        tenantKey: sourceKey.tenantKey,
        sourceKind: sourceKey.sourceKind,
        sourceId: sourceKey.sourceId,
        mode: 'full',
        triggerType: 'manual_api',
        status: 'running',
        stage: 'write_records',
        recordsRead: 1,
        recordsUpserted: 0,
        recordsDeleted: 0,
        recordsUnchanged: 0,
        createdAt: '2026-06-23T08:00:00.000Z',
        startedAt: '2026-06-23T08:00:01.000Z',
        updatedAt: '2026-06-23T08:00:01.000Z',
      },
      sourceKey,
      reviews: [review('rec-1', 'Great view', 5)],
      sourceVersion: {
        kind: 'feishu_base',
        sourceId: sourceKey.sourceId,
        version: 'source-version',
        contentHash: 'version-hash',
        recordCount: 1,
        generatedAt: '2026-06-23T08:00:02.000Z',
      },
      syncedAt: '2026-06-23T08:00:02.000Z',
    });

    expect(client.statements).toContain('BEGIN');
    expect(client.statements).toContain('COMMIT');
    expect(client.statements).not.toContain('ROLLBACK');
    expect(client.sqlLog.join('\n')).toContain('duration_ms');
  });

  it('does not use source_key_hash in Postgres read-model record and version identity SQL', async () => {
    const client = new RecordingPostgresClient();
    const store = createPostgresReviewSyncStore(client);

    await store.upsertReviewRecords({
      sourceKey,
      reviews: [review('rec-1', 'Great view', 5)],
      syncedAt: '2026-06-23T08:00:00.000Z',
    });
    await store.listReviewRecords(sourceKey);
    await store.getReviewRecord(sourceKey, 'rec-1');
    await store.softDeleteMissingRecords({
      sourceKey,
      activeRecordIds: ['rec-1'],
      syncedAt: '2026-06-23T08:00:01.000Z',
    });
    await store.softDeleteReviewRecord({
      sourceKey,
      recordId: 'rec-1',
      syncedAt: '2026-06-23T08:00:02.000Z',
    });
    await store.saveSourceVersion(sourceKey, {
      kind: 'feishu_base',
      sourceId: sourceKey.sourceId,
      version: 'source-version',
      contentHash: 'version-hash',
      recordCount: 1,
      generatedAt: '2026-06-23T08:00:03.000Z',
    });
    await store.getLatestSourceVersion(sourceKey);

    const sql = client.sqlLog.join('\n');
    expect(sql).toContain('on conflict (tenant_key, source_kind, source_id, record_id)');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3 and is_deleted = false');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3 and record_id = $4');
    expect(sql).toContain('on conflict (tenant_key, source_kind, source_id, version)');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3');
    expect(sql).not.toContain('source_key_hash = $4');
  });
});

function toQuery(key: ReviewSyncSourceKey): ReviewSourceQuery {
  return {
    tenantKey: key.tenantKey,
    baseToken: key.baseToken,
    tableId: key.tableId,
    viewId: key.viewId,
    fieldMapping: key.fieldMapping,
  };
}

function review(recordId: string, content: string, rating: number, contentHash = `${recordId}:${content}`): ReviewRecord {
  return {
    recordId,
    fields: {
      'fld-review': content,
      'fld-rating': rating,
      'fld-hotel': 'Hotel A',
    },
    mappedFields: {
      content,
      rating,
      hotelName: 'Hotel A',
    },
    content,
    contentHash,
  };
}

class MutableReviewSource implements ReviewSource {
  readonly kind = 'feishu_base';
  private reviews: ReviewRecord[];

  constructor(reviews: ReviewRecord[]) {
    this.reviews = reviews;
  }

  replace(reviews: ReviewRecord[]): void {
    this.reviews = reviews;
  }

  async listReviews(): Promise<ReviewRecord[]> {
    return this.reviews.map((reviewRecord) => structuredClone(reviewRecord));
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews = this.reviews): Promise<SourceVersion> {
    const contentHash = reviews.map((reviewRecord) => reviewRecord.contentHash).sort().join('|');
    return {
      kind: this.kind,
      sourceId: [query.baseToken, query.tableId].filter(Boolean).join(':'),
      version: `source-${contentHash}`,
      contentHash,
      recordCount: reviews.length,
      generatedAt: 'reader-generated-at',
    };
  }
}

class FieldMappingAwareReviewSource implements ReviewSource {
  readonly kind = 'feishu_base';
  private readonly reviewsByContentField: Record<string, ReviewRecord[]>;

  constructor(reviewsByContentField: Record<string, ReviewRecord[]>) {
    this.reviewsByContentField = structuredClone(reviewsByContentField);
  }

  replace(contentFieldId: string, reviews: ReviewRecord[]): void {
    this.reviewsByContentField[contentFieldId] = structuredClone(reviews);
  }

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    return (this.reviewsByContentField[query.fieldMapping.content] ?? []).map((reviewRecord) => structuredClone(reviewRecord));
  }

  async getSourceVersion(query: ReviewSourceQuery): Promise<SourceVersion> {
    const reviews = await this.listReviews(query);
    const contentHash = reviews.map((reviewRecord) => reviewRecord.contentHash).sort().join('|');
    return {
      kind: this.kind,
      sourceId: [query.baseToken, query.tableId].filter(Boolean).join(':'),
      version: `source-${contentHash}`,
      contentHash,
      recordCount: reviews.length,
      generatedAt: 'reader-generated-at',
    };
  }
}

class RecordingPostgresClient {
  readonly statements: string[] = [];
  readonly sqlLog: string[] = [];

  async query<T = Record<string, unknown>>(text: string): Promise<{ rows: T[] }> {
    this.sqlLog.push(text.trim().replace(/\s+/g, ' '));
    this.statements.push(text.trim().split(/\s+/).slice(0, 2).join(' ').toUpperCase());
    if (text.includes('returning *') && text.includes('sync_jobs')) {
      return {
        rows: [
          {
            id: 'job-1',
            tenant_key: sourceKey.tenantKey,
            source_kind: sourceKey.sourceKind,
            source_id: sourceKey.sourceId,
            base_token: sourceKey.baseToken,
            table_id: sourceKey.tableId,
            view_id: sourceKey.viewId,
            field_mapping_json: sourceKey.fieldMapping,
            trigger_type: 'manual',
            status: 'success',
            stage: 'success',
            records_read: 1,
            records_upserted: 1,
            records_deleted: 0,
            created_at: new Date('2026-06-23T08:00:00.000Z'),
            updated_at: new Date('2026-06-23T08:00:02.000Z'),
            finished_at: new Date('2026-06-23T08:00:02.000Z'),
          },
        ] as T[],
      };
    }
    if (text.includes('select count')) {
      return { rows: [{ count: '0' }] as T[] };
    }
    if (text.includes('review_source_versions') && text.includes('returning *')) {
      return {
        rows: [
          {
            source_kind: sourceKey.sourceKind,
            source_id: sourceKey.sourceId,
            version: 'source-version',
            record_count: 1,
            content_hash: 'version-hash',
            generated_at: new Date('2026-06-23T08:00:02.000Z'),
          },
        ] as T[],
      };
    }
    return { rows: [] };
  }
}

function createClock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}
