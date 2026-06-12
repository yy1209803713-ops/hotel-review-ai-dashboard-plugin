import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { FIXTURE_ANALYSIS_RESULT } from '../fixtures/analysis';
import type { DashboardRuntime, RuntimeConfig } from '../runtime/sdk';
import type { AnalysisCache } from '../types/config';
import { loadPluginConfig, saveAnalysisCache } from './cacheStore';

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

  it('fills the default API key when an old saved config has an empty key', async () => {
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

    expect(config.ai.apiKey).toBe(DEFAULT_CONFIG.ai.apiKey);
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

  it('falls back to localStorage if Dashboard save fails', async () => {
    const runtime = fakeRuntime(
      { dataConditions: [], customConfig: DEFAULT_CONFIG },
      () => Promise.reject(new Error('save failed')),
    );
    const cache: AnalysisCache = {
      result: { ...FIXTURE_ANALYSIS_RESULT, analysisId: 'analysis-2' },
      scopeSnapshot: {},
      sourceSnapshot: {},
      model: 'gpt-4o-mini',
      generatedAt: '2026-06-03T12:00:00+08:00',
    };

    await saveAnalysisCache(runtime, cache);

    expect(localStorage.getItem('hotel-review-ai-dashboard:fixture-instance')).toContain('analysis-2');
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
    saveConfig,
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
