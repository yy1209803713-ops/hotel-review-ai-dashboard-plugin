import { BackendAnalysisError, type AnalysisStage } from './backendAnalysis';
import type { ReviewSyncJob } from './postgresReviewSyncStore';
import {
  type FeishuRecordChangedEvent,
  type ReviewSyncService,
  type ReviewSyncSourceKey,
  type ReviewSyncTriggerType,
} from './reviewSync';

export type ReviewSyncHandlerOptions = {
  service: ReviewSyncService;
  onSyncJobCreated?: (jobId: string, sourceKey: ReviewSyncSourceKey) => void;
};

type ErrorBody = {
  stage: AnalysisStage;
  message: string;
};

const API_PREFIX = '/api/hotel-review-ai';

export async function handleReviewSyncRequest(request: Request, options: ReviewSyncHandlerOptions): Promise<Response> {
  const url = new URL(request.url);

  try {
    if (request.method === 'OPTIONS') {
      return emptyCorsResponse(204);
    }

    if (url.pathname === `${API_PREFIX}/sync/feishu/record-changed`) {
      requireMethod(request, 'POST');
      const event = await parseJsonBody<FeishuRecordChangedEvent>(request);
      validateRecordChangedEvent(event);
      const job = await options.service.enqueueSyncJob(event.sourceKey, 'event');
      options.onSyncJobCreated?.(job.jobId, event.sourceKey);
      return jsonResponse(toSyncJobResponse(job), 202);
    }

    if (url.pathname === `${API_PREFIX}/sync/manual`) {
      requireMethod(request, 'POST');
      const body = await parseJsonBody<{ sourceKey: ReviewSyncSourceKey; triggerType?: ReviewSyncTriggerType }>(request);
      validateSourceKey(body.sourceKey);
      const triggerType = body.triggerType ?? 'manual';
      if (triggerType !== 'manual' && triggerType !== 'schedule' && triggerType !== 'analysis_preflight') {
        throw new BackendAnalysisError(400, 'validate_request', 'manual sync triggerType must be manual, schedule, or analysis_preflight');
      }
      const job = await options.service.enqueueSyncJob(body.sourceKey, triggerType);
      options.onSyncJobCreated?.(job.jobId, body.sourceKey);
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
    triggerType: job.triggerType,
    status: job.status,
    stage: job.stage,
    recordsRead: job.recordsRead,
    recordsUpserted: job.recordsUpserted,
    recordsDeleted: job.recordsDeleted,
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

function validateRecordChangedEvent(event: FeishuRecordChangedEvent): void {
  if (!event || typeof event !== 'object') {
    throw new BackendAnalysisError(400, 'validate_request', 'event body is required');
  }
  if (typeof event.recordId !== 'string' || !event.recordId.trim()) {
    throw new BackendAnalysisError(400, 'validate_request', 'recordId is required');
  }
  if (event.operation !== 'create' && event.operation !== 'update' && event.operation !== 'delete') {
    throw new BackendAnalysisError(400, 'validate_request', 'operation must be create, update, or delete');
  }
  validateSourceKey(event.sourceKey);
}

function validateSourceKey(sourceKey: ReviewSyncSourceKey | undefined): void {
  if (!sourceKey || typeof sourceKey !== 'object') {
    throw new BackendAnalysisError(400, 'validate_request', 'sourceKey is required');
  }
  const missing = ['tenantKey', 'sourceKind', 'sourceId', 'baseToken', 'tableId', 'fieldMapping'].filter(
    (fieldName) => !hasRequiredSourceKeyField(sourceKey, fieldName),
  );
  if (missing.length) {
    throw new BackendAnalysisError(400, 'validate_request', `missing sourceKey fields: ${missing.join(', ')}`);
  }
  if (sourceKey.viewId !== undefined && (typeof sourceKey.viewId !== 'string' || !sourceKey.viewId.trim())) {
    throw new BackendAnalysisError(400, 'validate_request', 'sourceKey.viewId must be a non-empty string when provided');
  }
  for (const [fieldName, fieldId] of Object.entries(sourceKey.fieldMapping)) {
    if (typeof fieldId !== 'string' || !fieldId.trim()) {
      throw new BackendAnalysisError(400, 'validate_request', `sourceKey.fieldMapping.${fieldName} must be a non-empty string`);
    }
  }
}

function hasRequiredSourceKeyField(sourceKey: ReviewSyncSourceKey, fieldName: string): boolean {
  const value = sourceKey[fieldName as keyof ReviewSyncSourceKey];
  if (fieldName === 'fieldMapping') {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === 'string' && value.trim().length > 0;
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
