import { DEFAULT_CONFIG } from '../constants/defaults';
import type { DashboardRuntime, RuntimeConfig } from '../runtime/sdk';
import type { AnalysisCache, PluginConfig } from '../types/config';
import { buildDataConditions, getPrimaryDataCondition, mergeConfigWithDataCondition } from './dashboardConfig';
import { logConfigDebug, summarizePluginConfig, summarizeRuntimeConfig } from './debugLog';

export async function loadPluginConfig(runtime: DashboardRuntime): Promise<PluginConfig> {
  const config = await runtime.getConfig();
  logConfigDebug('loadPluginConfig:runtime.getConfig', {
    runtimeState: runtime.getState(),
    runtimeConfig: summarizeRuntimeConfig(config),
  });
  const pluginConfig = normalizePluginConfig(config.customConfig ?? DEFAULT_CONFIG);
  const mergedConfig = mergeConfigWithDataCondition(pluginConfig, getPrimaryDataCondition(config));
  logConfigDebug('loadPluginConfig:normalized', {
    runtimeState: runtime.getState(),
    pluginConfig: summarizePluginConfig(mergedConfig),
  });
  return mergedConfig;
}

export async function loadAnalysisCache(runtime: DashboardRuntime): Promise<AnalysisCache | undefined> {
  const pluginConfig = await loadPluginConfig(runtime);
  return pluginConfig.analysisCache;
}

export async function savePluginConfig(runtime: DashboardRuntime, pluginConfig: PluginConfig): Promise<boolean> {
  const runtimeConfig = {
    dataConditions: buildDataConditions(pluginConfig),
    customConfig: pluginConfig,
  };
  logConfigDebug('savePluginConfig:before', {
    runtimeState: runtime.getState(),
    pluginConfig: summarizePluginConfig(pluginConfig),
    runtimeConfig: summarizeRuntimeConfig(runtimeConfig),
  });
  return persistRuntimeConfig(runtime, {
    dataConditions: runtimeConfig.dataConditions,
    customConfig: runtimeConfig.customConfig,
  });
}

export async function saveAnalysisCache(runtime: DashboardRuntime, analysisCache: AnalysisCache): Promise<void> {
  const current = await runtime.getConfig();
  const pluginConfig = mergeConfigWithDataCondition(
    normalizePluginConfig(current.customConfig ?? DEFAULT_CONFIG),
    getPrimaryDataCondition(current),
  );
  const nextPluginConfig = {
    ...pluginConfig,
    analysisCache,
  };
  const nextConfig: RuntimeConfig = {
    dataConditions: buildDataConditions(nextPluginConfig),
    customConfig: nextPluginConfig,
  };

  await persistRuntimeConfig(runtime, nextConfig);
}

async function persistRuntimeConfig(runtime: DashboardRuntime, config: RuntimeConfig): Promise<boolean> {
  const saved = await runtime.saveConfig(config);
  logConfigDebug('savePluginConfig:after', {
    runtimeState: runtime.getState(),
    saved,
    runtimeConfig: summarizeRuntimeConfig(config),
  });
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
  const warmup = {
    ...DEFAULT_CONFIG.warmup,
  };
  const backend = {
    ...DEFAULT_CONFIG.backend,
    ...config.backend,
    endpointUrl: normalizeBackendEndpointUrl(config.backend?.endpointUrl),
  };
  const writeback = {
    ...DEFAULT_CONFIG.writeback,
    ...config.writeback,
  };
  const isOldEmptyEndpoint = !ai.apiBaseUrl.trim();
  const isOldDefaultModel = ai.model === 'gpt-4o-mini' || !ai.model.trim();

  return {
    ...DEFAULT_CONFIG,
    ...config,
    source,
    filters,
    ai: {
      ...ai,
      apiBaseUrl: isOldEmptyEndpoint ? DEFAULT_CONFIG.ai.apiBaseUrl : ai.apiBaseUrl,
      apiKey: '',
      model: isOldDefaultModel ? DEFAULT_CONFIG.ai.model : ai.model,
    },
    backend,
    warmup,
    writeback,
  };
}

function normalizeBackendEndpointUrl(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed || DEFAULT_CONFIG.backend.endpointUrl;
}
