import {
  BACKEND_ANALYSIS_PIPELINE_VERSION,
  BackendAnalysisError,
  buildAnalysisScopeKey,
  type AnalysisBackendService,
  type AnalysisBackendStore,
  type AnalysisResult,
  type AnalysisStage,
  type JsonValue,
  type TopicEvidence,
} from './backendAnalysis';
import type { ReviewRecord, ReviewSource, ReviewSourceKind, ReviewSourceQuery } from './reviewSource';

export type AnalysisRunnerResult = {
  summary: JsonValue;
  topics: JsonValue[];
  evidenceByTopic: Record<string, TopicEvidence[]>;
};

export type AnalysisRunner = {
  run(input: {
    reviews: ReviewRecord[];
    query: ReviewSourceQuery;
    jobId: string;
    pipelineVersion: string;
  }): Promise<AnalysisRunnerResult>;
};

export type AnalysisJobWorkerOptions = {
  service: AnalysisBackendService;
  store: AnalysisBackendStore;
  reviewSources: Partial<Record<ReviewSourceKind, ReviewSource>>;
  runner: AnalysisRunner;
  pipelineVersion?: string;
  now?: () => string;
};

export class AnalysisJobWorker {
  private readonly service: AnalysisBackendService;
  private readonly store: AnalysisBackendStore;
  private readonly reviewSources: Partial<Record<ReviewSourceKind, ReviewSource>>;
  private readonly runner: AnalysisRunner;
  private readonly pipelineVersion: string;
  private readonly now: () => string;

  constructor(options: AnalysisJobWorkerOptions) {
    this.service = options.service;
    this.store = options.store;
    this.reviewSources = options.reviewSources;
    this.runner = options.runner;
    this.pipelineVersion = options.pipelineVersion ?? BACKEND_ANALYSIS_PIPELINE_VERSION;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runAnalysisJob(jobId: string): Promise<AnalysisResult> {
    let job = await this.store.claimJob(jobId, this.now());
    if (!job) {
      throw new BackendAnalysisError(409, 'load_config', 'analysis job is not queued');
    }

    try {
      const config = await this.store.getConfig(job.configId);
      if (!config) {
        throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
      }

      job = await this.store.updateJob({ ...job, stage: 'resolve_source', progress: 15 });
      const source = this.reviewSources[config.source.kind];
      if (!source) {
        throw new BackendAnalysisError(400, 'resolve_source', `review source ${config.source.kind} is not configured`);
      }
      const query: ReviewSourceQuery = {
        tenantKey: config.tenantKey,
        baseToken: config.baseToken,
        tableId: config.source.tableId,
        viewId: config.source.viewId,
        fieldMapping: config.source.fieldMapping,
        filters: config.filters,
        hostScope: config.dashboardDataConditions,
        sourceConfig: Object.fromEntries(
          Object.entries(config.source).filter(([key]) => !['kind', 'tableId', 'viewId', 'fieldMapping'].includes(key)),
        ) as ReviewSourceQuery['sourceConfig'],
      };
      job = await this.store.updateJob({ ...job, stage: 'read_reviews', progress: 30 });
      const reviews = await source.listReviews(query);
      console.info(
        '__HOTEL_REVIEW_AI_READ_REVIEWS__',
        JSON.stringify({
          jobId: job.jobId,
          sourceKind: config.source.kind,
          tableId: config.source.tableId ?? null,
          viewId: config.source.viewId ?? null,
          reviewCount: reviews.length,
          firstRecordId: reviews[0]?.recordId ?? null,
          lastRecordId: reviews[reviews.length - 1]?.recordId ?? null,
        }),
      );
      const sourceVersion = await source.getSourceVersion(query, reviews);
      const actualScopeKey = buildAnalysisScopeKey({
        pipelineVersion: this.pipelineVersion,
        model: config.model,
        sourceVersion,
        source: config.source,
        filters: config.filters,
        dashboardDataConditions: config.dashboardDataConditions,
      });
      if (actualScopeKey !== job.scopeKey) {
        const scopedJob = await this.store.updateJobScopeIfNoActiveConflict({ jobId: job.jobId, scopeKey: actualScopeKey });
        if (!scopedJob) {
          throw new BackendAnalysisError(409, 'resolve_source', 'analysis job scope changed and another active job already exists');
        }
        job = scopedJob;
      }

      job = await this.store.updateJob({ ...job, stage: 'extract_evidence', progress: 55 });
      const runnerResult = await this.runRunner({
        reviews,
        query,
        jobId: job.jobId,
        pipelineVersion: this.pipelineVersion,
      });

      job = await this.store.updateJob({ ...job, stage: 'merge_topics', progress: 75 });
      job = await this.store.updateJob({ ...job, stage: 'build_result', progress: 85 });
      job = await this.store.updateJob({ ...job, stage: 'save_result', progress: 95 });

      const result = await this.store.saveResult({
        tenantKey: job.tenantKey,
        baseUserId: job.baseUserId,
        pluginInstanceId: job.pluginInstanceId,
        scopeKey: job.scopeKey,
        jobId: job.jobId,
        configId: job.configId,
        configVersion: job.configVersion,
        sourceVersion,
        pipelineVersion: this.pipelineVersion,
        summary: runnerResult.summary,
        topics: runnerResult.topics,
      });
      await this.store.saveEvidence(result.resultId, runnerResult.evidenceByTopic);
      const publishedJob = await this.store.finalizeSuccessfulJob({ jobId: job.jobId, resultId: result.resultId });
      if (!publishedJob) {
        throw new BackendAnalysisError(500, 'save_result', 'failed to finalize analysis job result');
      }

      return result;
    } catch (cause) {
      const failedJob = await this.service.getJob(jobId);
      const error = normalizeWorkerError(cause, failedJob.stage);
      await this.store.updateJob({
        ...failedJob,
        status: 'failed',
        errorStage: error.stage,
        errorMessage: error.message,
        finishedAt: this.now(),
      });
      throw error;
    }
  }

  private async runRunner(input: Parameters<AnalysisRunner['run']>[0]): Promise<AnalysisRunnerResult> {
    try {
      return await this.runner.run(input);
    } catch (cause) {
      if (cause instanceof BackendAnalysisError) {
        throw cause;
      }
      throw new BackendAnalysisError(500, 'extract_evidence', cause instanceof Error ? cause.message : String(cause));
    }
  }
}

function normalizeWorkerError(cause: unknown, currentStage: AnalysisStage): BackendAnalysisError {
  if (cause instanceof BackendAnalysisError) {
    return cause;
  }
  return new BackendAnalysisError(500, currentStage, cause instanceof Error ? cause.message : String(cause));
}
