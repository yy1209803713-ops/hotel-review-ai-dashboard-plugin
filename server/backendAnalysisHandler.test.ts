import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisBackendService,
  completeAnalysisJobForTest,
  createInMemoryAnalysisBackendStore,
  DefaultDeterministicReviewSource,
  type BaseSummaryExporter,
  type BackendAnalysisConfigUpsertRequest,
  type AnalysisBackendStore,
} from './backendAnalysis';
import { handleBackendAnalysisRequest } from './backendAnalysisHandler';

const upsertBody: BackendAnalysisConfigUpsertRequest = {
  tenantKey: 'tenant-a',
  baseUserId: 'user-a',
  pluginInstanceId: 'plugin-a',
  baseToken: 'base-token-a',
  source: {
    kind: 'feishu_base',
    tableId: 'tbl-review',
    viewId: 'vew-active',
    fieldMapping: { reviewText: 'fld-review', rating: 'fld-rating' },
  },
  filters: { ratingMin: 3 },
  dashboardDataConditions: { view: 'active' },
};

function createService(baseSummaryExporter?: BaseSummaryExporter): { service: AnalysisBackendService; store: AnalysisBackendStore } {
  const store = createInMemoryAnalysisBackendStore();
  return {
    service: new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: new DefaultDeterministicReviewSource('feishu_base') },
      baseSummaryExporter,
    }),
    store,
  };
}

async function postJson(service: AnalysisBackendService, path: string, body: unknown): Promise<Response> {
  return handleBackendAnalysisRequest(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { service },
  );
}

