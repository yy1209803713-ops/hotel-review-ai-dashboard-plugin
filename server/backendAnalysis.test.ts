import { describe, expect, it, vi } from 'vitest';
import {
  AnalysisBackendService,
  buildScopeKey,
  canonicalJson,
  completeAnalysisJobForTest,
  createConfiguredReviewSources,
  createInMemoryAnalysisBackendStore,
  DefaultDeterministicReviewSource,
  type AnalysisBackendStore,
  type BaseSummaryExporter,
  type BackendAnalysisConfigUpsertRequest,
  type SourceVersion,
} from './backendAnalysis';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';

const baseConfigRequest: BackendAnalysisConfigUpsertRequest = {
  tenantKey: 'tenant-a',
  baseUserId: 'user-a',
  pluginInstanceId: 'plugin-a',
  baseToken: 'base-token-a',
  source: {
    kind: 'feishu_base',
    tableId: 'tbl-review',
    viewId: 'vew-active',
    fieldMapping: {
      rating: 'fld-rating',
      reviewText: 'fld-review',
      hotelName: 'fld-hotel',
    },
  },
  filters: {
    sentiment: ['positive', 'negative'],
    dateRange: { from: '2026-06-01', to: '2026-06-18' },
  },
  dashboardDataConditions: {
    groups: [{ fieldId: 'fld-city', values: ['Shanghai'] }],
  },
};

