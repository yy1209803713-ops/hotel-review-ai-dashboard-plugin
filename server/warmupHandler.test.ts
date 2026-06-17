import { describe, expect, it, vi } from 'vitest';
import { handleWarmupRequest } from './warmupHandler';

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
        }),
      }),
      {
        warmupSecret: 'local-warmup-secret',
        now: () => '2026-06-17T06:00:00.000Z',
      },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      jobId: 'warmup-2026-06-17T06:00:00.000Z-tbl-review',
      status: 'accepted',
      mode: 'incremental',
      summary: {
        totalReviews: 0,
        evidenceCacheHits: 0,
        evidenceCacheMisses: 0,
        evidenceRecordsSaved: 0,
        topicMappingHits: 0,
        topicMappingMisses: 0,
        topicMappingsSaved: 0,
      },
      errors: [],
    });
    expect(infoSpy).toHaveBeenCalledWith(
      '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
      JSON.stringify({
        jobId: 'warmup-2026-06-17T06:00:00.000Z-tbl-review',
        source: 'feishu-workflow',
        mode: 'incremental',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        viewId: 'view-a',
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
});
