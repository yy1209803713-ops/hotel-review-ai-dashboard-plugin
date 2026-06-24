import { BackendAnalysisError } from './backendAnalysis';
import type { FacilityFieldMapping } from './facilityAnalysis';
import type { FacilityAnalysisRunner } from './facilityAnalysisRunner';

export type FacilityAnalysisHandlerOptions = {
  secret: string;
  runner: FacilityAnalysisRunner;
};

type FacilityAnalyzeRequest = {
  tenantKey?: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldMapping?: Partial<FacilityFieldMapping>;
};

const API_PATH = '/api/hotel-review-ai/facilities/analyze';

export async function handleFacilityAnalysisRequest(
  request: Request,
  options: FacilityAnalysisHandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== API_PATH) {
    return jsonResponse({ stage: 'validate_request', message: 'not found' }, 404);
  }
  try {
    if (request.method === 'OPTIONS') {
      return emptyCorsResponse(204);
    }
    if (request.method !== 'POST') {
      throw new BackendAnalysisError(405, 'validate_request', 'method not allowed');
    }
    if (!isAuthorized(request, options.secret)) {
      throw new BackendAnalysisError(401, 'validate_request', 'invalid facility analysis authorization');
    }
    const body = await parseJsonBody<FacilityAnalyzeRequest>(request);
    validateBody(body);
    const saved = await options.runner.run({
      tenantKey: body.tenantKey,
      baseToken: body.baseToken,
      tableId: body.tableId,
      viewId: body.viewId,
      fieldMapping: body.fieldMapping,
    });
    return jsonResponse({
      resultId: saved.resultId,
      generatedAt: saved.result.generatedAt,
      collectionDate: saved.result.collectionDate,
      summary: saved.result.summary,
      dailySummary: saved.result.dailySummary,
      hotelDiffs: saved.result.hotelDiffs,
    }, 200);
  } catch (cause) {
    if (cause instanceof BackendAnalysisError) {
      return jsonResponse({ stage: cause.stage, message: cause.message }, cause.status);
    }
    throw cause;
  }
}

function isAuthorized(request: Request, secret: string): boolean {
  const expected = secret.trim();
  return Boolean(expected) && request.headers.get('authorization') === `Bearer ${expected}`;
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new BackendAnalysisError(400, 'validate_request', 'invalid JSON body');
  }
}

function validateBody(body: FacilityAnalyzeRequest): asserts body is Required<Pick<FacilityAnalyzeRequest, 'tenantKey' | 'baseToken' | 'tableId'>> & FacilityAnalyzeRequest {
  const missing = ['tenantKey', 'baseToken', 'tableId'].filter((key) => !isNonEmptyString(body[key as keyof FacilityAnalyzeRequest]));
  if (missing.length) {
    throw new BackendAnalysisError(400, 'validate_request', `missing required fields: ${missing.join(', ')}`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' }),
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
