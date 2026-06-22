import { describe, expect, it } from 'vitest';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';
import { createFeishuBaseReviewSourceFactory } from './reviewSourceRuntime';

describe('createFeishuBaseReviewSourceFactory', () => {
  it('reuses a Feishu runtime for the same app and base token', async () => {
    const createdBaseTokens: string[] = [];
    const source = createFeishuBaseReviewSourceFactory({
      env: {
        LARK_APP_ID: 'app-a',
        LARK_APP_SECRET: 'secret-a',
      },
      createRuntime(options) {
        createdBaseTokens.push(options.baseToken);
        return createRuntime();
      },
    });
    const query = {
      tenantKey: 'tenant-a',
      baseToken: 'base-a',
      tableId: 'tbl-review',
      fieldMapping: { content: 'fld-review' },
      filters: {},
    };

    await source.listReviews(query);
    await source.getSourceVersion(query);

    expect(createdBaseTokens).toEqual(['base-a']);
  });

  it('keeps separate runtime cache entries for different base tokens', async () => {
    const createdBaseTokens: string[] = [];
    const source = createFeishuBaseReviewSourceFactory({
      env: {
        LARK_APP_ID: 'app-a',
        LARK_APP_SECRET: 'secret-a',
      },
      createRuntime(options) {
        createdBaseTokens.push(options.baseToken);
        return createRuntime();
      },
    });

    await source.listReviews({
      tenantKey: 'tenant-a',
      baseToken: 'base-a',
      tableId: 'tbl-review',
      fieldMapping: { content: 'fld-review' },
      filters: {},
    });
    await source.listReviews({
      tenantKey: 'tenant-a',
      baseToken: 'base-b',
      tableId: 'tbl-review',
      fieldMapping: { content: 'fld-review' },
      filters: {},
    });

    expect(createdBaseTokens).toEqual(['base-a', 'base-b']);
  });
});

function createRuntime(): LarkOpenApiRuntime {
  return {
    async readRecordsPage() {
      return {
        records: [{ recordId: 'rec-1', fields: { 'fld-review': 'Great view' } }],
        hasMore: false,
      };
    },
    async getTableList() {
      return [];
    },
    async getFieldMetaList() {
      return [];
    },
    clearFieldMetaCache() {},
    async addTable() {
      return { tableId: 'tbl-new' };
    },
    async addRecords() {
      return [];
    },
    async setRecords() {
      return [];
    },
  };
}
