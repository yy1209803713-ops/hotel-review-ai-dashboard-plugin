import type { WarmupMode, WarmupRequest, WarmupResponse, WarmupSource, WarmupStage } from './warmupTypes';

export type WarmupHandlerOptions = {
  warmupSecret: string;
  now?: () => string;
};

const EMPTY_SUMMARY: WarmupResponse['summary'] = {
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

  logWarmupTrigger(payload, jobId, mode);

  return jsonResponse(
    {
      jobId,
      status: 'accepted',
      mode,
      summary: { ...EMPTY_SUMMARY },
      errors: [],
    } satisfies WarmupResponse,
    202,
  );
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
  return errors.join('; ');
}

function isWarmupMode(mode: unknown): mode is WarmupMode {
  return mode === 'bootstrap' || mode === 'incremental';
}

function isWarmupSource(source: unknown): source is WarmupSource {
  return source === 'dashboard-button' || source === 'feishu-workflow' || source === 'manual';
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
