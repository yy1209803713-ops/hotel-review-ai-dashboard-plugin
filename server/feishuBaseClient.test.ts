import { describe, expect, it, vi } from 'vitest';
import { createFeishuBaseClient } from './feishuBaseClient';

describe('createFeishuBaseClient', () => {
  it('sends the auth code as a bearer token and parses Feishu data responses', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables?page_size=100');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer auth-code-a',
      });
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          items: [{ table_id: 'tbl-review', name: '酒店评论' }],
        },
      });
    });
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables?page_size=100')).resolves.toEqual({
      has_more: false,
      items: [{ table_id: 'tbl-review', name: '酒店评论' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses a custom OpenAPI host and normalizes trailing slashes', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer auth-code-a',
      });
      return jsonResponse({ code: 0, msg: 'success', data: { ok: true } });
    });
    const client = createFeishuBaseClient({
      authCode: ' auth-code-a ',
      openApiBaseUrl: 'https://proxy.example.test/open-apis///',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).resolves.toEqual({ ok: true });

    expect(urls).toEqual(['https://proxy.example.test/open-apis/bitable/v1/apps/base-a/tables']);
  });

  it('throws a local error when auth code is empty', () => {
    expect(() =>
      createFeishuBaseClient({
        authCode: '   ',
        fetchImpl: vi.fn(),
      }),
    ).toThrow('authCode is required for Feishu Base client');
  });

  it('does not call tenant-token exchange before Base requests', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse({ code: 0, msg: 'success', data: { ok: true } });
    });
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).resolves.toEqual({ ok: true });

    expect(urls).toEqual(['https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables']);
  });

  it('adds JSON content type when sending a body', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer auth-code-a',
        'Content-Type': 'application/json',
      });
      return jsonResponse({ code: 0, msg: 'success', data: { table_id: 'tbl-new' } });
    });
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(
      client.request('/bitable/v1/apps/base-a/tables', {
        method: 'POST',
        body: JSON.stringify({ table: { name: 'AI分析摘要' } }),
      }),
    ).resolves.toEqual({ table_id: 'tbl-new' });
  });

  it('surfaces non-OK Feishu HTTP responses', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 99991663, msg: 'permission denied' }), {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).rejects.toThrow(
      'Feishu OpenAPI HTTP 403 Forbidden for https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables: code 99991663: permission denied',
    );
  });

  it('retries HTTP 429 responses using retry-after before surfacing failures', async () => {
    const delays: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 1254291, msg: 'too many requests' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ code: 0, msg: 'success', data: { ok: true } }));
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).resolves.toEqual({ ok: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([2_000]);
  });

  it('surfaces raw body from non-OK Feishu HTTP responses when JSON details are unavailable', async () => {
    const fetchImpl = vi.fn(async () => new Response('upstream unavailable', { status: 503, statusText: 'Service Unavailable' }));
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).rejects.toThrow(
      'Feishu OpenAPI HTTP 503 Service Unavailable for https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables: upstream unavailable',
    );
  });

  it('surfaces non-zero Feishu response codes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 99991663, msg: 'permission denied' }));
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).rejects.toThrow(
      'Feishu OpenAPI code 99991663 for https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables: permission denied',
    );
  });

  it('surfaces invalid JSON responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const client = createFeishuBaseClient({
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(client.request('/bitable/v1/apps/base-a/tables')).rejects.toThrow('Feishu OpenAPI invalid JSON');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
