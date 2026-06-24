import { createHash } from 'node:crypto';

export const BACKEND_ANALYSIS_PIPELINE_VERSION = 'backend-owned-v1';

export type BackendAnalysisSourceKind = 'feishu_base' | 'postgres' | 'external';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BackendAnalysisSourceDescriptor = {
  kind: BackendAnalysisSourceKind;
  tableId?: string;
  viewId?: string;
  fieldMapping: Record<string, string>;
  [key: string]: JsonValue | Record<string, string> | undefined;
};

export type BackendAnalysisConfigUpsertRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  baseToken?: string;
  model?: string;
  source: BackendAnalysisSourceDescriptor;
  filters?: JsonValue;
  dashboardDataConditions?: JsonValue;
};

export type BackendAnalysisConfig = BackendAnalysisConfigUpsertRequest & {
  configId: string;
  configVersion: number;
  updatedAt: string;
};

export type BackendAnalysisConfigUpsertResponse = {
  configId: string;
  configVersion: number;
};

export type SourceVersion = {
  kind: BackendAnalysisSourceKind;
  sourceId: string;
  version: string;
  contentHash: string;
  generatedAt: string;
  recordCount: number;
};

export type ResolveScopeRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  configId: string;
};

export type ResolveScopeResponse = {
  scopeKey: string;
  sourceVersion: SourceVersion;
  configVersion: number;
};

export type AnalysisJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export type AnalysisStage =
  | 'validate_request'
  | 'load_config'
  | 'resolve_source'
  | 'sync_source'
  | 'read_source'
  | 'read_reviews'
  | 'read_evidence_cache'
  | 'extract_evidence'
  | 'save_evidence_cache'
  | 'read_topic_mapping_cache'
  | 'merge_topics'
  | 'save_topic_mapping_cache'
  | 'build_result'
  | 'save_result'
  | 'export_summary';

export type CreateAnalysisJobRequest = ResolveScopeRequest & {
  /**
   * Current Task 2 semantics: active queued/running work is always reused to
   * avoid duplicate jobs. Completed/latest successful results are never reused;
   * a new queued job is created after prior work reaches a terminal status,
   * whether forceRefresh is true or false.
   */
  forceRefresh?: boolean;
};

export type CreateAnalysisJobResponse = {
  jobId: string;
  scopeKey: string;
  status: AnalysisJobStatus;
  created: boolean;
};

export type ExportBaseSummaryRequest = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  scopeKey: string;
};

export type ExportBaseSummaryResponse = {
  resultId: string;
  summaryTableId: string;
  topicTableId: string;
  summaryRecordIds: string[];
  topicRecordIds: string[];
  exportedAt: string;
};

export type AnalysisJob = {
  jobId: string;
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  configId: string;
  configVersion: number;
  scopeKey: string;
  status: AnalysisJobStatus;
  stage: AnalysisStage;
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorStage?: AnalysisStage;
  errorMessage?: string;
  resultId?: string;
};

export type AnalysisResult = {
  resultId: string;
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
  scopeKey: string;
  jobId: string;
  configId: string;
  configVersion: number;
  sourceVersion: SourceVersion;
  pipelineVersion: string;
  summary: JsonValue;
  topics: JsonValue[];
  createdAt: string;
};

export type BaseSummaryExportInput = {
  result: AnalysisResult;
  config: BackendAnalysisConfig;
};

export type BaseSummaryExporter = {
  exportBaseSummary(input: BaseSummaryExportInput): Promise<ExportBaseSummaryResponse>;
};

export type TopicEvidence = {
  evidenceId: string;
  recordId?: string;
  quote?: string;
  sentiment?: string;
  [key: string]: JsonValue | undefined;
};

export type TopicEvidencePage = {
  resultId: string;
  topicId: string;
  page: number;
  pageSize: number;
  total: number;
  evidence: TopicEvidence[];
};