describe('backend analysis scope helpers', () => {
  it('serializes object keys in stable order for equivalent descriptors', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(canonicalJson({ a: { c: 3, d: 4 }, b: 2 })).toBe(canonicalJson({ b: 2, a: { d: 4, c: 3 } }));
  });

  it('builds the same scopeKey when descriptor key order changes', () => {
    const scopeA = buildScopeKey({
      pipelineVersion: 'backend-owned-v1',
      config: {
        filters: { b: 2, a: 1 },
        source: { tableId: 'tbl-review', fieldMapping: { reviewText: 'fld-review', rating: 'fld-rating' } },
      },
    });
    const scopeB = buildScopeKey({
      config: {
        source: { fieldMapping: { rating: 'fld-rating', reviewText: 'fld-review' }, tableId: 'tbl-review' },
        filters: { a: 1, b: 2 },
      },
      pipelineVersion: 'backend-owned-v1',
    });

    expect(scopeA).toBe(scopeB);
    expect(scopeA).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('AnalysisBackendService', () => {
  it('fails scope resolution with resolve_source when no ReviewSource is configured for the source kind', async () => {
    const service = new AnalysisBackendService({ store: createInMemoryAnalysisBackendStore() });
    const config = await service.upsertConfig(baseConfigRequest);

    await expect(
      service.resolveScope({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: config.configId,
      }),
    ).rejects.toMatchObject({
      stage: 'resolve_source',
      message: 'review source feishu_base is not configured',
    });
  });

  it('fails job creation with resolve_source when no ReviewSource is configured for the source kind', async () => {
    const service = new AnalysisBackendService({ store: createInMemoryAnalysisBackendStore() });
    const config = await service.upsertConfig(baseConfigRequest);

    await expect(
      service.createOrGetAnalysisJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: config.configId,
      }),
    ).rejects.toMatchObject({
      stage: 'resolve_source',
      message: 'review source feishu_base is not configured',
    });
  });

  it('upserts config versions for the same tenant/user/plugin identity', async () => {
    const service = createServiceWithDefaultSources();

    const first = await service.upsertConfig(baseConfigRequest);
    const second = await service.upsertConfig({
      ...baseConfigRequest,
      filters: { sentiment: ['positive'] },
    });

    expect(first.configVersion).toBe(1);
    expect(second.configId).toBe(first.configId);
    expect(second.configVersion).toBe(2);
  });

  it('resolves current scope with deterministic SourceVersion and configVersion', async () => {
    const service = createServiceWithDefaultSources();
    const config = await service.upsertConfig(baseConfigRequest);

    const scope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    expect(scope.configVersion).toBe(1);
    expect(scope.scopeKey).toMatch(/^[a-f0-9]{64}$/);
    expect(scope.sourceVersion).toMatchObject({
      kind: 'feishu_base',
      sourceId: 'base-token-a:tbl-review',
      version: expect.stringMatching(/^source-/),
      recordCount: 0,
    });
    expect(scope.sourceVersion.generatedAt).toBe('deterministic');
  });

  it('rejects source kinds outside the backend-owned ReviewSourceKind contract', async () => {
    const service = createServiceWithDefaultSources();

    await expect(
      service.upsertConfig({
        ...baseConfigRequest,
        source: { ...baseConfigRequest.source, kind: 'base_table' as never },
      }),
    ).rejects.toMatchObject({
      stage: 'validate_request',
      message: 'source.kind must be feishu_base, postgres, or external',
    });
  });

  it('requires feishu_base baseToken and source.tableId', async () => {
    const service = createServiceWithDefaultSources();

    await expect(
      service.upsertConfig({
        ...baseConfigRequest,
        baseToken: '',
      }),
    ).rejects.toMatchObject({
      stage: 'validate_request',
      message: 'baseToken is required for feishu_base source',
    });
    await expect(
      service.upsertConfig({
        ...baseConfigRequest,
        source: { ...baseConfigRequest.source, tableId: '' },
      }),
    ).rejects.toMatchObject({
      stage: 'validate_request',
      message: 'source.tableId is required for feishu_base source',
    });
  });

  it('requires every fieldMapping value to be a non-empty string', async () => {
    const service = createServiceWithDefaultSources();

    await expect(
      service.upsertConfig({
        ...baseConfigRequest,
        source: {
          ...baseConfigRequest.source,
          fieldMapping: { ...baseConfigRequest.source.fieldMapping, reviewText: '   ' },
        },
      }),
    ).rejects.toMatchObject({
      stage: 'validate_request',
      message: 'source.fieldMapping.reviewText must be a non-empty string',
    });
  });

  it('uses stable request fields for postgres and external source identifiers without runtime reads', async () => {
    const service = createServiceWithDefaultSources();
    const postgresConfig = await service.upsertConfig({
      ...baseConfigRequest,
      source: {
        kind: 'postgres',
        connectionId: 'pg-main',
        tableId: 'hotel_reviews',
        fieldMapping: baseConfigRequest.source.fieldMapping,
      },
    });
    const externalConfig = await service.upsertConfig({
      ...baseConfigRequest,
      pluginInstanceId: 'plugin-external',
      source: {
        kind: 'external',
        datasetId: 'dataset-reviews',
        fieldMapping: baseConfigRequest.source.fieldMapping,
      },
    });

    await expect(
      service.resolveScope({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: postgresConfig.configId,
      }),
    ).resolves.toMatchObject({
      sourceVersion: { kind: 'postgres', sourceId: 'pg-main', recordCount: 0, generatedAt: 'deterministic' },
    });
    await expect(
      service.resolveScope({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-external',
        configId: externalConfig.configId,
      }),
    ).resolves.toMatchObject({
      sourceVersion: { kind: 'external', sourceId: 'dataset-reviews', recordCount: 0, generatedAt: 'deterministic' },
    });
  });

  it('creates a job for a postgres read model config without triggering sync', async () => {
    const postgresSource = new MutableFakeReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store: createInMemoryAnalysisBackendStore(),
      reviewSources: { postgres: postgresSource },
    });
    const config = await service.upsertConfig({
      ...baseConfigRequest,
      source: {
        kind: 'postgres',
        sourceId: 'base-token-a:tbl-review',
        upstreamSourceKind: 'feishu_base',
        tableId: 'tbl-review',
        viewId: 'vew-active',
        fieldMapping: baseConfigRequest.source.fieldMapping,
      },
    });

    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    expect(postgresSource.queries).toHaveLength(1);
    expect(job.status).toBe('queued');
  });

  it('keeps the same scopeKey when the same config content is saved as a newer version', async () => {
    const service = createServiceWithDefaultSources();
    const firstConfig = await service.upsertConfig(baseConfigRequest);
    const firstScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: firstConfig.configId,
    });
    const secondConfig = await service.upsertConfig(baseConfigRequest);
    const secondScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: secondConfig.configId,
    });

    expect(secondConfig.configVersion).toBe(2);
    expect(secondScope.scopeKey).toBe(firstScope.scopeKey);
  });

  it('uses injected ReviewSource source version so scopeKey changes when source data changes', async () => {
    const source = new MutableFakeReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store: createInMemoryAnalysisBackendStore(),
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);

    const firstScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    source.reviews = [review('rec-1', 'Great view'), review('rec-2', 'Noisy room')];
    const secondScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    expect(source.queries).toHaveLength(2);
    expect(firstScope.sourceVersion.recordCount).toBe(1);
    expect(secondScope.sourceVersion.recordCount).toBe(2);
    expect(secondScope.sourceVersion.contentHash).not.toBe(firstScope.sourceVersion.contentHash);
    expect(secondScope.scopeKey).not.toBe(firstScope.scopeKey);
  });

  it('keeps the same scopeKey when only sourceVersion.generatedAt changes', async () => {
    const source = new ChangingGeneratedAtReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store: createInMemoryAnalysisBackendStore(),
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);

    const firstScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const secondScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    expect(source.calls).toBe(2);
    expect(firstScope.sourceVersion.contentHash).toBe(secondScope.sourceVersion.contentHash);
    expect(firstScope.sourceVersion.recordCount).toBe(secondScope.sourceVersion.recordCount);
    expect(firstScope.scopeKey).toBe(secondScope.scopeKey);
  });

  it('reuses a queued/running job even when forceRefresh is true to avoid duplicate active work', async () => {
    const service = createServiceWithDefaultSources();
    const config = await service.upsertConfig(baseConfigRequest);

    const first = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const repeated = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
      forceRefresh: true,
    });

    expect(first.status).toBe('queued');
    expect(repeated.jobId).toBe(first.jobId);
  });

  it('creates a new queued job after the existing job succeeds regardless of forceRefresh', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);

    const first = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    await completeAnalysisJobForTest({ service, store }, first.jobId, {
      summary: { totalReviews: 1 },
      topics: [],
      evidenceByTopic: {},
    });
    const nextWithoutForce = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    await completeAnalysisJobForTest({ service, store }, nextWithoutForce.jobId, {
      summary: { totalReviews: 2 },
      topics: [],
      evidenceByTopic: {},
    });
    const nextWithForce = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
      forceRefresh: true,
    });

    expect(nextWithoutForce.status).toBe('queued');
    expect(nextWithoutForce.scopeKey).toBe(first.scopeKey);
    expect(nextWithoutForce.jobId).not.toBe(first.jobId);
    expect(nextWithForce.status).toBe('queued');
    expect(nextWithForce.scopeKey).toBe(first.scopeKey);
    expect(nextWithForce.jobId).not.toBe(nextWithoutForce.jobId);
  });

  it('creates separate jobs per user while allowing the same scopeKey', async () => {
    const service = createServiceWithDefaultSources();
    const config = await service.upsertConfig(baseConfigRequest);
    const first = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const otherUserConfig = await service.upsertConfig({
      ...baseConfigRequest,
      baseUserId: 'user-b',
      pluginInstanceId: 'plugin-a',
    });
    const otherUser = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-b',
      pluginInstanceId: 'plugin-a',
      configId: otherUserConfig.configId,
    });

    expect(otherUser.scopeKey).toBe(first.scopeKey);
    expect(otherUser.jobId).not.toBe(first.jobId);
  });

  it('reads current job, job detail, latest result, and paged topic evidence', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });

    await completeAnalysisJobForTest({ service, store }, job.jobId, {
      summary: { totalReviews: 2, topicCount: 1 },
      topics: [{ topicId: 'topic-cleanliness', label: 'Cleanliness' }],
      evidenceByTopic: {
        'topic-cleanliness': [
          { evidenceId: 'ev-1', recordId: 'rec-1', quote: 'Room was clean', sentiment: 'positive' },
          { evidenceId: 'ev-1b', recordId: 'rec-1', quote: 'Bed was tidy', sentiment: 'positive' },
          { evidenceId: 'ev-2', recordId: 'rec-2', quote: 'Bathroom was spotless', sentiment: 'positive' },
        ],
      },
    });

    await expect(
      service.getCurrentJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).resolves.toMatchObject({ jobId: job.jobId, status: 'success', resultId: expect.stringMatching(/^result-/) });
    await expect(service.getJob(job.jobId)).resolves.toMatchObject({
      jobId: job.jobId,
      status: 'success',
      stage: 'save_result',
      progress: 100,
      resultId: expect.stringMatching(/^result-/),
    });
    const latest = await service.getLatestResult({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      scopeKey: job.scopeKey,
    });
    expect(latest).toMatchObject({
      resultId: expect.stringMatching(/^result-/),
      summary: { totalReviews: 2, topicCount: 1 },
    });
    await expect(
      service.getTopicEvidence({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
        resultId: latest.resultId,
        topicId: 'topic-cleanliness',
        page: 2,
        pageSize: 1,
      }),
    ).resolves.toEqual({
      resultId: latest.resultId,
      topicId: 'topic-cleanliness',
      page: 2,
      pageSize: 1,
      total: 2,
      evidence: [{
        evidenceId: 'ev-2',
        recordId: 'rec-2',
        quote: 'Bathroom was spotless',
        quotes: ['Bathroom was spotless'],
        sentiment: 'positive',
      }],
    });
    await expect(
      service.getTopicEvidence({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
        resultId: latest.resultId,
        topicId: 'topic-cleanliness',
        page: 1,
        pageSize: 1,
      }),
    ).resolves.toEqual({
      resultId: latest.resultId,
      topicId: 'topic-cleanliness',
      page: 1,
      pageSize: 1,
      total: 2,
      evidence: [{
        evidenceId: 'ev-1',
        recordId: 'rec-1',
        quote: 'Room was clean',
        quotes: ['Room was clean', 'Bed was tidy'],
        sentiment: 'positive',
      }],
    });
  });

  it.each(['failed', 'canceled'] as const)(
    'returns the latest %s current job instead of hiding it behind an older successful result',
    async (terminalStatus) => {
      const store = createInMemoryAnalysisBackendStore();
      const service = createServiceWithDefaultSources(store);
      const config = await service.upsertConfig(baseConfigRequest);
      const successfulJob = await service.createOrGetAnalysisJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: config.configId,
      });
      const successfulResult = await completeAnalysisJobForTest({ service, store }, successfulJob.jobId, {
        summary: { totalReviews: 2 },
        topics: [],
        evidenceByTopic: {},
      });
      const terminalJob = await service.createOrGetAnalysisJob({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        configId: config.configId,
      });
      const claimedTerminalJob = await store.claimJob(terminalJob.jobId, 'started-terminal');
      expect(claimedTerminalJob).toBeDefined();
      await store.updateJob({
        ...claimedTerminalJob!,
        status: terminalStatus,
        stage: 'read_reviews',
        progress: terminalStatus === 'failed' ? 35 : 0,
        finishedAt: `finished-${terminalStatus}`,
        errorStage: terminalStatus === 'failed' ? 'read_reviews' : 'validate_request',
        errorMessage: terminalStatus === 'failed' ? 'Base read denied' : 'analysis job canceled',
      });

      await expect(
        service.getCurrentJob({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          scopeKey: successfulJob.scopeKey,
        }),
      ).resolves.toMatchObject({
        jobId: terminalJob.jobId,
        status: terminalStatus,
        errorMessage: terminalStatus === 'failed' ? 'Base read denied' : 'analysis job canceled',
      });
      await expect(
        service.getLatestResult({
          tenantKey: 'tenant-a',
          baseUserId: 'user-a',
          pluginInstanceId: 'plugin-a',
          scopeKey: successfulJob.scopeKey,
        }),
      ).resolves.toMatchObject({ resultId: successfulResult.resultId });
    },
  );

  it('does not finalize a job with a result owned by another job', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);
    const firstJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    await store.claimJob(firstJob.jobId, 'started-1');
    const firstResult = await store.saveResult({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      scopeKey: firstJob.scopeKey,
      jobId: firstJob.jobId,
      configId: firstJob.configId,
      configVersion: firstJob.configVersion,
      sourceVersion: fakeSourceVersion(),
      pipelineVersion: 'backend-owned-v1',
      summary: {},
      topics: [],
    });
    await store.updateJob({ ...(await service.getJob(firstJob.jobId)), status: 'failed' });
    const secondJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
      forceRefresh: true,
    });
    await store.claimJob(secondJob.jobId, 'started-2');

    await expect(store.finalizeSuccessfulJob({ jobId: secondJob.jobId, resultId: firstResult.resultId })).resolves.toBeUndefined();
    const secondJobAfterFinalizeAttempt = await service.getJob(secondJob.jobId);
    expect(secondJobAfterFinalizeAttempt.status).toBe('running');
    expect(secondJobAfterFinalizeAttempt.resultId).toBeUndefined();
  });

  it('does not expose topic evidence for unpublished results', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    await store.claimJob(job.jobId, 'started-1');
    const result = await store.saveResult({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      scopeKey: job.scopeKey,
      jobId: job.jobId,
      configId: job.configId,
      configVersion: job.configVersion,
      sourceVersion: fakeSourceVersion(),
      pipelineVersion: 'backend-owned-v1',
      summary: {},
      topics: [],
    });
    await store.saveEvidence(result.resultId, {
      'topic-location': [{ evidenceId: 'ev-1', recordId: 'rec-1', quote: 'Great location', sentiment: 'positive' }],
    });

    await expect(
      service.getTopicEvidence({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
        resultId: result.resultId,
        topicId: 'topic-location',
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'topic evidence not found',
    });
  });

  it('requires topic evidence ownership to match the published result scope', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const result = await completeAnalysisJobForTest({ service, store }, job.jobId, {
      summary: { totalReviews: 1 },
      topics: [{ topicId: 'topic-location' }],
      evidenceByTopic: {
        'topic-location': [{ evidenceId: 'ev-1', recordId: 'rec-1', quote: 'Great location', sentiment: 'positive' }],
      },
    });

    await expect(
      service.getTopicEvidence({
        tenantKey: 'tenant-a',
        baseUserId: 'user-b',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
        resultId: result.resultId,
        topicId: 'topic-location',
        page: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'topic evidence not found',
    });
  });

  it('fails base summary export explicitly when no exporter is configured', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const service = createServiceWithDefaultSources(store);
    const config = await service.upsertConfig(baseConfigRequest);
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

    await expect(
      service.exportBaseSummary(result.resultId, {
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).rejects.toMatchObject({
      stage: 'export_summary',
      message: 'base summary exporter is not configured',
    });
  });

  it('exports only a published result owned by the requested user scope', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const exporter: BaseSummaryExporter = {
      exportBaseSummary: async ({ result, config }) => {
        expect(result.resultId).toMatch(/^result-/);
        expect(result.pipelineVersion).toBe('backend-owned-v1');
        expect(config.baseToken).toBe('base-token-a');
        return {
          resultId: result.resultId,
          summaryTableId: 'tbl-summary',
          topicTableId: 'tbl-topic',
          summaryRecordIds: ['rec-summary'],
          topicRecordIds: ['rec-topic'],
          exportedAt: '2026-06-18T12:00:00.000Z',
        };
      },
    };
    const service = createServiceWithDefaultSources(store, exporter);
    const config = await service.upsertConfig(baseConfigRequest);
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

    await expect(
      service.exportBaseSummary(result.resultId, {
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).resolves.toEqual({
      resultId: result.resultId,
      summaryTableId: 'tbl-summary',
      topicTableId: 'tbl-topic',
      summaryRecordIds: ['rec-summary'],
      topicRecordIds: ['rec-topic'],
      exportedAt: '2026-06-18T12:00:00.000Z',
    });

    await expect(
      service.exportBaseSummary(result.resultId, {
        tenantKey: 'tenant-a',
        baseUserId: 'user-b',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'analysis result not found',
    });
  });

  it('deduplicates active job creation inside the store contract', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const jobInput = {
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: 'config-a',
      configVersion: 1,
      scopeKey: 'scope-a',
      status: 'queued' as const,
      stage: 'validate_request' as const,
      progress: 0,
    };

    const first = await store.createOrGetActiveJob(jobInput);
    const second = await store.createOrGetActiveJob(jobInput);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
  });
});