async function postJsonWithOptions(
  service: AnalysisBackendService,
  path: string,
  body: unknown,
  options: Omit<Parameters<typeof handleBackendAnalysisRequest>[1], 'service'>,
): Promise<Response> {
  return handleBackendAnalysisRequest(
    new Request(`http://127.0.0.1:8787${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { service, ...options },
  );
}

describe('handleBackendAnalysisRequest', () => {
  it('upserts config, resolves scope, and creates a queued job via JSON endpoints', async () => {
    const { service } = createService();

    const upsertResponse = await postJson(service, '/api/hotel-review-ai/configs/upsert', upsertBody);
    const upserted = await upsertResponse.json();
    const scopeResponse = await postJson(service, '/api/hotel-review-ai/scopes/resolve', {
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: upserted.configId,
    });
    const jobResponse = await postJson(service, '/api/hotel-review-ai/analysis-jobs', {
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: upserted.configId,
    });

    expect(upsertResponse.status).toBe(200);
    expect(upserted).toMatchObject({ configId: expect.stringMatching(/^config-/), configVersion: 1 });
    expect(scopeResponse.status).toBe(200);
    await expect(scopeResponse.json()).resolves.toMatchObject({
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      configVersion: 1,
      sourceVersion: { recordCount: 0, generatedAt: 'deterministic' },
    });
    expect(jobResponse.status).toBe(200);
    await expect(jobResponse.json()).resolves.toMatchObject({
      jobId: expect.stringMatching(/^job-/),
      scopeKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'queued',
      created: true,
    });
  });

  it('invokes the runtime enqueue hook only for newly created analysis jobs', async () => {
    const { service } = createService();
    const enqueue = vi.fn();
    const config = await service.upsertConfig(upsertBody);
    const body = {
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    };

    const first = await postJsonWithOptions(service, '/api/hotel-review-ai/analysis-jobs', body, { onJobCreated: enqueue });
    const repeated = await postJsonWithOptions(service, '/api/hotel-review-ai/analysis-jobs', body, { onJobCreated: enqueue });

    const firstPayload = await first.json();
    const repeatedPayload = await repeated.json();
    expect(firstPayload).toMatchObject({ status: 'queued', created: true });
    expect(repeatedPayload).toMatchObject({ jobId: firstPayload.jobId, created: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(firstPayload.jobId);
  });

  it('returns current job, job detail, latest result, and topic evidence through GET endpoints', async () => {
    const { service, store } = createService();
    const config = await service.upsertConfig(upsertBody);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const result = await completeAnalysisJobForTest({ service, store }, job.jobId, {
      summary: { totalReviews: 1 },
      topics: [{ topicId: 'topic-location', label: 'Location' }],
      evidenceByTopic: {
        'topic-location': [{ evidenceId: 'ev-1', recordId: 'rec-1', quote: 'Great location', sentiment: 'positive' }],
      },
    });

    const current = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/current?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=${job.scopeKey}`,
      ),
      { service },
    );
    const detail = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/${job.jobId}?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a`,
      ),
      { service },
    );
    const latest = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/results/latest?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=${job.scopeKey}`,
      ),
      { service },
    );
    const evidence = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/results/${result.resultId}/topics/topic-location/evidence?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=${job.scopeKey}&page=1&pageSize=20`,
      ),
      { service },
    );

    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ jobId: job.jobId, status: 'success' });
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ status: 'success', resultId: result.resultId });
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toMatchObject({ resultId: result.resultId });
    expect(evidence.status).toBe(200);
    await expect(evidence.json()).resolves.toMatchObject({ total: 1, evidence: [{ evidenceId: 'ev-1' }] });
  });

  it('exports a published result summary through the explicit Base export endpoint', async () => {
    const exporter: BaseSummaryExporter = {
      exportBaseSummary: vi.fn(async ({ result }) => ({
        resultId: result.resultId,
        summaryTableId: 'tbl-summary',
        topicTableId: 'tbl-topic',
        summaryRecordIds: ['rec-summary'],
        topicRecordIds: ['rec-topic'],
        exportedAt: '2026-06-18T12:00:00.000Z',
      })),
    };
    const { service, store } = createService(exporter);
    const config = await service.upsertConfig(upsertBody);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const result = await completeAnalysisJobForTest({ service, store }, job.jobId, {
      summary: createExportableSummary(),
      topics: [],
      evidenceByTopic: {},
    });

    const response = await postJson(service, `/api/hotel-review-ai/results/${result.resultId}/export/base-summary`, {
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      scopeKey: job.scopeKey,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resultId: result.resultId,
      summaryTableId: 'tbl-summary',
      topicTableId: 'tbl-topic',
      summaryRecordIds: ['rec-summary'],
      topicRecordIds: ['rec-topic'],
      exportedAt: '2026-06-18T12:00:00.000Z',
    });
    expect(exporter.exportBaseSummary).toHaveBeenCalledTimes(1);
  });

  it('requires ownership body params for Base summary export requests', async () => {
    const { service } = createService();

    const response = await postJson(service, '/api/hotel-review-ai/results/result-1/export/base-summary', {
      tenantKey: 'tenant-a',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'missing required fields: baseUserId, pluginInstanceId, scopeKey',
    });
  });

  it('returns a newer failed current job even when an older latest result exists', async () => {
    const { service, store } = createService();
    const config = await service.upsertConfig(upsertBody);
    const successfulJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const result = await completeAnalysisJobForTest({ service, store }, successfulJob.jobId, {
      summary: { totalReviews: 1 },
      topics: [],
      evidenceByTopic: {},
    });
    const failedJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const claimedFailedJob = await store.claimJob(failedJob.jobId, 'started-failed');
    expect(claimedFailedJob).toBeDefined();
    await store.updateJob({
      ...claimedFailedJob!,
      status: 'failed',
      stage: 'read_reviews',
      progress: 40,
      finishedAt: 'finished-failed',
      errorStage: 'read_reviews',
      errorMessage: 'Base read denied',
    });

    const current = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/current?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=${successfulJob.scopeKey}`,
      ),
      { service },
    );
    const latest = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/results/latest?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a&scopeKey=${successfulJob.scopeKey}`,
      ),
      { service },
    );

    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({
      jobId: failedJob.jobId,
      status: 'failed',
      errorStage: 'read_reviews',
      errorMessage: 'Base read denied',
    });
    expect(latest.status).toBe(200);
    await expect(latest.json()).resolves.toMatchObject({ resultId: result.resultId });
  });

  it('returns validation errors with stage/message for invalid JSON and missing query params', async () => {
    const { service } = createService();

    const invalidJson = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/configs/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      { service },
    );
    const missingQuery = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/results/latest?tenantKey=tenant-a'),
      { service },
    );

    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'invalid JSON body',
    });
    expect(missingQuery.status).toBe(400);
    await expect(missingQuery.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'missing query params: baseUserId, pluginInstanceId, scopeKey',
    });
  });

  it('returns 404 for missing records and 405 for unsupported methods', async () => {
    const { service } = createService();

    const missingJob = await handleBackendAnalysisRequest(
      new Request(
        'http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/job-missing?tenantKey=tenant-a&baseUserId=user-a&pluginInstanceId=plugin-a',
      ),
      { service },
    );
    const wrongMethod = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs', { method: 'GET' }),
      { service },
    );

    expect(missingJob.status).toBe(404);
    await expect(missingJob.json()).resolves.toEqual({
      stage: 'load_config',
      message: 'analysis job not found',
    });
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'method not allowed',
    });
  });

  it('responds to CORS preflight and includes CORS headers on JSON responses', async () => {
    const { service } = createService();

    const preflight = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs', { method: 'OPTIONS' }),
      { service },
    );
    const json = await postJson(service, '/api/hotel-review-ai/configs/upsert', upsertBody);

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect(json.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(json.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
  });

  it('returns stage/message when path params contain malformed percent encoding', async () => {
    const { service } = createService();

    const response = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/%E0%A4%A'),
      { service },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'malformed path parameter',
    });
  });

  it('requires matching ownership query params for job detail requests', async () => {
    const { service } = createService();
    const config = await service.upsertConfig(upsertBody);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    const missingOwnership = await handleBackendAnalysisRequest(
      new Request(`http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/${job.jobId}`),
      { service },
    );
    const wrongUser = await handleBackendAnalysisRequest(
      new Request(
        `http://127.0.0.1:8787/api/hotel-review-ai/analysis-jobs/${job.jobId}?tenantKey=tenant-a&baseUserId=user-b&pluginInstanceId=plugin-a`,
      ),
      { service },
    );

    expect(missingOwnership.status).toBe(400);
    await expect(missingOwnership.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'missing query params: tenantKey, baseUserId, pluginInstanceId',
    });
    expect(wrongUser.status).toBe(404);
    await expect(wrongUser.json()).resolves.toEqual({
      stage: 'load_config',
      message: 'analysis job not found',
    });
  });

  it('requires ownership query params for topic evidence requests', async () => {
    const { service } = createService();

    const response = await handleBackendAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/results/result-1/topics/topic-location/evidence?page=1&pageSize=20'),
      { service },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      stage: 'validate_request',
      message: 'missing query params: tenantKey, baseUserId, pluginInstanceId, scopeKey',
    });
  });
});

function createExportableSummary() {
  return {
    analysisId: 'analysis-1',
    generatedAt: '2026-06-18T11:00:00.000Z',
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