export type CompleteJobForTestInput = {
  summary: JsonValue;
  topics: JsonValue[];
  evidenceByTopic: Record<string, TopicEvidence[]>;
};

export type AnalysisBackendStore = {
  upsertConfig(input: BackendAnalysisConfigUpsertRequest): Promise<BackendAnalysisConfig>;
  getConfig(configId: string): Promise<BackendAnalysisConfig | undefined>;
  findActiveJob(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisJob | undefined>;
  getLatestJob(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisJob | undefined>;
  createJob(input: Omit<AnalysisJob, 'jobId' | 'createdAt'>): Promise<AnalysisJob>;
  createOrGetActiveJob(input: Omit<AnalysisJob, 'jobId' | 'createdAt'>): Promise<{ job: AnalysisJob; created: boolean }>;
  claimJob(jobId: string, startedAt: string): Promise<AnalysisJob | undefined>;
  updateJobScopeIfNoActiveConflict(input: { jobId: string; scopeKey: string }): Promise<AnalysisJob | undefined>;
  getJob(jobId: string): Promise<AnalysisJob | undefined>;
  updateJob(job: AnalysisJob): Promise<AnalysisJob>;
  saveResult(input: Omit<AnalysisResult, 'resultId' | 'createdAt'>): Promise<AnalysisResult>;
  finalizeSuccessfulJob(input: { jobId: string; resultId: string }): Promise<AnalysisJob | undefined>;
  getPublishedResult(resultId: string): Promise<AnalysisResult | undefined>;
  getLatestResult(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisResult | undefined>;
  saveEvidence(resultId: string, evidenceByTopic: Record<string, TopicEvidence[]>): Promise<void>;
  getTopicEvidence(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
    resultId: string;
    topicId: string;
    page: number;
    pageSize: number;
  }): Promise<TopicEvidencePage | undefined>;
};

export type CompleteAnalysisJobForTestTarget = {
  service: AnalysisBackendService;
  store: AnalysisBackendStore;
};

export type ReviewSourceVersionProvider = {
  getSourceVersion(query: {
    tenantKey: string;
    baseToken?: string;
    tableId?: string;
    viewId?: string;
    fieldMapping: Record<string, string>;
    filters?: JsonValue;
    hostScope?: JsonValue;
    sourceConfig?: Record<string, JsonValue | undefined>;
  }, reviews?: Array<{
    recordId: string;
    fields: Record<string, unknown>;
    mappedFields: Record<string, unknown>;
    content?: string;
    contentHash: string;
  }>): Promise<SourceVersion>;
};

export type AnalysisPreflightSyncRunner = {
  run(input: { config: BackendAnalysisConfig }): Promise<void>;
};

export class BackendAnalysisError extends Error {
  readonly status: number;
  readonly stage: AnalysisStage;

  constructor(status: number, stage: AnalysisStage, message: string) {
    super(message);
    this.name = 'BackendAnalysisError';
    this.status = status;
    this.stage = stage;
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function buildScopeKey(scopeDescriptor: unknown): string {
  return sha256(canonicalJson(scopeDescriptor));
}

export function buildAnalysisScopeKey(input: {
  pipelineVersion: string;
  model?: string;
  sourceVersion: SourceVersion;
  source: BackendAnalysisSourceDescriptor;
  filters?: JsonValue;
  dashboardDataConditions?: JsonValue;
}): string {
  return buildScopeKey({
    pipelineVersion: input.pipelineVersion,
    model: input.model ?? null,
    sourceVersion: buildStableSourceVersionDescriptor(input.sourceVersion),
    source: input.source,
    filters: input.filters ?? null,
    dashboardDataConditions: input.dashboardDataConditions ?? null,
  });
}

export function createInMemoryAnalysisBackendStore(): AnalysisBackendStore {
  const configs = new Map<string, BackendAnalysisConfig>();
  const configByIdentity = new Map<string, string>();
  const jobs = new Map<string, AnalysisJob>();
  const jobRevisionById = new Map<string, number>();
  const results = new Map<string, AnalysisResult>();
  const publishedResultIdsByUserScope = new Map<string, string[]>();
  const publishedResultIds = new Set<string>();
  const evidenceByResultTopic = new Map<string, TopicEvidence[]>();
  let configSequence = 1;
  let jobSequence = 1;
  let resultSequence = 1;
  let jobRevisionSequence = 1;

  const saveJob = (job: AnalysisJob): void => {
    jobs.set(job.jobId, job);
    jobRevisionById.set(job.jobId, jobRevisionSequence++);
  };

  return {
    async upsertConfig(input) {
      const identityKey = makeIdentityKey(input);
      const existingConfigId = configByIdentity.get(identityKey);
      const configId = existingConfigId ?? `config-${configSequence++}`;
      const previous = existingConfigId ? configs.get(existingConfigId) : undefined;
      const config: BackendAnalysisConfig = {
        ...deepClone(input),
        configId,
        configVersion: (previous?.configVersion ?? 0) + 1,
        updatedAt: `version-${(previous?.configVersion ?? 0) + 1}`,
      };
      configs.set(configId, config);
      configByIdentity.set(identityKey, configId);
      return deepClone(config);
    },

    async getConfig(configId) {
      return cloneOrUndefined(configs.get(configId));
    },

    async findActiveJob(input) {
      return cloneOrUndefined(findActiveJobInMap(jobs, input));
    },

    async getLatestJob(input) {
      const latestJob = Array.from(jobs.values())
        .filter((job) => matchesUserScope(job, input))
        .sort((left, right) => (jobRevisionById.get(right.jobId) ?? 0) - (jobRevisionById.get(left.jobId) ?? 0))[0];
      return cloneOrUndefined(latestJob);
    },

    async createJob(input) {
      const job: AnalysisJob = {
        ...deepClone(input),
        jobId: `job-${jobSequence++}`,
        createdAt: `job-created-${jobSequence - 1}`,
      };
      saveJob(job);
      return deepClone(job);
    },

    async createOrGetActiveJob(input) {
      const existing = findActiveJobInMap(jobs, input);
      if (existing) {
        return { job: deepClone(existing), created: false };
      }
      const job: AnalysisJob = {
        ...deepClone(input),
        jobId: `job-${jobSequence++}`,
        createdAt: `job-created-${jobSequence - 1}`,
      };
      saveJob(job);
      return { job: deepClone(job), created: true };
    },

    async claimJob(jobId, startedAt) {
      const job = jobs.get(jobId);
      if (!job || job.status !== 'queued') {
        return undefined;
      }
      const claimedJob: AnalysisJob = {
        ...job,
        status: 'running',
        stage: 'load_config',
        progress: 5,
        startedAt,
      };
      saveJob(claimedJob);
      return deepClone(claimedJob);
    },

    async updateJobScopeIfNoActiveConflict(input) {
      const job = jobs.get(input.jobId);
      if (!job || job.status !== 'running') {
        return undefined;
      }
      const activeConflict = findActiveJobInMap(jobs, {
        tenantKey: job.tenantKey,
        baseUserId: job.baseUserId,
        pluginInstanceId: job.pluginInstanceId,
        scopeKey: input.scopeKey,
      });
      if (activeConflict && activeConflict.jobId !== job.jobId) {
        return undefined;
      }
      const updatedJob = { ...job, scopeKey: input.scopeKey };
      saveJob(updatedJob);
      return deepClone(updatedJob);
    },

    async getJob(jobId) {
      return cloneOrUndefined(jobs.get(jobId));
    },

    async updateJob(job) {
      saveJob(deepClone(job));
      return deepClone(job);
    },

    async saveResult(input) {
      const result: AnalysisResult = {
        ...deepClone(input),
        resultId: `result-${resultSequence++}`,
        createdAt: `result-created-${resultSequence - 1}`,
      };
      results.set(result.resultId, result);
      return deepClone(result);
    },

    async finalizeSuccessfulJob(input) {
      const result = results.get(input.resultId);
      if (!result) {
        return undefined;
      }
      const job = jobs.get(input.jobId);
      if (!job) {
        return undefined;
      }
      if (
        job.status !== 'running' ||
        result.jobId !== job.jobId ||
        result.tenantKey !== job.tenantKey ||
        result.baseUserId !== job.baseUserId ||
        result.pluginInstanceId !== job.pluginInstanceId ||
        result.scopeKey !== job.scopeKey
      ) {
        return undefined;
      }
      const publishedJob: AnalysisJob = {
        ...job,
        status: 'success',
        stage: 'save_result',
        progress: 100,
        finishedAt: result.createdAt,
        resultId: result.resultId,
        errorStage: undefined,
        errorMessage: undefined,
      };
      saveJob(publishedJob);
      const key = makeUserScopeKey(result);
      const publishedIds = publishedResultIdsByUserScope.get(key) ?? [];
      if (!publishedIds.includes(result.resultId)) {
        publishedResultIdsByUserScope.set(key, [...publishedIds, result.resultId]);
      }
      publishedResultIds.add(result.resultId);
      return deepClone(publishedJob);
    },

    async getPublishedResult(resultId) {
      if (!publishedResultIds.has(resultId)) {
        return undefined;
      }
      return cloneOrUndefined(results.get(resultId));
    },

    async getLatestResult(input) {
      const resultIds = publishedResultIdsByUserScope.get(makeUserScopeKey(input)) ?? [];
      const latestId = resultIds[resultIds.length - 1];
      return latestId ? cloneOrUndefined(results.get(latestId)) : undefined;
    },

    async saveEvidence(resultId, input) {
      for (const [topicId, evidence] of Object.entries(input)) {
        evidenceByResultTopic.set(`${resultId}:${topicId}`, deepClone(evidence));
      }
    },

    async getTopicEvidence(input) {
      if (!publishedResultIds.has(input.resultId)) {
        return undefined;
      }
      const result = results.get(input.resultId);
      if (
        !result ||
        result.tenantKey !== input.tenantKey ||
        result.baseUserId !== input.baseUserId ||
        result.pluginInstanceId !== input.pluginInstanceId ||
        result.scopeKey !== input.scopeKey
      ) {
        return undefined;
      }
      const evidence = evidenceByResultTopic.get(`${input.resultId}:${input.topicId}`);
      if (!evidence) {
        return undefined;
      }
      const start = (input.page - 1) * input.pageSize;
      return {
        resultId: input.resultId,
        topicId: input.topicId,
        page: input.page,
        pageSize: input.pageSize,
        total: evidence.length,
        evidence: deepClone(evidence.slice(start, start + input.pageSize)),
      };
    },
  };
}

export class AnalysisBackendService {
  private readonly store: AnalysisBackendStore;
  private readonly pipelineVersion: string;
  private readonly reviewSources: Partial<Record<BackendAnalysisSourceKind, ReviewSourceVersionProvider>>;
  private readonly baseSummaryExporter?: BaseSummaryExporter;
  private readonly preflightSyncRunner?: AnalysisPreflightSyncRunner;

  constructor(options: {
    store: AnalysisBackendStore;
    pipelineVersion?: string;
    reviewSources?: Partial<Record<BackendAnalysisSourceKind, ReviewSourceVersionProvider>>;
    baseSummaryExporter?: BaseSummaryExporter;
    preflightSyncRunner?: AnalysisPreflightSyncRunner;
  }) {
    this.store = options.store;
    this.pipelineVersion = options.pipelineVersion ?? BACKEND_ANALYSIS_PIPELINE_VERSION;
    this.reviewSources = options.reviewSources ?? {};
    this.baseSummaryExporter = options.baseSummaryExporter;
    this.preflightSyncRunner = options.preflightSyncRunner;
  }

  async upsertConfig(input: BackendAnalysisConfigUpsertRequest): Promise<BackendAnalysisConfigUpsertResponse> {
    validateConfigUpsertRequest(input);
    const config = await this.store.upsertConfig(input);
    return { configId: config.configId, configVersion: config.configVersion };
  }

  async resolveScope(input: ResolveScopeRequest): Promise<ResolveScopeResponse> {
    validateResolveScopeRequest(input);
    const config = await this.loadConfigForIdentity(input);
    return this.resolveScopeForConfig(config);
  }

  async createOrGetAnalysisJob(input: CreateAnalysisJobRequest): Promise<CreateAnalysisJobResponse> {
    validateResolveScopeRequest(input);
    const config = await this.loadConfigForIdentity(input);
    if (config.source.kind === 'postgres') {
      await this.preflightSyncRunner?.run({ config });
    }
    const scope = await this.resolveScopeForConfig(config);
    const { job, created } = await this.store.createOrGetActiveJob({
      tenantKey: input.tenantKey,
      baseUserId: input.baseUserId,
      pluginInstanceId: input.pluginInstanceId,
      configId: config.configId,
      configVersion: config.configVersion,
      scopeKey: scope.scopeKey,
      status: 'queued',
      stage: 'validate_request',
      progress: 0,
    });

    return {
      jobId: job.jobId,
      scopeKey: job.scopeKey,
      status: job.status,
      created,
    };
  }

  async getCurrentJob(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisJob> {
    validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey']);
    const candidate = await this.findLatestJob(input);
    if (!candidate) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis job not found');
    }
    return candidate;
  }

  async getJob(
    jobId: string,
    identity?: {
      tenantKey: string;
      baseUserId: string;
      pluginInstanceId: string;
    },
  ): Promise<AnalysisJob> {
    if (!isNonEmptyString(jobId)) {
      throw new BackendAnalysisError(400, 'validate_request', 'jobId is required');
    }
    const job = await this.store.getJob(jobId);
    if (!job) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis job not found');
    }
    if (
      identity &&
      (job.tenantKey !== identity.tenantKey ||
        job.baseUserId !== identity.baseUserId ||
        job.pluginInstanceId !== identity.pluginInstanceId)
    ) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis job not found');
    }
    return job;
  }

  async getLatestResult(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisResult> {
    validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey']);
    const result = await this.store.getLatestResult(input);
    if (!result) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis result not found');
    }
    return result;
  }

  async getTopicEvidence(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
    resultId: string;
    topicId: string;
    page: number;
    pageSize: number;
  }): Promise<TopicEvidencePage> {
    validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey', 'resultId', 'topicId']);
    if (!Number.isInteger(input.page) || input.page < 1) {
      throw new BackendAnalysisError(400, 'validate_request', 'page must be a positive integer');
    }
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      throw new BackendAnalysisError(400, 'validate_request', 'pageSize must be between 1 and 100');
    }
    const evidence = await this.store.getTopicEvidence(input);
    if (!evidence) {
      throw new BackendAnalysisError(404, 'load_config', 'topic evidence not found');
    }
    return evidence;
  }

  async exportBaseSummary(resultId: string, input: ExportBaseSummaryRequest): Promise<ExportBaseSummaryResponse> {
    if (!isNonEmptyString(resultId)) {
      throw new BackendAnalysisError(400, 'validate_request', 'resultId is required');
    }
    validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey']);

    const result = await this.store.getPublishedResult(resultId);
    if (
      !result ||
      result.tenantKey !== input.tenantKey ||
      result.baseUserId !== input.baseUserId ||
      result.pluginInstanceId !== input.pluginInstanceId ||
      result.scopeKey !== input.scopeKey
    ) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis result not found');
    }

    const config = await this.store.getConfig(result.configId);
    if (!config) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
    }
    if (
      config.tenantKey !== result.tenantKey ||
      config.baseUserId !== result.baseUserId ||
      config.pluginInstanceId !== result.pluginInstanceId
    ) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
    }

    if (!this.baseSummaryExporter) {
      throw new BackendAnalysisError(501, 'export_summary', 'base summary exporter is not configured');
    }

    try {
      return await this.baseSummaryExporter.exportBaseSummary({ result, config });
    } catch (cause) {
      if (cause instanceof BackendAnalysisError) {
        throw cause;
      }
      throw new BackendAnalysisError(500, 'export_summary', cause instanceof Error ? cause.message : String(cause));
    }
  }

  private async resolveScopeForConfig(config: BackendAnalysisConfig): Promise<ResolveScopeResponse> {
    const sourceVersionProvider = this.reviewSources[config.source.kind];
    if (!sourceVersionProvider) {
      throw new BackendAnalysisError(400, 'resolve_source', `review source ${config.source.kind} is not configured`);
    }
    const sourceVersion = await sourceVersionProvider.getSourceVersion(buildReviewSourceQuery(config));
    const scopeKey = buildAnalysisScopeKey({
      pipelineVersion: this.pipelineVersion,
      model: config.model,
      sourceVersion,
      source: config.source,
      filters: config.filters,
      dashboardDataConditions: config.dashboardDataConditions,
    });
    return {
      scopeKey,
      sourceVersion,
      configVersion: config.configVersion,
    };
  }

  private async loadConfigForIdentity(input: ResolveScopeRequest): Promise<BackendAnalysisConfig> {
    const config = await this.store.getConfig(input.configId);
    if (!config) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
    }
    if (
      config.tenantKey !== input.tenantKey ||
      config.baseUserId !== input.baseUserId ||
      config.pluginInstanceId !== input.pluginInstanceId
    ) {
      throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
    }
    return config;
  }

  private async findLatestJob(input: {
    tenantKey: string;
    baseUserId: string;
    pluginInstanceId: string;
    scopeKey: string;
  }): Promise<AnalysisJob | undefined> {
    return this.store.getLatestJob(input);
  }
}

