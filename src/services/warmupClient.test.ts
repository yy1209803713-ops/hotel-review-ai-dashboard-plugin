import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { buildWarmupRequest, triggerWarmup, WarmupClientError } from './warmupClient';
import type { WarmupResponse } from './warmup';

describe('warmupClient', () => {
  it('builds a warmup request from plugin config and mode', () => {
    const request = buildWarmupRequest(
      {
        ...DEFAULT_CONFIG,
        warmup: {
          endpointUrl: 'https://backend.example.com/api/hotel-review-ai/warmup',
          secret: 'warmup-secret',
        },
      },
      'incremental',
      'dashboard-button',
    );

    expect(request).toEqual({
      endpointUrl: 'https://backend.example.com/api/hotel-review-ai/warmup',
      headers: {
        Authorization: 'Bearer warmup-secret',
        'Content-Type': 'application/json',
      },
      body: {
        mode: 'incremental',
        source: 'dashboard-button',
        tableId: '',
      },
    });
  });

  it('posts warmup requests with bearer auth and returns parsed response', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () =>
        ({
          jobId: 'warmup-1',
          status: 'accepted',
          mode: 'incremental',
          summary: {
            totalReviews: 1,
            evidenceCacheHits: 0,
            evidenceCacheMisses: 1,
            evidenceRecordsSaved: 1,
            topicMappingHits: 0,
            topicMappingMisses: 0,
            topicMappingsSaved: 0,
          },
          errors: [],
        }) satisfies WarmupResponse,
    } as Response));

    const result = await triggerWarmup(
      {
        ...DEFAULT_CONFIG,
        source: {
          ...DEFAULT_CONFIG.source,
          tableId: 'tbl-review',
        },
        warmup: {
          endpointUrl: 'https://backend.example.com/api/hotel-review-ai/warmup',
          secret: 'warmup-secret',
        },
      },
      'incremental',
      'feishu-workflow',
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://backend.example.com/api/hotel-review-ai/warmup',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer warmup-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'incremental',
          source: 'feishu-workflow',
          baseToken: undefined,
          tableId: 'tbl-review',
          viewId: undefined,
          configId: undefined,
          dryRun: false,
        }),
      }),
    );
    expect(result.status).toBe('accepted');
  });

  it('surfaces backend stage and message on non-2xx responses', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: false,
      status: 500,
      json: async () => ({
        status: 'failed',
        mode: 'bootstrap',
        jobId: 'warmup-1',
        summary: {
          totalReviews: 0,
          evidenceCacheHits: 0,
          evidenceCacheMisses: 0,
          evidenceRecordsSaved: 0,
          topicMappingHits: 0,
          topicMappingMisses: 0,
          topicMappingsSaved: 0,
        },
        errors: [{ stage: 'read_reviews', message: 'permission denied' }],
      }),
    } as Response));

    await expect(
      triggerWarmup(
        {
          ...DEFAULT_CONFIG,
          warmup: {
            endpointUrl: 'https://backend.example.com/api/hotel-review-ai/warmup',
            secret: 'warmup-secret',
          },
        },
        'bootstrap',
        'manual',
        fetchImpl,
      ),
    ).rejects.toMatchObject({
      stage: 'read_reviews',
      message: 'permission denied',
    } satisfies Partial<WarmupClientError>);
  });
});
