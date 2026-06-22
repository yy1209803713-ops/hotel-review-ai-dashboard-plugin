import { describe, expect, it } from 'vitest';
import {
  AnalysisBackendService,
  BackendAnalysisError,
  createInMemoryAnalysisBackendStore,
  type BackendAnalysisConfigUpsertRequest,
  type SourceVersion,
  type TopicEvidence,
} from './backendAnalysis';
import { AnalysisJobWorker, type AnalysisRunner } from './analysisWorker';
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
      content: 'fld-review',
      rating: 'fld-rating',
      hotelName: 'fld-hotel',
    },
  },
  filters: { hotelName: 'all' },
};

describe('AnalysisJobWorker', () => {
  it('runs a queued job to success, saves latest result, and passes ReviewRecord[] to the runner', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new FakeReviewSource([
      review('rec-1', 'Great view'),
      review('rec-2', 'Noisy room'),
    ]);
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const runnerCalls: ReviewRecord[][] = [];
    const runner: AnalysisRunner = {
      async run({ reviews }) {
        runnerCalls.push(reviews);
        return {
          summary: { totalReviews: reviews.length },
          topics: [{ topicId: 'topic-view', label: 'View' }],
          evidenceByTopic: {
            'topic-view': [{ evidenceId: 'ev-1', recordId: reviews[0]?.recordId, quote: reviews[0]?.content, sentiment: 'positive' }],
          },
        };
      },
    };
    const worker = new AnalysisJobWorker({ service, store, reviewSources: { feishu_base: source }, runner });

    const result = await worker.runAnalysisJob(job.jobId);

    expect(runnerCalls).toEqual([[review('rec-1', 'Great view'), review('rec-2', 'Noisy room')]]);
    const completedJob = await service.getJob(job.jobId);
    expect(completedJob).toMatchObject({
      status: 'success',
      stage: 'save_result',
      progress: 100,
      resultId: result.resultId,
    });
    expect(completedJob.errorStage).toBeUndefined();
    expect(completedJob.errorMessage).toBeUndefined();
    await expect(
      service.getLatestResult({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).resolves.toMatchObject({
      resultId: result.resultId,
      summary: { totalReviews: 2 },
      topics: [{ topicId: 'topic-view', label: 'View' }],
    });
    await expect(
      service.getTopicEvidence({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
        resultId: result.resultId,
        topicId: 'topic-view',
        page: 1,
        pageSize: 10,
      }),
    ).resolves.toMatchObject({
      total: 1,
      evidence: [{ evidenceId: 'ev-1', recordId: 'rec-1', quote: 'Great view', sentiment: 'positive' }],
    });
  });

  it('reads reviews once and saves SourceVersion from the same reviews passed to the runner', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new SingleReadChangingReviewSource([review('rec-actual', 'Actual review')]);
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const runnerCalls: ReviewRecord[][] = [];
    const worker = new AnalysisJobWorker({
      service,
      store,
      reviewSources: { feishu_base: source },
      runner: {
        async run({ reviews }) {
          runnerCalls.push(reviews);
          return { summary: { totalReviews: reviews.length }, topics: [], evidenceByTopic: {} };
        },
      },
    });

    const result = await worker.runAnalysisJob(job.jobId);

    expect(source.listCalls).toBe(1);
    expect(runnerCalls).toEqual([[review('rec-actual', 'Actual review')]]);
    expect(result.sourceVersion).toMatchObject({
      recordCount: 1,
      contentHash: 'rec-actual:rec-actual-hash',
      version: 'source-rec-actual:rec-actual-hash',
    });
  });

  it('updates the job/result scopeKey to the source version that was actually analyzed', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new SourceChangesBeforeWorkerReadSource({
      preflightReviews: [review('rec-old', 'Old review')],
      workerReviews: [review('rec-new', 'New review')],
    });
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    source.useWorkerReviewsForScope = true;
    const expectedScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const worker = new AnalysisJobWorker({
      service,
      store,
      reviewSources: { feishu_base: source },
      runner: {
        async run({ reviews }) {
          return { summary: { totalReviews: reviews.length }, topics: [], evidenceByTopic: {} };
        },
      },
    });

    const result = await worker.runAnalysisJob(job.jobId);

    expect(result.scopeKey).toBe(expectedScope.scopeKey);
    await expect(service.getJob(job.jobId)).resolves.toMatchObject({
      scopeKey: expectedScope.scopeKey,
      resultId: result.resultId,
      status: 'success',
    });
    await expect(
      service.getLatestResult({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: expectedScope.scopeKey,
      }),
    ).resolves.toMatchObject({ resultId: result.resultId });
    await expect(
      service.getLatestResult({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'analysis result not found',
    });
  });

  it('fails scope handoff when another active job already owns the actual scope', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new SourceChangesBeforeWorkerReadSource({
      preflightReviews: [review('rec-old', 'Old review')],
      workerReviews: [review('rec-new', 'New review')],
    });
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const firstJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    source.useWorkerReviewsForScope = true;
    const actualScope = await service.resolveScope({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const secondJob = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
      forceRefresh: true,
    });
    await store.claimJob(secondJob.jobId, 'started-2');
    const worker = new AnalysisJobWorker({
      service,
      store,
      reviewSources: { feishu_base: source },
      runner: {
        async run({ reviews }) {
          return { summary: { totalReviews: reviews.length }, topics: [], evidenceByTopic: {} };
        },
      },
    });

    await expect(worker.runAnalysisJob(firstJob.jobId)).rejects.toMatchObject({
      stage: 'resolve_source',
      message: 'analysis job scope changed and another active job already exists',
    });
    expect((await service.getJob(firstJob.jobId)).status).toBe('failed');
    expect((await service.getJob(firstJob.jobId)).scopeKey).toBe(firstJob.scopeKey);
    expect(secondJob.scopeKey).toBe(actualScope.scopeKey);
  });

  it('marks the job failed with stage/message when source reading fails', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new FakeReviewSource([], new BackendAnalysisError(502, 'read_source', 'OpenAPI records read failed'));
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const runner: AnalysisRunner = {
      async run() {
        throw new Error('runner should not be called');
      },
    };
    const worker = new AnalysisJobWorker({ service, store, reviewSources: { feishu_base: source }, runner });

    await expect(worker.runAnalysisJob(job.jobId)).rejects.toMatchObject({
      stage: 'read_source',
      message: 'OpenAPI records read failed',
    });
    await expect(service.getJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      stage: 'read_reviews',
      errorStage: 'read_source',
      errorMessage: 'OpenAPI records read failed',
      finishedAt: expect.any(String),
    });
  });

  it('does not publish latest result when evidence saving fails after result creation', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const failingStore = {
      ...store,
      async saveEvidence(): Promise<void> {
        throw new BackendAnalysisError(500, 'save_result', 'evidence write failed');
      },
    };
    const source = new FakeReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store: failingStore,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const worker = new AnalysisJobWorker({
      service,
      store: failingStore,
      reviewSources: { feishu_base: source },
      runner: {
        async run({ reviews }) {
          return { summary: { totalReviews: reviews.length }, topics: [], evidenceByTopic: {} };
        },
      },
    });

    await expect(worker.runAnalysisJob(job.jobId)).rejects.toMatchObject({
      stage: 'save_result',
      message: 'evidence write failed',
    });
    await expect(service.getJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      errorStage: 'save_result',
      errorMessage: 'evidence write failed',
    });
    await expect(
      service.getLatestResult({
        tenantKey: 'tenant-a',
        baseUserId: 'user-a',
        pluginInstanceId: 'plugin-a',
        scopeKey: job.scopeKey,
      }),
    ).rejects.toMatchObject({
      stage: 'load_config',
      message: 'analysis result not found',
    });
  });

  it('claims queued jobs once so duplicate worker execution does not rerun the runner', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new FakeReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    let runnerCalls = 0;
    const worker = new AnalysisJobWorker({
      service,
      store,
      reviewSources: { feishu_base: source },
      runner: {
        async run({ reviews }) {
          runnerCalls += 1;
          return { summary: { totalReviews: reviews.length }, topics: [], evidenceByTopic: {} };
        },
      },
    });

    await worker.runAnalysisJob(job.jobId);
    await expect(worker.runAnalysisJob(job.jobId)).rejects.toMatchObject({
      stage: 'load_config',
      message: 'analysis job is not queued',
    });

    expect(runnerCalls).toBe(1);
  });

  it('marks the job failed with extract_evidence stage when the runner fails', async () => {
    const store = createInMemoryAnalysisBackendStore();
    const source = new FakeReviewSource([review('rec-1', 'Great view')]);
    const service = new AnalysisBackendService({
      store,
      reviewSources: { feishu_base: source },
    });
    const config = await service.upsertConfig(baseConfigRequest);
    const job = await service.createOrGetAnalysisJob({
      tenantKey: 'tenant-a',
      baseUserId: 'user-a',
      pluginInstanceId: 'plugin-a',
      configId: config.configId,
    });
    const worker = new AnalysisJobWorker({
      service,
      store,
      reviewSources: { feishu_base: source },
      runner: {
        async run() {
          throw new Error('AI schema invalid');
        },
      },
    });

    await expect(worker.runAnalysisJob(job.jobId)).rejects.toMatchObject({
      stage: 'extract_evidence',
      message: 'AI schema invalid',
    });
    await expect(service.getJob(job.jobId)).resolves.toMatchObject({
      status: 'failed',
      errorStage: 'extract_evidence',
      errorMessage: 'AI schema invalid',
    });
  });
});

