import type { AnalysisResult } from '../types/analysis';
import type { FieldMapping, FilterState } from '../types/config';

export type BackendOwnership = {
  tenantKey: string;
  baseUserId: string;
  pluginInstanceId: string;
};

export type BackendStage =
  | 'validate_request'
  | 'load_config'
  | 'resolve_source'
  | 'read_reviews'
  | 'read_evidence_cache'
  | 'extract_evidence'
  | 'save_evidence_cache'
  | 'read_topic_mapping_cache'
  | 'merge_topics'
  | 'save_topic_mapping_cache'
  | 'build_result'
  | 'save_result'
  | 'export_summary'
  | 'validate_response';

export type BackendJobStatus = 'queued' | 'running' | 'success' | 'failed' | 'canceled';

export type UpsertConfigRequest = BackendOwnership & {
  baseToken?: string;
  model?: string;
  source: {
    kind: 'feishu_base' | 'postgres' | 'external';
    sourceId?: string;
    upstreamSourceKind?: 'feishu_base' | 'postgres' | 'external';
    tableId?: string;
    viewId?: string;
    fieldMapping: FieldMapping;
  };
  filters: FilterState;
  dashboardDataConditions: unknown;
};

export type UpsertConfigResponse = {
  configId: string;
  configVersion: number;
};

export type ResolveScopeResponse = {
  scopeKey: string;
  sourceVersion: unknown;
  configVersion: number;
};

export type BackendAnalysisJob = {
  jobId: string;
  scopeKey: string;
  status: BackendJobStatus;
  stage?: string;
  progress?: unknown;
  startedAt?: string;
  finishedAt?: string;
  errorStage?: string;
  errorMessage?: string;
  resultId?: string;
};

export type LatestResultResponse = {
  resultId: string;
  summary: AnalysisResult;
  generatedAt?: string;
};

export type ExportBaseSummaryResponse = {
  resultId: string;
  summaryTableId: string;
  topicTableId: string;
  summaryRecordIds: string[];
  topicRecordIds: string[];
  exportedAt: string;
};

export class BackendAnalysisError extends Error {
  constructor(
    public readonly stage: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BackendAnalysisError';
  }
}

export function createBackendAnalysisClient(options: {
  endpointUrl: string;
  fetchImpl?: typeof fetch;
}) {
  const endpointUrl = options.endpointUrl.trim().replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!endpointUrl) {
    throw new BackendAnalysisError('validate_request', '请先填写后端分析服务地址');
  }

  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchImpl(`${endpointUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    if (response.status === 404 && path.startsWith('/api/hotel-review-ai/analysis-jobs/current')) {
      return null as T;
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const errorPayload = asRecord(payload);
      throw new BackendAnalysisError(
        typeof errorPayload.stage === 'string' ? errorPayload.stage : 'validate_response',
        typeof errorPayload.message === 'string' ? errorPayload.message : `后端分析接口返回 HTTP ${response.status}`,
        response.status,
      );
    }
    return payload as T;
  };

  return {
    upsertConfig(body: UpsertConfigRequest): Promise<UpsertConfigResponse> {
      return request('/api/hotel-review-ai/configs/upsert', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    resolveScope(body: BackendOwnership & { configId: string }): Promise<ResolveScopeResponse> {
      return request('/api/hotel-review-ai/scopes/resolve', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    createAnalysisJob(body: BackendOwnership & { configId: string; forceRefresh?: boolean }): Promise<BackendAnalysisJob> {
      return request('/api/hotel-review-ai/analysis-jobs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    getCurrentJob(params: BackendOwnership & { scopeKey: string }): Promise<BackendAnalysisJob | null> {
      return request(`/api/hotel-review-ai/analysis-jobs/current?${buildQuery(params)}`);
    },
    getJob(jobId: string, ownership: BackendOwnership): Promise<BackendAnalysisJob> {
      return request(`/api/hotel-review-ai/analysis-jobs/${encodeURIComponent(jobId)}?${buildQuery(ownership)}`);
    },
    getLatestResult(params: BackendOwnership & { scopeKey: string }): Promise<LatestResultResponse> {
      return request(`/api/hotel-review-ai/results/latest?${buildQuery(params)}`);
    },
    getTopicEvidence(params: BackendOwnership & {
      resultId: string;
      topicId: string;
      scopeKey: string;
      page: number;
      pageSize: number;
    }): Promise<unknown> {
      const { resultId, topicId, ...query } = params;
      return request(
        `/api/hotel-review-ai/results/${encodeURIComponent(resultId)}/topics/${encodeURIComponent(topicId)}/evidence?${buildQuery(query)}`,
      );
    },
    exportBaseSummary(params: BackendOwnership & { resultId: string; scopeKey: string }): Promise<ExportBaseSummaryResponse> {
      const { resultId, ...body } = params;
      return request(`/api/hotel-review-ai/results/${encodeURIComponent(resultId)}/export/base-summary`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
  };
}

export type BackendAnalysisClient = ReturnType<typeof createBackendAnalysisClient>;

export function assertRenderableAnalysisSummary(value: unknown): AnalysisResult {
  const summary = asRecord(value);
  const overview = asRecord(summary.overview);
  if (
    typeof summary.analysisId !== 'string' ||
    typeof summary.generatedAt !== 'string' ||
    typeof summary.model !== 'string' ||
    (summary.status !== 'complete' && summary.status !== 'partial') ||
    typeof overview.totalReviews !== 'number' ||
    !Array.isArray(summary.positiveTopics) ||
    !Array.isArray(summary.negativeTopics) ||
    !Array.isArray(summary.actionItems)
  ) {
    throw new BackendAnalysisError('validate_response', '后端 latest result 的 summary 不是前端可渲染的 AnalysisResult 形状');
  }
  return summary as AnalysisResult;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new BackendAnalysisError(
      'validate_response',
      cause instanceof Error ? `后端分析接口返回无法解析的 JSON：${cause.message}` : '后端分析接口返回无法解析的 JSON',
      response.status,
    );
  }
}

function buildQuery(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    query.set(key, String(value));
  }
  return query.toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
