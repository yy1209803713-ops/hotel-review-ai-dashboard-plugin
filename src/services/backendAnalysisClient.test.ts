import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendAnalysisError, createBackendAnalysisClient } from './backendAnalysisClient';

describe('backendAnalysisClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('builds backend endpoints and ownership query parameters', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/hotel-review-ai/configs/upsert')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toMatchObject({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'instance-a',
          model: 'qwen-plus',
        });
        return jsonResponse({ configId: 'config-1', configVersion: 2 });
      }
      if (url.endsWith('/api/hotel-review-ai/analysis-jobs')) {
        return jsonResponse({ jobId: 'job-1', scopeKey: 'scope-create', status: 'queued' });
      }
      if (url.includes('/api/hotel-review-ai/analysis-jobs/job-1?')) {
        expect(url).toContain('tenantKey=tenant-a');
        expect(url).toContain('baseUserId=user-a');
        expect(url).toContain('pluginInstanceId=instance-a');
        return jsonResponse({ jobId: 'job-1', scopeKey: 'scope-actual', status: 'success', resultId: 'result-1' });
      }
      if (url.includes('/api/hotel-review-ai/results/latest?')) {
        expect(url).toContain('scopeKey=scope-actual');
        return jsonResponse({ resultId: 'result-1', summary: createRenderableSummary() });
      }
      if (url.includes('/api/hotel-review-ai/results/result-1/topics/topic-a/evidence?')) {
        expect(url).toContain('page=1');
        expect(url).toContain('pageSize=20');
        expect(url).toContain('tenantKey=tenant-a');
        expect(url).toContain('baseUserId=user-a');
        expect(url).toContain('pluginInstanceId=instance-a');
        expect(url).toContain('scopeKey=scope-actual');
        return jsonResponse({ records: [], page: 1, pageSize: 20, total: 0 });
      }
      if (url.endsWith('/api/hotel-review-ai/results/result-1/export/base-summary')) {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'instance-a',
          scopeKey: 'scope-actual',
        });
        return jsonResponse({
          resultId: 'result-1',
          summaryTableId: 'tbl-summary',
          topicTableId: 'tbl-topic',
          summaryRecordIds: ['rec-summary'],
          topicRecordIds: ['rec-topic'],
          exportedAt: '2026-06-18T12:00:00.000Z',
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = createBackendAnalysisClient({ endpointUrl: 'https://backend.example.com', fetchImpl: fetchMock });
    const ownership = { tenantKey: 'tenant-a', baseUserId: 'user-a', pluginInstanceId: 'instance-a' };

    await client.upsertConfig({
      ...ownership,
      baseToken: 'base-token',
      model: 'qwen-plus',
      source: { kind: 'feishu_base', tableId: 'tbl1', fieldMapping: createFieldMapping() },
      filters: createFilters(),
      dashboardDataConditions: [],
    });
    await client.createAnalysisJob({ ...ownership, configId: 'config-1' });
    const job = await client.getJob('job-1', ownership);
    await client.getLatestResult({ ...ownership, scopeKey: job.scopeKey });
    await client.getTopicEvidence({
      ...ownership,
      resultId: 'result-1',
      topicId: 'topic-a',
      scopeKey: job.scopeKey,
      page: 1,
      pageSize: 20,
    });
    await expect(client.exportBaseSummary({ ...ownership, resultId: 'result-1', scopeKey: job.scopeKey })).resolves.toMatchObject({
      resultId: 'result-1',
      summaryTableId: 'tbl-summary',
      topicTableId: 'tbl-topic',
    });
  });

  it('throws stage/message errors for non-2xx responses', async () => {
    const client = createBackendAnalysisClient({
      endpointUrl: 'https://backend.example.com',
      fetchImpl: vi.fn(async () => jsonResponse({ stage: 'load_config', message: 'config missing' }, 400)),
    });

    await expect(
      client.createAnalysisJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'instance-a',
        configId: 'config-1',
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'config missing',
    });
  });

  it('throws validate_response when backend returns invalid JSON', async () => {
    const client = createBackendAnalysisClient({
      endpointUrl: 'https://backend.example.com',
      fetchImpl: vi.fn(async () => new Response('not-json', { status: 200 })),
    });

    await expect(
      client.getCurrentJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'instance-a',
        scopeKey: 'scope-a',
      }),
    ).rejects.toBeInstanceOf(BackendAnalysisError);
    await expect(
      client.getCurrentJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'instance-a',
        scopeKey: 'scope-a',
      }),
    ).rejects.toMatchObject({
      stage: 'validate_response',
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createFieldMapping() {
  return {
    reviewId: 'fld_id',
    content: 'fld_content',
    hotelName: 'fld_hotel',
    score: 'fld_score',
    reviewDate: 'fld_review_date',
    checkInMonth: 'fld_checkin',
    replyContent: 'fld_reply',
    roomType: 'fld_room',
  };
}

function createFilters() {
  return {
    hotelName: 'all',
    periodType: 'month' as const,
    startDate: '',
    endDate: '',
    checkInMonth: 'all',
    minScore: null,
    maxScore: null,
    replyStatus: 'all' as const,
    keyword: '',
  };
}

function createRenderableSummary() {
  return {
    analysisId: 'analysis-1',
    generatedAt: '2026-06-18T00:00:00.000Z',
    model: 'qwen-plus',
    status: 'complete',
    scope: { hotelName: 'all', periodType: 'month', startDate: '', endDate: '' },
    overview: {
      totalReviews: 1,
      positiveReviews: 1,
      negativeOrRiskReviews: 0,
      mixedReviews: 0,
      neutralReviews: 0,
      averageScore: 5,
      replyRate: 1,
    },
    positiveTopics: [],
    negativeTopics: [],
    actionItems: [],
  };
}