function review(recordId: string, content: string): ReviewRecord {
  return {
    recordId,
    fields: { 'fld-review': content },
    mappedFields: { content },
    content,
    contentHash: `${recordId}-hash`,
  };
}

class FakeReviewSource implements ReviewSource {
  readonly kind = 'feishu_base' as const;
  readonly queries: ReviewSourceQuery[] = [];

  constructor(
    private readonly reviews: ReviewRecord[],
    private readonly listError?: Error,
  ) {}

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    this.queries.push(query);
    if (this.listError) {
      throw this.listError;
    }
    return this.reviews;
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews = this.reviews): Promise<SourceVersion> {
    const sourceId = `${query.baseToken}:${query.tableId}:${query.viewId ?? ''}`;
    const contentHash = reviews.map((item) => `${item.recordId}:${item.contentHash}`).join('|') || 'empty';
    return {
      kind: 'feishu_base',
      sourceId,
      version: `source-${contentHash}`,
      contentHash,
      generatedAt: 'fake-now',
      recordCount: reviews.length,
    };
  }
}

class SingleReadChangingReviewSource implements ReviewSource {
  readonly kind = 'feishu_base' as const;
  listCalls = 0;
  versionCallsWithoutReviews = 0;

  constructor(private readonly firstRead: ReviewRecord[]) {}