export class DefaultDeterministicReviewSource implements ReviewSourceVersionProvider {
  constructor(private readonly kind: BackendAnalysisSourceKind) {}

  async getSourceVersion(query: {
    tenantKey: string;
    baseToken?: string;
    tableId?: string;
    viewId?: string;
    fieldMapping: Record<string, string>;
    filters?: JsonValue;
    hostScope?: JsonValue;
    sourceConfig?: Record<string, JsonValue | undefined>;
  }): Promise<SourceVersion> {
    const sourceId = buildSourceIdFromQuery(this.kind, query);
    const sourceDescriptor = {
      kind: this.kind,
      sourceId,
      baseToken: query.baseToken ?? null,
      tableId: query.tableId ?? null,
      viewId: query.viewId ?? null,
      fieldMapping: query.fieldMapping,
      filters: query.filters ?? null,
      dashboardDataConditions: query.hostScope ?? null,
      sourceConfig: query.sourceConfig ?? null,
    };
    const contentHash = sha256(canonicalJson(sourceDescriptor));
    return {
      kind: this.kind,
      sourceId,
      version: `source-${contentHash.slice(0, 16)}`,
      contentHash,
      generatedAt: 'deterministic',
      recordCount: 0,
    };
  }
}

export async function completeAnalysisJobForTest(
  target: CompleteAnalysisJobForTestTarget,
  jobId: string,
  input: CompleteJobForTestInput,
): Promise<AnalysisResult> {
  const initialJob = await target.service.getJob(jobId);
  const job = initialJob.status === 'queued' ? await target.store.claimJob(jobId, initialJob.createdAt) : initialJob;
  if (!job) {
    throw new BackendAnalysisError(409, 'load_config', 'analysis job is not queued');
  }
  const config = await target.store.getConfig(job.configId);
  if (!config) {
    throw new BackendAnalysisError(404, 'load_config', 'analysis config not found');
  }
  const sourceVersion = buildDeterministicSourceVersion(config);
  const result = await target.store.saveResult({
    tenantKey: job.tenantKey,
    baseUserId: job.baseUserId,
    pluginInstanceId: job.pluginInstanceId,
    scopeKey: job.scopeKey,
    jobId: job.jobId,
    configId: job.configId,
    configVersion: job.configVersion,
    sourceVersion,
    pipelineVersion: BACKEND_ANALYSIS_PIPELINE_VERSION,
    summary: input.summary,
    topics: input.topics,
  });
  await target.store.saveEvidence(result.resultId, input.evidenceByTopic);
  await target.store.updateJob({
    ...job,
    stage: 'save_result',
    startedAt: job.startedAt ?? job.createdAt,
  });
  await target.store.finalizeSuccessfulJob({ jobId: job.jobId, resultId: result.resultId });
  return result;
}