function createServiceWithDefaultSources(
  store: AnalysisBackendStore = createInMemoryAnalysisBackendStore(),
  baseSummaryExporter?: BaseSummaryExporter,
): AnalysisBackendService {
  return new AnalysisBackendService({
    store,
    reviewSources: createConfiguredReviewSources({
      feishuBase: new DefaultDeterministicReviewSource('feishu_base'),
      postgres: new DefaultDeterministicReviewSource('postgres'),
      external: new DefaultDeterministicReviewSource('external'),
    }),
    baseSummaryExporter,
  });
}

function createExportableSummary() {
  return {
    analysisId: 'analysis-1',
    generatedAt: '2026-06-18T11:00:00.000Z',
    model: 'qwen-plus',
    status: 'complete',
    scope: { hotelName: 'all', periodType: 'month', startDate: '', endDate: '' },
    overview: {
      totalReviews: 2,
      positiveReviews: 1,
      negativeOrRiskReviews: 1,
      mixedReviews: 0,
      neutralReviews: 0,
      averageScore: 4.5,
      replyRate: 0.5,
    },
    positiveTopics: [],
    negativeTopics: [],
    actionItems: [],
  };
}

function review(recordId: string, content: string): ReviewRecord {
  return {
    recordId,
    fields: { 'fld-review': content },
    mappedFields: { content },
    content,
    contentHash: `${recordId}-${content}`,
  };
}

