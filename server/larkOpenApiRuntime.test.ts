import { describe, expect, it, vi } from 'vitest';
import { createLarkOpenApiRuntime } from './larkOpenApiRuntime';

describe('createLarkOpenApiRuntime', () => {
  it('uses an injected client without requiring auth code options', async () => {
    const requestedPaths: string[] = [];
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      client: {
        async request(path) {
          requestedPaths.push(path);
          return {
            has_more: false,
            items: [{ table_id: 'tbl-review', name: '酒店评论' }],
          };
        },
      },
    });

    await expect(runtime.getTableList()).resolves.toEqual([{ tableId: 'tbl-review', tableName: '酒店评论' }]);
    expect(requestedPaths).toEqual(['/bitable/v1/apps/base-a/tables?page_size=100']);
  });

  it('uses auth code bearer auth and maps Base tables, fields, and records into DashboardRuntime shape', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [{ table_id: 'tbl-review', name: '酒店评论' }],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-review/fields?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [
              { field_id: 'fld-review-id', field_name: '评论ID', type: 1 },
              { field_id: 'fld-content', field_name: '评论内容', type: 1 },
            ],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-review/records?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [
              {
                record_id: 'rec1',
                fields: {
                  评论ID: 'R001',
                  评论内容: '位置很好',
                },
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.getTableList()).resolves.toEqual([{ tableId: 'tbl-review', tableName: '酒店评论' }]);
    await expect(runtime.getFieldMetaList('tbl-review')).resolves.toEqual([
      { fieldId: 'fld-review-id', fieldName: '评论ID', fieldType: 1 },
      { fieldId: 'fld-content', fieldName: '评论内容', fieldType: 1 },
    ]);
    await expect(runtime.readRecordsPage('tbl-review', { pageSize: 50 })).resolves.toEqual({
      records: [
        {
          recordId: 'rec1',
          fields: {
            'fld-review-id': 'R001',
            'fld-content': '位置很好',
            评论ID: 'R001',
            评论内容: '位置很好',
          },
        },
      ],
      hasMore: false,
      pageToken: undefined,
    });
  });

  it('converts DashboardRuntime table and record writes to Feishu OpenAPI payloads', async () => {
    const seenBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url === 'https://base-api.feishu.cn/open-apis/bitable/v1/apps/base-a/tables') {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ code: 0, msg: 'success', data: { table_id: 'tbl-cache' } });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/fields?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [
              { field_id: 'fld-model', field_name: '模型', type: 1 },
              { field_id: 'fld-json', field_name: '证据 JSON', type: 1 },
            ],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_create')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            records: [{ record_id: 'rec-cache-1' }],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_update')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            records: [{ record_id: 'rec-cache-1' }],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_delete')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            records: [{ record_id: 'rec-cache-1' }],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.addTable('AI评论证据缓存', [{ name: '模型', type: 1 }])).resolves.toEqual({
      tableId: 'tbl-cache',
    });
    await expect(
      runtime.addRecords('tbl-cache', [
        {
          fields: {
            'fld-model': 'qwen-plus',
            'fld-json': '[]',
          },
        },
      ]),
    ).resolves.toEqual(['rec-cache-1']);
    await expect(
      runtime.setRecords('tbl-cache', [
        {
          recordId: 'rec-cache-1',
          fields: {
            'fld-model': 'qwen-plus',
          },
        },
      ]),
    ).resolves.toEqual([{ recordId: 'rec-cache-1' }]);
    await expect(runtime.deleteRecords('tbl-cache', ['rec-cache-1'])).resolves.toEqual([{ recordId: 'rec-cache-1' }]);

    expect(seenBodies).toEqual([
      {
        table: {
          name: 'AI评论证据缓存',
          fields: [{ field_name: '模型', type: 1 }],
        },
      },
      {
        records: [
          {
            fields: {
              模型: 'qwen-plus',
              '证据 JSON': '[]',
            },
          },
        ],
      },
      {
        records: [
          {
            record_id: 'rec-cache-1',
            fields: {
              模型: 'qwen-plus',
            },
          },
        ],
      },
      {
        records: ['rec-cache-1'],
      },
    ]);
  });

  it('throws a clear Error when paged Feishu responses omit items', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables?')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.getTableList()).rejects.toThrow('records missing from Feishu OpenAPI paged response');
  });

  it('throws a clear Error when record write responses omit records', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/fields?')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [{ field_id: 'fld-model', field_name: '模型', type: 1 }],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_create')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {},
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_update')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {},
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.addRecords('tbl-cache', [{ fields: { 'fld-model': 'qwen-plus' } }])).rejects.toThrow(
      'records missing after creating records in tbl-cache',
    );
    await expect(runtime.setRecords('tbl-cache', [{ recordId: 'rec-cache-1', fields: { 'fld-model': 'qwen-plus' } }])).rejects.toThrow(
      'records missing after updating records in tbl-cache',
    );
  });

  it('refreshes field metadata after adding a field before writing records', async () => {
    let fieldListCalls = 0;
    const seenBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/fields?')) {
        fieldListCalls += 1;
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: fieldListCalls === 1
              ? [{ field_id: 'fld-model', field_name: '模型', type: 1 }]
              : [
                  { field_id: 'fld-model', field_name: '模型', type: 1 },
                  { field_id: 'fld-analysis-time', field_name: '分析时间', type: 5 },
                ],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/fields')) {
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: { field: { field_id: 'fld-analysis-time', field_name: '分析时间', type: 5 } },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-cache/records/batch_create')) {
        seenBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: { records: [{ record_id: 'rec-created' }] },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.getFieldMetaList('tbl-cache')).resolves.toEqual([
      { fieldId: 'fld-model', fieldName: '模型', fieldType: 1 },
    ]);
    await expect(runtime.addField('tbl-cache', { name: '分析时间', type: 'datetime' })).resolves.toEqual({
      fieldId: 'fld-analysis-time',
    });
    await expect(runtime.addRecords('tbl-cache', [{ fields: { 分析时间: 1782187500000 } }])).resolves.toEqual(['rec-created']);

    expect(fieldListCalls).toBe(2);
    expect(seenBodies).toEqual([
      { field_name: '分析时间', type: 5 },
      { records: [{ fields: { 分析时间: 1782187500000 } }] },
    ]);
  });

  it('does not exchange tenant tokens before retrying a Base request', async () => {
    let tableCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        tableCalls += 1;
        if (tableCalls === 1) {
          return new Response('temporarily unavailable', { status: 500, headers: { 'Content-Type': 'text/plain' } });
        }
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [{ table_id: 'tbl-review', name: '酒店评论' }],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.getTableList()).rejects.toThrow('Feishu OpenAPI HTTP 500');
    await expect(runtime.getTableList()).resolves.toEqual([{ tableId: 'tbl-review', tableName: '酒店评论' }]);
    expect(tableCalls).toBe(2);
  });

  it('uses the same auth code for repeated Base requests without token refresh', async () => {
    let tableCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables?')) {
        tableCalls += 1;
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
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.getTableList()).resolves.toEqual([{ tableId: 'tbl-review', tableName: '酒店评论' }]);
    await expect(runtime.getTableList()).resolves.toEqual([{ tableId: 'tbl-review', tableName: '酒店评论' }]);
    expect(tableCalls).toBe(2);
  });

  it('reads records keyed by field id without failing field mapping', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
        throw new Error('tenant-token exchange must not be called');
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables?')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [{ table_id: 'tbl-review', name: '酒店评论' }],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-review/fields?')) {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [
              { field_id: 'fld-review-id', field_name: '评论ID', type: 1 },
              { field_id: 'fld-content', field_name: '评论内容', type: 1 },
            ],
          },
        });
      }
      if (url.includes('/open-apis/bitable/v1/apps/base-a/tables/tbl-review/records?')) {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer auth-code-a' });
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [
              {
                record_id: 'rec1',
                fields: {
                  'fld-review-id': 'R001',
                  'fld-content': '位置很好',
                },
              },
            ],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    const runtime = createLarkOpenApiRuntime({
      baseToken: 'base-a',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(runtime.readRecordsPage('tbl-review', { pageSize: 50 })).resolves.toEqual({
      records: [
        {
          recordId: 'rec1',
          fields: {
            'fld-review-id': 'R001',
            'fld-content': '位置很好',
            评论ID: 'R001',
            评论内容: '位置很好',
          },
        },
      ],
      hasMore: false,
      pageToken: undefined,
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
