import {
  BackendAnalysisError,
  type AnalysisBackendService,
  type AnalysisStage,
  type BackendAnalysisConfigUpsertRequest,
  type CreateAnalysisJobRequest,
  type ExportBaseSummaryRequest,
  type ResolveScopeRequest,
} from './backendAnalysis';

export type BackendAnalysisHandlerOptions = {
  service: AnalysisBackendService;
  onJobCreated?: (jobId: string) => void;
};

type ErrorBody = {
  stage: AnalysisStage;
  message: string;
};

const API_PREFIX = '/api/hotel-review-ai';

export async function handleBackendAnalysisRequest(
  request: Request,
  options: BackendAnalysisHandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (request.method === 'OPTIONS') {
      return emptyCorsResponse(204);
    }

    if (url.pathname === `${API_PREFIX}/configs/upsert`) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<BackendAnalysisConfigUpsertRequest>(request);
      return jsonResponse(await options.service.upsertConfig(body), 200);
    }

    if (url.pathname === `${API_PREFIX}/scopes/resolve`) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<ResolveScopeRequest>(request);
      return jsonResponse(await options.service.resolveScope(body), 200);
    }

    if (url.pathname === `${API_PREFIX}/analysis-jobs`) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<CreateAnalysisJobRequest>(request);
      const job = await options.service.createOrGetAnalysisJob(body);
      if (job.created) {
        options.onJobCreated?.(job.jobId);
      }
      return jsonResponse(job, 200);
    }

    if (url.pathname === `${API_PREFIX}/analysis-jobs/current`) {
      requireMethod(request, 'GET');
      return jsonResponse(
        await options.service.getCurrentJob(readRequiredQuery(url, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey'] as const)),
        200,
      );
    }

    const jobMatch = url.pathname.match(/^\/api\/hotel-review-ai\/analysis-jobs\/([^/]+)$/);
    if (jobMatch) {
      requireMethod(request, 'GET');
      return jsonResponse(
        await options.service.getJob(
          safeDecodePathParam(jobMatch[1]),
          readRequiredQuery(url, ['tenantKey', 'baseUserId', 'pluginInstanceId'] as const),
        ),
        200,
      );
    }

    if (url.pathname === `${API_PREFIX}/results/latest`) {
      requireMethod(request, 'GET');
      return jsonResponse(
        await options.service.getLatestResult(readRequiredQuery(url, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey'] as const)),
        200,
      );
    }

    const evidenceMatch = url.pathname.match(/^\/api\/hotel-review-ai\/results\/([^/]+)\/topics\/([^/]+)\/evidence$/);
    if (evidenceMatch) {
      requireMethod(request, 'GET');
      const pagination = readPagination(url);
      return jsonResponse(
        await options.service.getTopicEvidence({
          ...readRequiredQuery(url, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey'] as const),
          resultId: safeDecodePathParam(evidenceMatch[1]),
          topicId: safeDecodePathParam(evidenceMatch[2]),
          page: pagination.page,
          pageSize: pagination.pageSize,
        }),
        200,
      );
    }

    const exportSummaryMatch = url.pathname.match(/^\/api\/hotel-review-ai\/results\/([^/]+)\/export\/base-summary$/);
    if (exportSummaryMatch) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<Record<string, unknown>>(request);
      validateBodyStrings(body, ['tenantKey', 'baseUserId', 'pluginInstanceId', 'scopeKey'] as const);
      return jsonResponse(await options.service.exportBaseSummary(safeDecodePathParam(exportSummaryMatch[1]), body as ExportBaseSummaryRequest), 200);
    }

    return jsonResponse({ stage: 'load_config', message: 'not found' } satisfies ErrorBody, 404);
  } catch (cause) {
    if (cause instanceof BackendAnalysisError) {
      return jsonResponse({ stage: cause.stage, message: cause.message } satisfies ErrorBody, cause.status);
    }
    throw cause;
  }
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new BackendAnalysisError(400, 'validate_request', 'invalid JSON body');
  }
}

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new BackendAnalysisError(405, 'validate_request', 'method not allowed');
  }
}

function readRequiredQuery<TKeys extends readonly string[]>(
  url: URL,
  keys: TKeys,
): { [K in TKeys[number]]: string } {
  const values = Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key)?.trim() ?? '']));
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new BackendAnalysisError(400, 'validate_request', `missing query params: ${missing.join(', ')}`);
  }
  return values as { [K in TKeys[number]]: string };
}

function readPagination(url: URL): { page: number; pageSize: number } {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
  return { page, pageSize };
}

function validateBodyStrings<TKeys extends readonly string[]>(
  body: Record<string, unknown>,
  keys: TKeys,
): asserts body is Record<TKeys[number], string> {
  const missing = keys.filter((key) => typeof body[key] !== 'string' || !body[key].trim());
  if (missing.length > 0) {
    throw new BackendAnalysisError(400, 'validate_request', `missing required fields: ${missing.join(', ')}`);
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400',
      'Content-Type': 'application/json',
    },
  });
}

function emptyCorsResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function safeDecodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BackendAnalysisError(400, 'validate_request', 'malformed path parameter');
  }
}
