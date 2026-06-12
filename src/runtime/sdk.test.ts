import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import type { RawSdkRecord } from '../services/baseRecords';
import { createFixtureRuntime } from './sdk';

describe('createFixtureRuntime', () => {
  const fields = DEFAULT_CONFIG.source.fields;
  const records: RawSdkRecord[] = [
    {
      recordId: 'rec1',
      fields: {
        [fields.reviewId]: '1',
        [fields.content]: '第一条评论',
      },
    },
    {
      recordId: 'rec2',
      fields: {
        [fields.reviewId]: '2',
        [fields.content]: '第二条评论',
      },
    },
    {
      recordId: 'rec3',
      fields: {
        [fields.reviewId]: '3',
        [fields.content]: '第三条评论',
      },
    },
  ];

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paginates local records with stable page tokens', async () => {
    const runtime = createFixtureRuntime({ state: 'View', records });
    const first = await runtime.readRecordsPage(DEFAULT_CONFIG.source.tableId, {
      viewId: DEFAULT_CONFIG.source.viewId,
      pageSize: 2,
    });
    const second = await runtime.readRecordsPage(DEFAULT_CONFIG.source.tableId, {
      viewId: DEFAULT_CONFIG.source.viewId,
      pageSize: 2,
      pageToken: first.pageToken,
    });

    expect(first.records).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.records.length).toBeGreaterThan(0);
    expect(second.records[0].recordId).not.toBe(first.records[0].recordId);
  });

  it('loads local CSV records when explicit records are not injected', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        [
          '评论ID,酒店名称,评分,评论日期,入住日期,酒店回复内容,房型,评论内容',
          '1968962901,昆明中维翠湖宾馆,5.0,2026-06-01 17:13:56,2026-05-01 00:00:00,,商务城景双床房,入住满意',
        ].join('\n'),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createFixtureRuntime({ state: 'View', csvUrl: '/local.csv' });
    const page = await runtime.readRecordsPage(DEFAULT_CONFIG.source.tableId, {
      pageSize: 10,
    });

    expect(fetchMock).toHaveBeenCalledWith('/local.csv', { cache: 'no-store' });
    expect(page.records.map((record) => record.recordId)).toEqual(['csv-1968962901']);
  });

  it('reports local CSV loading failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => '',
      })),
    );

    const runtime = createFixtureRuntime({ state: 'View', csvUrl: '/missing.csv' });

    await expect(
      runtime.readRecordsPage(DEFAULT_CONFIG.source.tableId, {
        pageSize: 10,
      }),
    ).rejects.toThrow('本地 CSV 数据源加载失败：/missing.csv 返回 404 Not Found');
  });

  it('stores config without calling a host SDK', async () => {
    const runtime = createFixtureRuntime({ state: 'Config' });
    const initial = await runtime.getConfig();
    expect(initial.customConfig?.source.tableId).toBe(DEFAULT_CONFIG.source.tableId);
    expect(initial.customConfig?.analysisCache).toBeUndefined();

    const updated = {
      ...DEFAULT_CONFIG,
      ai: { ...DEFAULT_CONFIG.ai, model: 'gpt-4.1-mini' },
    };
    await runtime.saveConfig({
      dataConditions: [],
      customConfig: updated,
    });

    expect((await runtime.getConfig()).customConfig?.ai.model).toBe('gpt-4.1-mini');
  });

  it('can preload bundled demo analysis for local preview', async () => {
    const runtime = createFixtureRuntime({ state: 'View', demoAnalysis: true });
    const config = await runtime.getConfig();
    const records = await runtime.readRecordsByIds(DEFAULT_CONFIG.source.tableId, ['rec27ww4KBxDj2']);

    expect(config.customConfig?.analysisCache?.result.analysisId).toBe('analysis-fixture-20260603');
    expect(config.customConfig?.analysisCache?.result.positiveTopics[0].commentRecordIds.length).toBeGreaterThan(0);
    expect(records[0].recordId).toBe('rec27ww4KBxDj2');
  });

  it('removes legacy bundled fixture analysis cache while preserving user config', async () => {
    localStorage.setItem(
      'hotel-review-ai-dashboard:fixture-config',
      JSON.stringify({
        dataConditions: [],
        customConfig: {
          ...DEFAULT_CONFIG,
          ai: {
            ...DEFAULT_CONFIG.ai,
            apiBaseUrl: 'https://api.example.com/v1',
            model: 'gpt-5.4',
          },
          analysisCache: {
            result: {
              analysisId: 'analysis-fixture-20260603',
              model: 'fixture-ai',
            },
            scopeSnapshot: {},
            sourceSnapshot: DEFAULT_CONFIG.source,
            model: 'fixture-ai',
            generatedAt: '2026-06-03T12:00:00+08:00',
          },
        },
      }),
    );

    const runtime = createFixtureRuntime({ state: 'Config' });
    const config = await runtime.getConfig();

    expect(config.customConfig?.ai.apiBaseUrl).toBe('https://api.example.com/v1');
    expect(config.customConfig?.ai.model).toBe('gpt-5.4');
    expect(config.customConfig?.analysisCache).toBeUndefined();
  });
});
