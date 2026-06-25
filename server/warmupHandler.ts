import type { WarmupMode, WarmupRequest, WarmupResponse, WarmupSource, WarmupStage } from './warmupTypes';
import { BackendAnalysisError } from './backendAnalysis';
import { createWarmupAcceptedResponse, type WarmupService } from './warmupJob';
import { isReviewDateRangeBoundaryString } from '../src/services/filtering';

export type WarmupHandlerOptions = {
  warmupSecret: string;
  service?: WarmupService;
  onWarmupJobCreated?: (jobId: string) => void;
  now?: () => string;
};

const EMPTY_SUMMARY: WarmupResponse['summary'] = {
  recordsScanned: 0,
  totalReviews: 0,
  evidenceCacheHits: 0,
  evidenceCacheMisses: 0,
  evidenceRecordsSaved: 0,
  topicMappingHits: 0,
  topicMappingMisses: 0,
  topicMappingsSaved: 0,
};

export async function handleWarmupRequest(request: Request, options: WarmupHandlerOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/api/hotel-review-ai/warmup') {
    return jsonResponse({ error: 'not found' }, 404);
  }
  if (request.method === 'OPTIONS') {
    return emptyCorsResponse(204);
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405);
  }

  const startedAt = options.now?.() ?? new Date().toISOString();
  if (!isAuthorized(request, options.warmupSecret)) {
    return jsonResponse(createFailureResponse('unknown-table', 'incremental', startedAt, 'invalid warmup authorization'), 401);
  }

  let payload: WarmupRequest;
  try {
    payload = (await request.json()) as WarmupRequest;
  } catch {
    return jsonResponse(createFailureResponse('unknown-table', 'incremental', startedAt, 'invalid JSON body'), 400);
  }

  const mode = isWarmupMode(payload.mode) ? payload.mode : 'incremental';
  const jobId = createWarmupJobId(startedAt, payload.tableId);
  const validationMessage = validateWarmupPayload(payload);
  if (validationMessage) {
    return jsonResponse(createFailureResponse(payload.tableId || 'unknown-table', mode, startedAt, validationMessage), 400);
  }

  if (!options.service) {
    return jsonResponse(createFailureResponse(payload.tableId || 'unknown-table', mode, startedAt, 'warmup service is not configured'), 500);
  }

  try {
    const job = await options.service.createWarmupJob({
      request: payload,
      triggerType: triggerTypeFromSource(payload.source),
    });
    options.onWarmupJobCreated?.(job.jobId);
    logWarmupTrigger(payload, job.jobId, mode);
    return jsonResponse(createWarmupAcceptedResponse(job), 202);
  } catch (cause) {
    if (cause instanceof BackendAnalysisError) {
      return jsonResponse(createFailureResponse(payload.tableId || 'unknown-table', mode, startedAt, cause.message, cause.stage as WarmupStage), cause.status);
    }
    throw cause;
  }
}

function isAuthorized(request: Request, warmupSecret: string): boolean {
  const secret = warmupSecret.trim();
  if (!secret) {
    return false;
  }
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function validateWarmupPayload(payload: WarmupRequest): string {
  const errors: string[] = [];
  if (!isWarmupMode(payload.mode)) {
    errors.push('mode must be bootstrap or incremental');
  }
  if (!isWarmupSource(payload.source)) {
    errors.push('source must be dashboard-button, feishu-workflow, or manual');
  }
  if (!payload.tableId?.trim()) {
    errors.push('tableId is required');
  }
  if (!payload.baseToken?.trim()) {
    errors.push('baseToken is required');
  }
  if (payload.startDate && !isDateString(payload.startDate)) {
    errors.push('startDate must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss');
  }
  if (payload.endDate && !isDateString(payload.endDate)) {
    errors.push('endDate must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss');
  }
  return errors.join('; ');
}

function isWarmupMode(mode: unknown): mode is WarmupMode {
  return mode === 'bootstrap' || mode === 'incremental';
}

function isWarmupSource(source: unknown): source is WarmupSource {
  return source === 'dashboard-button' || source === 'feishu-workflow' || source === 'manual';
}

function isDateString(value: string): boolean {
  return isReviewDateRangeBoundaryString(value);
}

function triggerTypeFromSource(source: WarmupSource) {
  if (source === 'feishu-workflow') {
    return 'feishu_workflow';
  }
  if (source === 'dashboard-button') {
    return 'dashboard_button';
  }
  return 'manual_api';
}

function createFailureResponse(
  tableId: string,
  mode: WarmupMode,
  startedAt: string,
  message: string,
  stage: WarmupStage = 'validate_request',
): WarmupResponse {
  return {
    jobId: createWarmupJobId(startedAt, tableId),
    status: 'failed',
    mode,
    summary: { ...EMPTY_SUMMARY },
    errors: [{ stage, message }],
  };
}

function logWarmupTrigger(request: WarmupRequest, jobId: string, mode: WarmupMode): void {
  console.info(
    '__HOTEL_REVIEW_AI_WARMUP_TRIGGER__',
    JSON.stringify({
      jobId,
      source: request.source,
      mode,
      baseToken: request.baseToken,
      tableId: request.tableId,
      viewId: request.viewId,
      startDate: request.startDate,
      endDate: request.endDate,
      dryRun: Boolean(request.dryRun),
    }),
  );
}

function createWarmupJobId(startedAt: string, tableId: string): string {
  return `warmup-${startedAt}-${tableId || 'unknown-table'}`;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({
      'Content-Type': 'application/json',
    }),
  });
}

function emptyCorsResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: corsHeaders(),
  });
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}
