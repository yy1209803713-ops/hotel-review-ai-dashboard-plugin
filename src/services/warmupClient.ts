import type { PluginConfig } from '../types/config';
import type { WarmupMode, WarmupRequest, WarmupResponse, WarmupSource, WarmupStage } from './warmup';

export type WarmupHttpRequest = {
  endpointUrl: string;
  headers: {
    Authorization: string;
    'Content-Type': 'application/json';
  };
  body: WarmupRequest;
};

export class WarmupClientError extends Error {
  constructor(
    message: string,
    public readonly stage?: WarmupStage,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'WarmupClientError';
  }
}

export function buildWarmupRequest(
  config: PluginConfig,
  mode: WarmupMode,
  source: WarmupSource,
): WarmupHttpRequest {
  const endpointUrl = config.warmup.endpointUrl.trim();
  const secret = config.warmup.secret.trim();
  return {
    endpointUrl,
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: {
      mode,
      source,
      tableId: config.source.tableId.trim(),
    },
  };
}

export async function triggerWarmup(
  config: PluginConfig,
  mode: WarmupMode,
  source: WarmupSource,
  fetchImpl: typeof fetch = fetch,
): Promise<WarmupResponse> {
  const endpointUrl = config.warmup.endpointUrl.trim();
  const secret = config.warmup.secret.trim();
  if (!endpointUrl) {
    throw new WarmupClientError('请先填写缓存预热后端接口地址', 'validate_request');
  }
  if (!secret) {
    throw new WarmupClientError('请先填写缓存预热调用密钥', 'validate_request');
  }

  const request = buildWarmupRequest(config, mode, source);
  const body: WarmupRequest = {
    ...request.body,
    baseToken: undefined,
    viewId: config.source.viewId?.trim() || undefined,
    configId: undefined,
    dryRun: false,
  };
  const response = await fetchImpl(request.endpointUrl, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(body),
  });
  const payload = await readWarmupPayload(response);

  if (!response.ok) {
    const firstError = payload.errors?.[0];
    throw new WarmupClientError(
      firstError?.message || `缓存预热接口返回 HTTP ${response.status}`,
      firstError?.stage,
      response.status,
    );
  }

  return payload;
}

async function readWarmupPayload(response: Response): Promise<WarmupResponse> {
  try {
    return (await response.json()) as WarmupResponse;
  } catch (cause) {
    throw new WarmupClientError(
      cause instanceof Error ? `缓存预热接口返回无法解析的 JSON：${cause.message}` : '缓存预热接口返回无法解析的 JSON',
      'validate_request',
      response.status,
    );
  }
}
