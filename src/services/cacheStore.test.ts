import { SourceType } from '@lark-base-open/js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { FIXTURE_ANALYSIS_RESULT } from '../fixtures/analysis';
import type { DashboardRuntime, RuntimeConfig } from '../runtime/sdk';
import type { AnalysisCache, PluginConfig } from '../types/config';
import { loadPluginConfig, saveAnalysisCache, savePluginConfig } from './cacheStore';

describe('cacheStore', () => {
  it('loads default plugin config when Dashboard config is empty', async () => {
    const runtime = fakeRuntime({ dataConditions: [] });
    expect(await loadPluginConfig(runtime)).toEqual(DEFAULT_CONFIG);
  });

  it('fills new default AI endpoint and model into old empty saved configs', async () => {
    const runtime = fakeRuntime({
      dataConditions: [],
      customConfig: {
        ...DEFAULT_CONFIG,
        ai: {
          ...DEFAULT_CONFIG.ai,
          apiBaseUrl: '',
          apiKey: 'sk-existing',
          model: 'gpt-4o-mini',
        },
      },
    });

    const config = await loadPluginConfig(runtime);

    expect(config.ai.apiBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(config.ai.apiKey).toBe('sk-existing');
    expect(config.ai.model).toBe('qwen-plus');
  });

  it('keeps an empty API key when an old saved config has no key', async () => {
    const runtime = fakeRuntime({
      dataConditions: [],
      customConfig: {
        ...DEFAULT_CONFIG,
        ai: {
          ...DEFAULT_CONFIG.ai,
          apiKey: '',
        },
      },
    });

    const config = await loadPluginConfig(runtime);

    expect(config.ai.apiKey).toBe('');
  });

  it('normalizes partial legacy custom configs before reading nested AI values', async () => {
    const runtime = fakeRuntime({
      dataConditions: [],
      customConfig: {
        version: 1,
        ai: {
          model: 'gpt-4o-mini',
          apiKey: '',
        },
      } as unknown as PluginConfig,
    });

    const config = await loadPluginConfig(runtime);

    expect(config.source).toEqual(DEFAULT_CONFIG.source);
    expect(config.filters).toEqual(DEFAULT_CONFIG.filters);
    expect(config.writeback).toEqual(DEFAULT_CONFIG.writeback);
    expect(config.ai.apiBaseUrl).toBe(DEFAULT_CONFIG.ai.apiBaseUrl);
    expect(config.ai.apiKey).toBe('');
    expect(config.ai.model).toBe(DEFAULT_CONFIG.ai.model);
  });

  it('normalizes configs that are missing ai and source blocks', async () => {
    const runtime = fakeRuntime({
      dataConditions: [],
      customConfig: {
        version: 1,
      } as unknown as PluginConfig,
    });

    await expect(loadPluginConfig(runtime)).resolves.toEqual(DEFAULT_CONFIG);
  });

  it('preserves plugin config and replaces only analysisCache', async () => {
    let savedConfig: RuntimeConfig | null = null;
    const runtime = fakeRuntime(
      {
        dataConditions: [{ tableId: 'tbl' }],
        customConfig: {
          ...DEFAULT_CONFIG,
          ai: { ...DEFAULT_CONFIG.ai, model: 'custom-model' },
        },
      },
      (config: RuntimeConfig) => {
        savedConfig = config;
        return Promise.resolve(true);
      },
    );
    const cache: AnalysisCache = {
      result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-1' },
      scopeSnapshot: { a: 1 },
      sourceSnapshot: { b: 2 },
      model: 'custom-model',
      generatedAt: '2026-06-03T12:00:00+08:00',
    };

    await saveAnalysisCache(runtime, cache);

    const configAfterSave = savedConfig as unknown as RuntimeConfig;
    expect(configAfterSave.customConfig?.ai.model).toBe('custom-model');
    expect(configAfterSave.customConfig?.analysisCache).toEqual(cache);
  });

  it('saves plugin config with dashboard data conditions', async () => {
    let savedConfig: RuntimeConfig | null = null;
    const pluginConfig: PluginConfig = {
      ...DEFAULT_CONFIG,
      source: {
        ...DEFAULT_CONFIG.source,
        tableId: 'tbl1',
        viewId: 'vew1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        fields: { ...DEFAULT_CONFIG.source.fields, reviewId: 'fld_review_id' },
      },
    };
    const runtime = fakeRuntime({ dataConditions: [], customConfig: DEFAULT_CONFIG }, async (config) => {
      savedConfig = config;
      return true;
    });

    await savePluginConfig(runtime, pluginConfig);

    expect((savedConfig as unknown as RuntimeConfig).dataConditions).toEqual([
      {
        tableId: 'tbl1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        groups: [{ fieldId: 'fld_review_id' }],
        series: 'COUNTA',
      },
    ]);
  });

  it('saves analysis cache with data conditions restored from Dashboard config', async () => {
    let savedConfig: RuntimeConfig | null = null;
    const runtime = fakeRuntime(
      {
        dataConditions: [
          {
            tableId: 'tbl1',
            dataRange: { type: SourceType.ALL },
            groups: [{ fieldId: 'fld_review_id' }],
            series: 'COUNTA',
          },
        ],
        customConfig: {
          ...DEFAULT_CONFIG,
          source: {
            ...DEFAULT_CONFIG.source,
            fields: { ...DEFAULT_CONFIG.source.fields, reviewId: 'fld_review_id' },
          },
        },
      },
      async (config) => {
        savedConfig = config;
        return true;
      },
    );
    const cache: AnalysisCache = {
      result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-with-source' },
      scopeSnapshot: {},
      sourceSnapshot: {},
      model: 'qwen-plus',
      generatedAt: '2026-06-03T12:00:00+08:00',
    };

    await saveAnalysisCache(runtime, cache);

    expect((savedConfig as unknown as RuntimeConfig).dataConditions).toEqual([
      {
        tableId: 'tbl1',
        dataRange: { type: SourceType.ALL },
        groups: [{ fieldId: 'fld_review_id' }],
        series: 'COUNTA',
      },
    ]);
    expect((savedConfig as unknown as RuntimeConfig).customConfig?.source.tableId).toBe('tbl1');
  });

  it('surfaces Dashboard save failures instead of falling back to localStorage', async () => {
    const runtime = fakeRuntime(
      { dataConditions: [], customConfig: DEFAULT_CONFIG },
      () => Promise.reject(new Error('save failed')),
    );
    const cache: AnalysisCache = {
      result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-2' },
      scopeSnapshot: {},
      sourceSnapshot: {},
      model: 'qwen-plus',
      generatedAt: '2026-06-03T12:00:00+08:00',
    };

    await expect(saveAnalysisCache(runtime, cache)).rejects.toThrow('save failed');

    expect(localStorage.getItem('hotel-review-ai-dashboard:fixture-instance')).toBeNull();
  });

  it('surfaces Dashboard save false results when writing analysis cache', async () => {
    const runtime = fakeRuntime({ dataConditions: [], customConfig: DEFAULT_CONFIG }, () => Promise.resolve(false));
    const cache: AnalysisCache = {
      result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-3' },
      scopeSnapshot: {},
      sourceSnapshot: {},
      model: 'qwen-plus',
      generatedAt: '2026-06-03T12:00:00+08:00',
    };

    await expect(saveAnalysisCache(runtime, cache)).rejects.toThrow('Dashboard saveConfig returned false');
  });

  it('surfaces Dashboard save false results when writing plugin config', async () => {
    const runtime = fakeRuntime({ dataConditions: [], customConfig: DEFAULT_CONFIG }, () => Promise.resolve(false));

    await expect(savePluginConfig(runtime, DEFAULT_CONFIG)).rejects.toThrow('Dashboard saveConfig returned false');
  });
});

function fakeRuntime(
  config: RuntimeConfig,
  saveConfig: (config: RuntimeConfig) => Promise<boolean> = vi.fn(async () => true),
): DashboardRuntime {
  return {
    isFixture: true,
    getState: () => 'View',
    getTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    getConfig: vi.fn(async () => config),
    getPreviewData: vi.fn(async () => []),
    getData: vi.fn(async () => []),
    saveConfig,
    onDataChange: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getTableList: vi.fn(),
    getFieldMetaList: vi.fn(),
    getTableDataRange: vi.fn(),
    getCategories: vi.fn(),
    readRecordsPage: vi.fn(),
    readRecordsByIds: vi.fn(),
    canEditBase: vi.fn(),
    addTable: vi.fn(),
    addRecords: vi.fn(),
    setRendered: vi.fn(),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
  };
}