  async listReviews(): Promise<ReviewRecord[]> {
    this.listCalls += 1;
    if (this.listCalls > 1) {
      throw new BackendAnalysisError(502, 'read_source', 'second read should not happen');
    }
    return this.firstRead;
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews?: ReviewRecord[]): Promise<SourceVersion> {
    if (!reviews) {
      this.versionCallsWithoutReviews += 1;
      if (this.versionCallsWithoutReviews > 1) {
        throw new BackendAnalysisError(502, 'read_source', 'worker source version must use already-read reviews');
      }
      return {
        kind: 'feishu_base',
        sourceId: `${query.baseToken}:${query.tableId}:${query.viewId ?? ''}`,
        version: 'source-preflight',
        contentHash: 'preflight',
        generatedAt: 'fake-now',
        recordCount: 0,
      };
    }
    const contentHash = reviews.map((item) => `${item.recordId}:${item.contentHash}`).join('|') || 'empty';
    return {
      kind: 'feishu_base',
      sourceId: `${query.baseToken}:${query.tableId}:${query.viewId ?? ''}`,
      version: `source-${contentHash}`,
      contentHash,
      generatedAt: 'fake-now',
      recordCount: reviews.length,
    };
  }
}

class SourceChangesBeforeWorkerReadSource implements ReviewSource {
  readonly kind = 'feishu_base' as const;
  useWorkerReviewsForScope = false;

  constructor(
    private readonly input: {
      preflightReviews: ReviewRecord[];
      workerReviews: ReviewRecord[];
    },
  ) {}

  async listReviews(): Promise<ReviewRecord[]> {
    return this.input.workerReviews;
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews?: ReviewRecord[]): Promise<SourceVersion> {
    const versionReviews = reviews ?? (this.useWorkerReviewsForScope ? this.input.workerReviews : this.input.preflightReviews);
    const contentHash = versionReviews.map((item) => `${item.recordId}:${item.contentHash}`).join('|') || 'empty';
    return {
      kind: 'feishu_base',
      sourceId: `${query.baseToken}:${query.tableId}:${query.viewId ?? ''}`,
      version: `source-${contentHash}`,
      contentHash,
      generatedAt: 'fake-now',
      recordCount: versionReviews.length,
    };
  }
}
