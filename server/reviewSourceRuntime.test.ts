import { describe, expect, it, vi } from 'vitest';
import { BackendAnalysisError } from './backendAnalysis';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';
import { createFeishuBaseReviewSourceFactory } from './reviewSourceRuntime';

describe('createFeishuBaseReviewSourceFactory', () => {
  it('reuses a Feishu runtime for the same auth code and base token', async () => {
    const createdRuntimeOptions: unknown[] = [];
    const source = createFeishuBaseReviewSourceFactory({
      env: {
        LARK_BASE_AUTH_CODE: 'auth-code-a',
      },
      createRuntime(options) {
        createdRuntimeOptions.push(options);
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

    expect(createdRuntimeOptions).toEqual([{ baseToken: 'base-a', authCode: 'auth-code-a' }]);
  });

  it('creates a separate runtime for the same base token when the env auth code later changes', async () => {
    const env = {
      LARK_BASE_AUTH_CODE: 'auth-code-a',
    };
    const createRuntime = vi.fn(() => createRuntimeStub());
    const source = createFeishuBaseReviewSourceFactory({
      env,
      createRuntime,
    });
    const query = {
      tenantKey: 'tenant-a',
      baseToken: 'base-a',
      tableId: 'tbl-review',
      fieldMapping: { content: 'fld-review' },
      filters: {},
    };

    await source.listReviews(query);
    env.LARK_BASE_AUTH_CODE = 'auth-code-b';
    await source.getSourceVersion(query);

    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(createRuntime).toHaveBeenNthCalledWith(1, { baseToken: 'base-a', authCode: 'auth-code-a' });
    expect(createRuntime).toHaveBeenNthCalledWith(2, { baseToken: 'base-a', authCode: 'auth-code-b' });
  });

  it('fails on a cached base token when the env auth code is later cleared', async () => {
    const env = {
      LARK_BASE_AUTH_CODE: 'auth-code-a',
    };
    const source = createFeishuBaseReviewSourceFactory({
      env,
      createRuntime: vi.fn(() => createRuntimeStub()),
    });
    const query = {
      tenantKey: 'tenant-a',
      baseToken: 'base-a',
      tableId: 'tbl-review',
      fieldMapping: { content: 'fld-review' },
      filters: {},
    };

    await source.listReviews(query);
    env.LARK_BASE_AUTH_CODE = '';

    await expect(source.getSourceVersion(query)).rejects.toMatchObject({
      name: 'BackendAnalysisError',
      stage: 'resolve_source',
      message: 'LARK_BASE_AUTH_CODE is required for feishu_base review source',
    } satisfies Partial<BackendAnalysisError>);
  });

  it('keeps separate runtime cache entries for different base tokens', async () => {
    const createdRuntimeOptions: unknown[] = [];
    const source = createFeishuBaseReviewSourceFactory({
      env: {
        LARK_BASE_AUTH_CODE: 'auth-code-a',
      },
      createRuntime(options) {
        createdRuntimeOptions.push(options);
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

    expect(createdRuntimeOptions).toEqual([
      { baseToken: 'base-a', authCode: 'auth-code-a' },
      { baseToken: 'base-b', authCode: 'auth-code-a' },
    ]);
  });

});

function createRuntime(): LarkOpenApiRuntime {
  return createRuntimeStub();
}

function createRuntimeStub(): LarkOpenApiRuntime {
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