function buildDeterministicSourceVersion(config: BackendAnalysisConfig): SourceVersion {
  const sourceId = buildSourceId(config);
  const sourceDescriptor = {
    kind: config.source.kind,
    sourceId,
    source: config.source,
    baseToken: config.baseToken ?? null,
    filters: config.filters ?? null,
    dashboardDataConditions: config.dashboardDataConditions ?? null,
  };
  const contentHash = sha256(canonicalJson(sourceDescriptor));
  return {
    kind: config.source.kind,
    sourceId,
    version: `source-${contentHash.slice(0, 16)}`,
    contentHash,
    generatedAt: 'deterministic',
    recordCount: 0,
  };
}

function buildReviewSourceQuery(config: BackendAnalysisConfig): Parameters<ReviewSourceVersionProvider['getSourceVersion']>[0] {
  return {
    tenantKey: config.tenantKey,
    baseToken: config.baseToken,
    tableId: config.source.tableId,
    viewId: config.source.viewId,
    fieldMapping: config.source.fieldMapping,
    filters: config.filters,
    hostScope: config.dashboardDataConditions,
    sourceConfig: Object.fromEntries(
      Object.entries(config.source).filter(([key]) => !['kind', 'tableId', 'viewId', 'fieldMapping'].includes(key)),
    ) as Record<string, JsonValue | undefined>,
  };
}