function fakeSourceVersion(): SourceVersion {
  return {
    kind: 'feishu_base',
    sourceId: 'base-token-a:tbl-review',
    version: 'source-fake',
    contentHash: 'fake',
    generatedAt: 'fake-now',
    recordCount: 1,
  };
}

class MutableFakeReviewSource implements ReviewSource {
  readonly kind = 'feishu_base' as const;
  readonly queries: ReviewSourceQuery[] = [];

  constructor(public reviews: ReviewRecord[]) {}

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    this.queries.push(query);
    return this.reviews;
  }

  async getSourceVersion(query: ReviewSourceQuery): Promise<SourceVersion> {
    this.queries.push(query);
    const contentHash = this.reviews.map((item) => `${item.recordId}:${item.contentHash}`).join('|') || 'empty';
    return {
      kind: 'feishu_base',
      sourceId: `${query.baseToken}:${query.tableId}`,
      version: `source-${contentHash}`,
      contentHash,
      generatedAt: 'fake-now',
      recordCount: this.reviews.length,
    };
  }
}

class ChangingGeneratedAtReviewSource implements ReviewSource {
  readonly kind = 'feishu_base' as const;
  readonly queries: ReviewSourceQuery[] = [];
  calls = 0;

  constructor(private readonly reviews: ReviewRecord[]) {}

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    this.queries.push(query);
    return this.reviews;
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews = this.reviews): Promise<SourceVersion> {
    this.queries.push(query);
    this.calls += 1;
    const contentHash = reviews.map((item) => `${item.recordId}:${item.contentHash}`).join('|') || 'empty';
    return {
      kind: 'feishu_base',
      sourceId: `${query.baseToken}:${query.tableId}`,
      version: `source-${contentHash}`,
      contentHash,
      generatedAt: `fake-now-${this.calls}`,
      recordCount: reviews.length,
    };
  }
}
