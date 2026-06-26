import { describe, expect, it, vi } from 'vitest';
import { handleWarmupRequest } from './warmupHandler';
import { createWarmupService } from './warmupJob';
import { createInMemoryWarmupJobStore } from './warmupJobStore';

describe('handleWarmupRequest', () => {
  it('rejects requests without the configured bearer token', async () => {
    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/warmup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer wrong-secret',
        },
        body: JSON.stringify({
          mode: 'incremental',
          source: 'feishu-workflow',
          baseToken: 'base-a',
          tableId: 'tbl-review',
        }),
      }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-17T06:00:00.000Z',
      },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      status: 'failed',
      errors: [{ stage: 'validate_request', message: 'invalid warmup authorization' }],
    });
  });

  it('accepts Feishu Workflow warmup requests and logs trigger metadata', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const enqueue = vi.fn();
    const service = createWarmupService({
      store: createInMemoryWarmupJobStore(),
      now: () => '2026-06-17T06:00:00.000Z',
    });

    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/warmup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer local-warmup-secret',
        },
        body: JSON.stringify({
          mode: 'incremental',
          source: 'feishu-workflow',
          baseToken: 'base-a',
          tableId: 'tbl-review',
          viewId: 'view-a',
          fieldMapping: {
            content: 'fld-content',
            reviewDate: 'fld-review-date',
          },
          startDate: '2026-06-01',
          endDate: '2026-06-30',
        }),
      }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-17T06:00:00.000Z',
        service,
        onWarmupJobCreated: enqueue,
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    await expect(response.json()).resolves.toEqual({
      jobId: 'warmup-job-1',
      status: 'accepted',
      mode: 'incremental',
      summary: {
        recordsScanned: 0,
        totalReviews: 0,
        evidenceCacheHits: 0,
        evidenceCacheMisses: 0,
        evidenceRecordsSaved: 0,
        evidenceCacheInserts: 0,
        evidenceCacheUpdates: 0,
        topicMappingHits: 0,
        topicMappingMisses: 0,
        topicMappingsSaved: 0,
        topicMappingCacheInserts: 0,
        topicMappingCacheUpdates: 0,
      },
      errors: [],
    });
    expect(enqueue).toHaveBeenCalledWith('warmup-job-1');
    expect(infoSpy).toHaveBeenCalledWith(
      '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
      JSON.stringify({
        jobId: 'warmup-job-1',
        source: 'feishu-workflow',
        mode: 'incremental',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'view-a',
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        dryRun: false,
      }),
    );
  });

  it('accepts second-precision review time ranges for manual warmup requests', async () => {
    const service = createWarmupService({
      store: createInMemoryWarmupJobStore(),
      now: () => '2026-06-25T09:00:00.000Z',
    });

    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/warmup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer local-warmup-secret',
        },
        body: JSON.stringify({
          mode: 'incremental',
          source: 'manual',
          baseToken: 'base-a',
          tableId: 'tbl-review',
          fieldMapping: {
            content: 'fld-content',
            reviewDate: 'fld-review-date',
          },
          startDate: '2026-05-01 00:00:00',
          endDate: '2026-05-01 23:59:59',
        }),
      }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-25T09:00:00.000Z',
        service,
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: 'warmup-job-1',
      status: 'accepted',
      mode: 'incremental',
    });
  });

  it('expands today dateRange to the current Asia/Shanghai review day', async () => {
    const service = createWarmupService({
      store: createInMemoryWarmupJobStore(),
      now: () => '2026-06-25T16:30:00.000Z',
    });
    const enqueue = vi.fn();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/warmup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer local-warmup-secret',
        },
        body: JSON.stringify({
          mode: 'incremental',
          source: 'feishu-workflow',
          baseToken: 'base-a',
          tableId: 'tbl-review',
          fieldMapping: {
            content: 'fld-content',
            reviewDate: 'fld-review-date',
          },
          dateRange: 'today',
        }),
      }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-25T16:30:00.000Z',
        service,
        onWarmupJobCreated: enqueue,
      },
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith('warmup-job-1');
    expect(infoSpy).toHaveBeenCalledWith(
      '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
      JSON.stringify({
        jobId: 'warmup-job-1',
        source: 'feishu-workflow',
        mode: 'incremental',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: undefined,
        startDate: '2026-06-26 00:00:00',
        endDate: '2026-06-26 23:59:59',
        dryRun: false,
      }),
    );
  });

  it('returns not found for other paths', async () => {
    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/health', { method: 'GET' }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-17T06:00:00.000Z',
      },
    );

    expect(response.status).toBe(404);
  });

  it('responds to browser CORS preflight for local backend calls', async () => {
    const response = await handleWarmupRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/warmup', { method: 'OPTIONS' }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-17T06:00:00.000Z',
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(response.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
  });
});