function buildStableSourceVersionDescriptor(sourceVersion: SourceVersion): Omit<SourceVersion, 'generatedAt'> {
  const { generatedAt: _generatedAt, ...stableSourceVersion } = sourceVersion;
  return stableSourceVersion;
}

export function createConfiguredReviewSources(options: {
  feishuBase?: ReviewSourceVersionProvider;
  postgres?: ReviewSourceVersionProvider;
  external?: ReviewSourceVersionProvider;
}): Partial<Record<BackendAnalysisSourceKind, ReviewSourceVersionProvider>> {
  return Object.fromEntries(
    Object.entries({
      feishu_base: options.feishuBase,
      postgres: options.postgres,
      external: options.external,
    }).filter(([, source]) => source),
  ) as Partial<Record<BackendAnalysisSourceKind, ReviewSourceVersionProvider>>;
}

function validateConfigUpsertRequest(input: BackendAnalysisConfigUpsertRequest): void {
  validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId']);
  if (!input.source || typeof input.source !== 'object') {
    throw new BackendAnalysisError(400, 'validate_request', 'source is required');
  }
  if (!isNonEmptyString(input.source.kind)) {
    throw new BackendAnalysisError(400, 'validate_request', 'source.kind is required');
  }
  if (!isBackendAnalysisSourceKind(input.source.kind)) {
    throw new BackendAnalysisError(400, 'validate_request', 'source.kind must be feishu_base, postgres, or external');
  }
  if (input.source.kind === 'feishu_base') {
    if (!isNonEmptyString(input.baseToken)) {
      throw new BackendAnalysisError(400, 'validate_request', 'baseToken is required for feishu_base source');
    }
    if (!isNonEmptyString(input.source.tableId)) {
      throw new BackendAnalysisError(400, 'validate_request', 'source.tableId is required for feishu_base source');
    }
  }
  if (!input.source.fieldMapping || typeof input.source.fieldMapping !== 'object' || Array.isArray(input.source.fieldMapping)) {
    throw new BackendAnalysisError(400, 'validate_request', 'source.fieldMapping is required');
  }
  for (const [fieldName, fieldId] of Object.entries(input.source.fieldMapping)) {
    if (!isNonEmptyString(fieldId)) {
      throw new BackendAnalysisError(400, 'validate_request', `source.fieldMapping.${fieldName} must be a non-empty string`);
    }
  }
}

