import { describe, expect, it, vi } from 'vitest';
import { buildFieldMetaIndex, createFeishuBaseApi } from './feishuBaseApi';

describe('createFeishuBaseApi', () => {
  it('indexes field metadata by both field id and field name', () => {
    const fields = [
      { field_id: 'fld-a', field_name: '评论ID', type: 1 },
      { field_id: 'fld-b', field_name: '评论内容', type: 2 },
    ];

    const index = buildFieldMetaIndex(fields);

    expect(index.get('fld-a')).toEqual(fields[0]);
    expect(index.get('评论内容')).toEqual(fields[1]);
  });

  it('maps page requests to listBase tables and auto-encodes base token', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe('https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables?page_size=2');
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          items: [
            { table_id: 'tbl-a', name: 'Reviews' },
            { table_id: 'tbl-b', name: 'Summary' },
          ],
        },
      });
    });

    const api = createFeishuBaseApi({
      baseToken: 'base-space',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(api.listTablesPage({ pageSize: 2 })).resolves.toEqual({
      has_more: false,
      items: [
        { table_id: 'tbl-a', name: 'Reviews' },
        { table_id: 'tbl-b', name: 'Summary' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fetches all field pages with helper pagination', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables/tbl-review/fields?page_size=2') {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: true,
            page_token: 'page-next',
            items: [{ field_id: 'fld-a', field_name: '评论ID', type: 1 }],
          },
        });
      }
      if (url === 'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables/tbl-review/fields?page_size=2&page_token=page-next') {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: {
            has_more: false,
            items: [{ field_id: 'fld-b', field_name: '评论内容', type: 1 }],
          },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const api = createFeishuBaseApi({
      baseToken: 'base-space',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(api.listAllFields('tbl-review', 2)).resolves.toEqual([
      { field_id: 'fld-a', field_name: '评论ID', type: 1 },
      { field_id: 'fld-b', field_name: '评论内容', type: 1 },
    ]);
  });

  it('lists records page with view parameter and returns mapped OpenAPI shape', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables/tbl-review/records?page_size=50&page_token=cursor-1&view_id=view-active',
      );
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          page_token: '',
          items: [{ record_id: 'rec-1', fields: { 评论ID: 'R001', 评论内容: 'good' } }],
        },
      });
    });

    const api = createFeishuBaseApi({
      baseToken: 'base-space',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(
      api.listRecordsPage('tbl-review', {
        pageSize: 50,
        pageToken: 'cursor-1',
        viewId: 'view-active',
      }),
    ).resolves.toEqual({
      has_more: false,
      page_token: '',
      items: [{ record_id: 'rec-1', fields: { 评论ID: 'R001', 评论内容: 'good' } }],
    });
  });

  it('creates tables and record writes with expected OpenAPI payloads', async () => {
    const seen: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables') {
        seen.push(JSON.parse(String(init?.body)));
        return jsonResponse({ code: 0, msg: 'success', data: { table_id: 'tbl-created' } });
      }
      if (url === 'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables/tbl-created/records/batch_create') {
        seen.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: { records: [{ record_id: 'rec-created' }] },
        });
      }
      if (url === 'https://open.feishu.cn/open-apis/bitable/v1/apps/base-space/tables/tbl-created/records/batch_update') {
        seen.push(JSON.parse(String(init?.body)));
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: { records: [{ record_id: 'rec-updated' }] },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const api = createFeishuBaseApi({
      baseToken: 'base-space',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(api.createTable('AI分析摘要', [{ field_name: '结果', type: 1 }])).resolves.toEqual({ table_id: 'tbl-created' });
    await expect(
      api.createRecords('tbl-created', [{ fields: { 结果: 'OK' } }]),
    ).resolves.toEqual({ records: [{ record_id: 'rec-created' }] });
    await expect(
      api.updateRecords('tbl-created', [{ record_id: 'rec-created', fields: { 结果: 'Updated' } }]),
    ).resolves.toEqual({ records: [{ record_id: 'rec-updated' }] });

    expect(seen).toEqual([
      {
        table: {
          name: 'AI分析摘要',
          fields: [{ field_name: '结果', type: 1 }],
        },
      },
      { records: [{ fields: { 结果: 'OK' } }] },
      { records: [{ record_id: 'rec-created', fields: { 结果: 'Updated' } }] },
    ]);
  });

  it('surfaces errors when page response items are missing on paged responses', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: true,
          page_token: 'next',
        },
      }),
    );

    const api = createFeishuBaseApi({
      baseToken: 'base-space',
      authCode: 'auth-code-a',
      fetchImpl,
    });

    await expect(api.listAllTables(50)).rejects.toThrow('items missing from Feishu OpenAPI paged response');
  });

  it('errors when auth code is missing', () => {
    expect(() =>
      createFeishuBaseApi({
        baseToken: 'base-space',
        authCode: '   ',
        fetchImpl: vi.fn(),
      }),
    ).toThrow('authCode is required for Feishu Base API');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
