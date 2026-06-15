import { DEFAULT_CONFIG } from '../constants/defaults';
import type { DashboardRuntime, RuntimeConfig } from '../runtime/sdk';
import type { AnalysisCache, PluginConfig } from '../types/config';

export async function loadPluginConfig(runtime: DashboardRuntime): Promise<PluginConfig> {
  const config = await runtime.getConfig();
  return normalizePluginConfig(config.customConfig ?? DEFAULT_CONFIG);
}

export async function loadAnalysisCache(runtime: DashboardRuntime): Promise<AnalysisCache | undefined> {
  const pluginConfig = await loadPluginConfig(runtime);
  return pluginConfig.analysisCache;
}

export async function savePluginConfig(runtime: DashboardRuntime, pluginConfig: PluginConfig): Promise<boolean> {
  const current = await runtime.getConfig();
  return persistRuntimeConfig(runtime, {
    dataConditions: current.dataConditions,
    customConfig: pluginConfig,
  });
}

export async function saveAnalysisCache(runtime: DashboardRuntime, analysisCache: AnalysisCache): Promise<void> {
  const current = await runtime.getConfig();
  const pluginConfig = normalizePluginConfig(current.customConfig ?? DEFAULT_CONFIG);
  const nextConfig: RuntimeConfig = {
    dataConditions: current.dataConditions,
    customConfig: {
      ...pluginConfig,
      analysisCache,
    },
  };

  await persistRuntimeConfig(runtime, nextConfig);
}

async function persistRuntimeConfig(runtime: DashboardRuntime, config: RuntimeConfig): Promise<boolean> {
  const saved = await runtime.saveConfig(config);
  if (!saved) {
    throw new Error('Dashboard saveConfig returned false');
  }
  return saved;
}

function normalizePluginConfig(config: Partial<PluginConfig>): PluginConfig {
  const source = {
    ...DEFAULT_CONFIG.source,
    ...config.source,
    fields: {
      ...DEFAULT_CONFIG.source.fields,
      ...config.source?.fields,
    },
  };
  const filters = {
    ...DEFAULT_CONFIG.filters,
    ...config.filters,
  };
  const ai = {
    ...DEFAULT_CONFIG.ai,
    ...config.ai,
  };
  const writeback = {
    ...DEFAULT_CONFIG.writeback,
    ...config.writeback,
  };
  const isOldEmptyEndpoint = !ai.apiBaseUrl.trim();
  const isOldDefaultModel = ai.model === 'gpt-4o-mini' || !ai.model.trim();
  const isEmptyApiKey = !ai.apiKey.trim();

  return {
    ...DEFAULT_CONFIG,
    ...config,
    source,
    filters,
    ai: {
      ...ai,
      apiBaseUrl: isOldEmptyEndpoint ? DEFAULT_CONFIG.ai.apiBaseUrl : ai.apiBaseUrl,
      apiKey: isEmptyApiKey ? '' : ai.apiKey,
      model: isOldDefaultModel ? DEFAULT_CONFIG.ai.model : ai.model,
    },
    writeback,
  };
}
