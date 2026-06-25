import { BackendAnalysisError, type AnalysisStage } from './backendAnalysis';
import type { ReviewSyncJob } from './postgresReviewSyncStore';
import {
  buildCanonicalReviewSyncSourceKey,
  type ReviewSyncService,
  type ReviewSyncSourceKey,
} from './reviewSync';

export type ReviewSyncHandlerOptions = {
  service: ReviewSyncService;
  onSyncJobCreated?: (jobId: string, sourceKey: ReviewSyncSourceKey) => void;
};

type ErrorBody = {
  stage: AnalysisStage;
  message: string;
};

type SyncSourceRequestBody = {
  baseToken?: string;
  tableId?: string;
  fieldMapping?: Record<string, string>;
};

const API_PREFIX = '/api/hotel-review-ai';

export async function handleReviewSyncRequest(request: Request, options: ReviewSyncHandlerOptions): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (request.method === 'OPTIONS') {
      return emptyCorsResponse(204);
    }

    if (url.pathname === `${API_PREFIX}/sync/full` || url.pathname === `${API_PREFIX}/sync/incremental`) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<SyncSourceRequestBody>(request);
      const sourceKey = buildCanonicalReviewSyncSourceKey(body as Required<SyncSourceRequestBody>);
      const mode = url.pathname.endsWith('/full') ? 'full' : 'incremental';
      const job = await options.service.enqueueSyncJob(sourceKey, mode);
      options.onSyncJobCreated?.(job.jobId, sourceKey);
      return jsonResponse(toSyncJobResponse(job), 202);
    }

    return jsonResponse({ stage: 'validate_request', message: 'not found' } satisfies ErrorBody, 404);
  } catch (cause) {
    if (cause instanceof BackendAnalysisError) {
      return jsonResponse({ stage: cause.stage, message: cause.message } satisfies ErrorBody, cause.status);
    }
    throw cause;
  }
}

function toSyncJobResponse(job: ReviewSyncJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    tenantKey: job.tenantKey,
    sourceKind: job.sourceKind,
    sourceId: job.sourceId,
    mode: job.mode,
    triggerType: job.triggerType,
    status: job.status,
    stage: job.stage,
    recordsRead: job.recordsRead,
    recordsUpserted: job.recordsUpserted,
    recordsDeleted: job.recordsDeleted,
    recordsUnchanged: job.recordsUnchanged,
    durationMs: job.durationMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
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
