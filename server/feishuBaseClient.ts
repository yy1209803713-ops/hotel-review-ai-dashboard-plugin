export type FeishuBaseClientOptions = {
  authCode: string;
  openApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  maxRateLimitRetries?: number;
  rateLimitRetryDelayMs?: number;
};

export type FeishuBaseClient = {
  request<T>(path: string, init?: RequestInit): Promise<T>;
};

type FeishuOpenApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

const FEISHU_OPEN_API_BASE_URL = 'https://base-api.feishu.cn/open-apis';
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;

export function createFeishuBaseClient(options: FeishuBaseClientOptions): FeishuBaseClient {
  const authCode = options.authCode.trim();
  if (!authCode) {
    throw new Error('authCode is required for Feishu Base client');
  }
  const openApiBaseUrl = normalizeBaseUrl(options.openApiBaseUrl ?? FEISHU_OPEN_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  const rateLimitRetryDelayMs = options.rateLimitRetryDelayMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS;

  return {
    request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const headers: Record<string, string> = {
        ...normalizeHeaders(init.headers),
        Authorization: `Bearer ${authCode}`,
      };
      if (init.body !== undefined && !hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
      }

      return requestJson<T>(
        fetchImpl,
        `${openApiBaseUrl}${normalizePath(path)}`,
        {
          ...init,
          headers,
        },
        {
          sleep,
          maxRateLimitRetries,
          rateLimitRetryDelayMs,
        },
      );
    },
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

type RetryOptions = {
  sleep: (delayMs: number) => Promise<void>;
  maxRateLimitRetries: number;
  rateLimitRetryDelayMs: number;
};

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit, retryOptions: RetryOptions): Promise<T> {
  let attempt = 0;
  let response = await fetchImpl(url, init);
  while (response.status === 429 && attempt < retryOptions.maxRateLimitRetries) {
    attempt += 1;
    await retryOptions.sleep(getRateLimitDelayMs(response, retryOptions.rateLimitRetryDelayMs, attempt));
    response = await fetchImpl(url, init);
  }

  if (!response.ok) {
    const detail = await readErrorResponseDetail(response, url);
    throw new Error(`Feishu OpenAPI HTTP ${response.status} ${response.statusText || 'error'} for ${url}${detail}`);
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    throw new Error(`Feishu OpenAPI invalid JSON for ${url}: ${getErrorMessage(error)}`);
  }

  let body: FeishuOpenApiResponse<T>;
  try {
    body = JSON.parse(bodyText) as FeishuOpenApiResponse<T>;
  } catch (error) {
    throw new Error(`Feishu OpenAPI invalid JSON for ${url}: ${getErrorMessage(error)}`);
  }

  if (body.code !== 0) {
    throw new Error(`Feishu OpenAPI code ${body.code ?? 'missing'} for ${url}: ${body.msg ?? 'unknown error'}`);
  }

  return (body.data ?? body) as T;
}

function getRateLimitDelayMs(response: Response, fallbackDelayMs: number, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const delayMs = parseRetryAfterMs(retryAfter);
    if (delayMs !== undefined) {
      return delayMs;
    }
  }
  return fallbackDelayMs * attempt;
}

function parseRetryAfterMs(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return undefined;
}

async function readErrorResponseDetail(response: Response, url: string): Promise<string> {
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    return `: failed to read response body: ${getErrorMessage(error)}`;
  }

  const trimmedBody = bodyText.trim();
  if (!trimmedBody) {
    return '';
  }

  try {
    const body = JSON.parse(trimmedBody) as FeishuOpenApiResponse<unknown>;
    const detailParts: string[] = [];
    if (body.code !== undefined) {
      detailParts.push(`code ${body.code}`);
    }
    if (body.msg) {
      detailParts.push(body.msg);
    }
    if (detailParts.length > 0) {
      return `: ${detailParts.join(': ')}`;
    }
  } catch {
    return `: ${trimmedBody}`;
  }

  return `: ${trimmedBody}`;
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === target.toLowerCase());
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
