export type FeishuBaseClientOptions = {
  authCode: string;
  openApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
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

export function createFeishuBaseClient(options: FeishuBaseClientOptions): FeishuBaseClient {
  const authCode = options.authCode.trim();
  if (!authCode) {
    throw new Error('authCode is required for Feishu Base client');
  }
  const openApiBaseUrl = normalizeBaseUrl(options.openApiBaseUrl ?? FEISHU_OPEN_API_BASE_URL);
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    request<T>(path: string, init: RequestInit = {}): Promise<T> {
      const headers: Record<string, string> = {
        ...normalizeHeaders(init.headers),
        Authorization: `Bearer ${authCode}`,
      };
      if (init.body !== undefined && !hasHeader(headers, 'Content-Type')) {
        headers['Content-Type'] = 'application/json';
      }

      return requestJson<T>(fetchImpl, `${openApiBaseUrl}${normalizePath(path)}`, {
        ...init,
        headers,
      });
    },
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

async function requestJson<T>(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