function validateResolveScopeRequest(input: ResolveScopeRequest): void {
  validateRequiredStrings(input, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'configId']);
}

function validateRequiredStrings(input: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((key) => !isNonEmptyString(input[key]));
  if (missing.length > 0) {
    throw new BackendAnalysisError(400, 'validate_request', `missing required fields: ${missing.join(', ')}`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBackendAnalysisSourceKind(value: string): value is BackendAnalysisSourceKind {
  return value === 'feishu_base' || value === 'postgres' || value === 'external';
}

function buildSourceId(config: BackendAnalysisConfig): string {
  if (config.source.kind === 'feishu_base') {
    return [config.baseToken, config.source.tableId].filter(Boolean).join(':') || config.source.kind;
  }

  const source = config.source as Record<string, unknown>;
  const stableSourceId =
    pickNonEmptyString(source.sourceId) ??
    pickNonEmptyString(source.connectionId) ??
    pickNonEmptyString(source.datasetId) ??
    pickNonEmptyString(source.tableId) ??
    pickNonEmptyString(source.name);

  return stableSourceId ?? config.source.kind;
}

function buildSourceIdFromQuery(
  kind: BackendAnalysisSourceKind,
  query: {
    baseToken?: string;
    tableId?: string;
    viewId?: string;
    sourceConfig?: Record<string, JsonValue | undefined>;
  },
): string {
  if (kind === 'feishu_base') {
    return [query.baseToken, query.tableId].filter(Boolean).join(':') || kind;
  }

  const source = query.sourceConfig ?? {};
  const stableSourceId =
    pickNonEmptyString(source.sourceId) ??
    pickNonEmptyString(source.connectionId) ??
    pickNonEmptyString(source.datasetId) ??
    pickNonEmptyString(query.tableId) ??
    pickNonEmptyString(source.name);

  return stableSourceId ?? kind;
}

function pickNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function makeIdentityKey(input: { tenantKey: string; baseUserId: string; pluginInstanceId: string }): string {
  return `${input.tenantKey}:${input.baseUserId}:${input.pluginInstanceId}`;
}

function makeUserScopeKey(input: { tenantKey: string; baseUserId: string; pluginInstanceId: string; scopeKey: string }): string {
  return `${input.tenantKey}:${input.baseUserId}:${input.pluginInstanceId}:${input.scopeKey}`;
}

function findActiveJobInMap(
  jobs: Map<string, AnalysisJob>,
  input: { tenantKey: string; baseUserId: string; pluginInstanceId: string; scopeKey: string },
): AnalysisJob | undefined {
  return Array.from(jobs.values()).find(
    (job) => matchesUserScope(job, input) && (job.status === 'queued' || job.status === 'running'),
  );
}

function matchesUserScope(
  job: AnalysisJob,
  input: { tenantKey: string; baseUserId: string; pluginInstanceId: string; scopeKey: string },
): boolean {
  return (
    job.tenantKey === input.tenantKey &&
    job.baseUserId === input.baseUserId &&
    job.pluginInstanceId === input.pluginInstanceId &&
    job.scopeKey === input.scopeKey
  );
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }
  return value;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneOrUndefined<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : deepClone(value);
}
