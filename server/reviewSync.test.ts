import { describe, expect, it } from 'vitest';
import { createInMemoryReviewSyncStore, createPostgresReviewSyncStore } from './postgresReviewSyncStore';
import { PostgresReviewSource } from './postgresReviewSource';
import { ReviewSyncService, type ReviewSyncSourceKey } from './reviewSync';
import { handleReviewSyncRequest } from './syncHandler';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';
import type { SourceVersion } from './backendAnalysis';

const sourceKey: ReviewSyncSourceKey = {
  tenantKey: 'tenant-a',
  sourceKind: 'feishu_base',
  sourceId: 'base-token-a:tbl-review:vew-active',
  baseToken: 'base-token-a',
  tableId: 'tbl-review',
  viewId: 'vew-active',
  fieldMapping: {
    content: 'fld-review',
    rating: 'fld-rating',
    hotelName: 'fld-hotel',
  },
};

describe('ReviewSyncService and PostgresReviewSource', () => {
  it('seeds the read model, applies event updates, soft-deletes removed records, and advances source versions', async () => {
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

    const fullSync = await syncService.runFullSync(sourceKey, 'manual');

    expect(fullSync).toMatchObject({
      status: 'success',
      triggerType: 'manual',
      recordsRead: 2,
      recordsUpserted: 2,
      recordsDeleted: 0,
    });
    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([
      review('rec-1', 'Great view', 5),
      review('rec-2', 'Noisy room', 2),
    ]);
    const firstVersion = await postgresSource.getSourceVersion(toQuery(sourceKey));
    expect(firstVersion).toMatchObject({
      kind: 'postgres',
      sourceId: 'base-token-a:tbl-review:vew-active',
      recordCount: 2,
      generatedAt: '2026-06-23T08:01:00.000Z',
    });

    feishuSource.replace([
      review('rec-1', 'Great view after renovation', 5),
      review('rec-2', 'Noisy room', 2),
    ]);
    const eventJob = await syncService.handleFeishuRecordChangedEvent({
      sourceKey,
      recordId: 'rec-1',
      operation: 'update',
    });

    expect(eventJob).toMatchObject({
      status: 'success',
      triggerType: 'event',
      recordsRead: 2,
      recordsUpserted: 2,
      recordsDeleted: 0,
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
    await syncService.runFullSync(sourceKey, 'schedule');

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

  it('enqueues Feishu record-changed events from the HTTP receiver and returns before worker sync runs', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([review('rec-1', 'Great view', 5)]) },
      now: createClock(['2026-06-23T08:00:00.000Z']),
    });
    const enqueued: Array<{ jobId: string; sourceKey: ReviewSyncSourceKey }> = [];

    const response = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/feishu/record-changed', {
        method: 'POST',
        body: JSON.stringify({
          sourceKey,
          recordId: 'rec-1',
          operation: 'update',
        }),
      }),
      {
        service: syncService,
        onSyncJobCreated(jobId, enqueuedSourceKey) {
          enqueued.push({ jobId, sourceKey: enqueuedSourceKey });
        },
      },
    );

    await expect(response.json()).resolves.toMatchObject({
      jobId: 'sync-job-1',
      status: 'queued',
      triggerType: 'event',
    });
    expect(response.status).toBe(202);
    expect(enqueued).toEqual([{ jobId: 'sync-job-1', sourceKey }]);
    await expect(store.listReviewRecords(sourceKey)).resolves.toEqual([]);
  });

  it('responds to browser CORS preflight for sync endpoints', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
    });

    const response = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/feishu/record-changed', { method: 'OPTIONS' }),
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

    const queued = await syncService.enqueueSyncJob(sourceKey, 'manual');

    expect(queued.sourceKey).toEqual(sourceKey);
    await expect(store.getSyncJob(queued.jobId)).resolves.toMatchObject({ sourceKey });
    await expect(store.listReplayableSyncJobs(10)).resolves.toEqual([expect.objectContaining({ jobId: queued.jobId, sourceKey })]);
    await expect(syncService.runQueuedSyncJob(queued.jobId)).resolves.toMatchObject({
      status: 'success',
      recordsRead: 1,
    });
  });

  it('deduplicates active jobs for the same source and trigger without hiding job stage or message', async () => {
    const store = createInMemoryReviewSyncStore();
    const syncService = new ReviewSyncService({
      store,
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
      now: createClock(['2026-06-23T08:00:00.000Z', '2026-06-23T08:00:01.000Z']),
    });

    const first = await syncService.enqueueSyncJob(sourceKey, 'event');
    const second = await syncService.enqueueSyncJob(sourceKey, 'event');
    const manual = await syncService.enqueueSyncJob(sourceKey, 'manual');

    expect(second).toEqual(first);
    expect(manual.jobId).not.toBe(first.jobId);
    await expect(store.listReplayableSyncJobs(10)).resolves.toHaveLength(2);
  });

  it('creates distinct active jobs when fieldMapping differs for the same source and trigger', async () => {
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

    const first = await syncService.enqueueSyncJob(sourceKey, 'event');
    const second = await syncService.enqueueSyncJob(alternateSourceKey, 'event');
    const duplicate = await syncService.enqueueSyncJob(alternateSourceKey, 'event');

    expect(second.jobId).not.toBe(first.jobId);
    expect(duplicate).toEqual(second);
    await expect(store.listReplayableSyncJobs(10)).resolves.toHaveLength(2);
  });

  it('keeps records, source versions, and soft-delete scoped to fieldMapping identity for the same source', async () => {
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

    await syncService.runFullSync(sourceKey, 'manual');
    await syncService.runFullSync(alternateSourceKey, 'manual');

    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-1',
        content: 'Primary mapping review',
        mappedFields: expect.objectContaining({ content: 'Primary mapping review', rating: 5 }),
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
    expect(primaryVersion.contentHash).not.toBe(alternateVersion.contentHash);
    expect(primaryVersion.recordCount).toBe(1);
    expect(alternateVersion.recordCount).toBe(1);

    fieldAwareSource.replace(sourceKey.fieldMapping.content, []);
    await syncService.runFullSync(sourceKey, 'schedule');

    await expect(postgresSource.listReviews(toQuery(sourceKey))).resolves.toEqual([]);
    await expect(postgresSource.listReviews(toQuery(alternateSourceKey))).resolves.toEqual([
      expect.objectContaining({
        recordId: 'rec-1',
        content: 'Alternate mapping review',
      }),
    ]);
  });

  it('confirms delete events with a source read before soft-deleting records', async () => {
    const store = createInMemoryReviewSyncStore();
    const feishuSource = new MutableReviewSource([review('rec-1', 'Still present', 5)]);
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

    await syncService.runFullSync(sourceKey, 'manual');
    await syncService.handleFeishuRecordChangedEvent({ sourceKey, recordId: 'rec-1', operation: 'delete' });

    await expect(store.getReviewRecord(sourceKey, 'rec-1')).resolves.toMatchObject({
      recordId: 'rec-1',
      isDeleted: false,
    });

    feishuSource.replace([]);
    await syncService.handleFeishuRecordChangedEvent({ sourceKey, recordId: 'rec-1', operation: 'delete' });

    await expect(store.getReviewRecord(sourceKey, 'rec-1')).resolves.toMatchObject({
      recordId: 'rec-1',
      isDeleted: true,
    });
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

  it('validates full receiver sourceKey shape and reports validate_request for missing sourceKey and unknown route', async () => {
    const syncService = new ReviewSyncService({
      store: createInMemoryReviewSyncStore(),
      sourceReaders: { feishu_base: new MutableReviewSource([]) },
    });

    const missingSourceKey = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/feishu/record-changed', {
        method: 'POST',
        body: JSON.stringify({ recordId: 'rec-1', operation: 'update' }),
      }),
      { service: syncService },
    );
    await expect(missingSourceKey.json()).resolves.toMatchObject({
      stage: 'validate_request',
      message: 'sourceKey is required',
    });
    expect(missingSourceKey.status).toBe(400);

    const notFound = await handleReviewSyncRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/sync/missing', { method: 'POST' }),
      { service: syncService },
    );
    await expect(notFound.json()).resolves.toEqual({ stage: 'validate_request', message: 'not found' });
    expect(notFound.status).toBe(404);
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
        triggerType: 'manual',
        status: 'running',
        stage: 'write_records',
        recordsRead: 1,
        recordsUpserted: 0,
        recordsDeleted: 0,
        createdAt: '2026-06-23T08:00:00.000Z',
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
  });

  it('uses source_key_hash in Postgres read-model record and version identity SQL', async () => {
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
    expect(sql).toContain('on conflict (tenant_key, source_kind, source_id, source_key_hash, record_id)');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3 and source_key_hash = $4 and is_deleted = false');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3 and source_key_hash = $4 and record_id = $5');
    expect(sql).toContain('and source_key_hash = $4');
    expect(sql).toContain('on conflict (tenant_key, source_kind, source_id, source_key_hash, version)');
    expect(sql).toContain('where tenant_key = $1 and source_kind = $2 and source_id = $3 and source_key_hash = $4');
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

function review(recordId: string, content: string, rating: number): ReviewRecord {
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
    contentHash: `${recordId}:${content}`,
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
      sourceId: [query.baseToken, query.tableId, query.viewId].filter(Boolean).join(':'),
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
      sourceId: [query.baseToken, query.tableId, query.viewId].filter(Boolean).join(':'),
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
