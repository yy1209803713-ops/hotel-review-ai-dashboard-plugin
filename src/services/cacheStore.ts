import { DEFAULT_CONFIG } from '../constants/defaults';
import type { DashboardRuntime, RuntimeConfig } from '../runtime/sdk';
import type { AnalysisCache, PluginConfig } from '../types/config';

const LOCAL_STORAGE_PREFIX = 'hotel-review-ai-dashboard';

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
  return runtime.saveConfig({
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

  try {
    await runtime.saveConfig(nextConfig);
  } catch {
    const instanceId = await runtime.getInstanceId();
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}:${instanceId}`, JSON.stringify(nextConfig.customConfig));
  }
}

function normalizePluginConfig(config: PluginConfig): PluginConfig {
  const isOldEmptyEndpoint = !config.ai.apiBaseUrl.trim();
  const isOldDefaultModel = config.ai.model === 'gpt-4o-mini' || !config.ai.model.trim();
  const isEmptyApiKey = !config.ai.apiKey.trim();

  return {
    ...DEFAULT_CONFIG,
    ...config,
    source: {
      ...DEFAULT_CONFIG.source,
      ...config.source,
      fields: {
        ...DEFAULT_CONFIG.source.fields,
        ...config.source.fields,
      },
    },
    filters: {
      ...DEFAULT_CONFIG.filters,
      ...config.filters,
    },
    ai: {
      ...DEFAULT_CONFIG.ai,
      ...config.ai,
      apiBaseUrl: isOldEmptyEndpoint ? DEFAULT_CONFIG.ai.apiBaseUrl : config.ai.apiBaseUrl,
      apiKey: isEmptyApiKey ? DEFAULT_CONFIG.ai.apiKey : config.ai.apiKey,
      model: isOldDefaultModel ? DEFAULT_CONFIG.ai.model : config.ai.model,
    },
    writeback: {
      ...DEFAULT_CONFIG.writeback,
      ...config.writeback,
    },
  };
}
