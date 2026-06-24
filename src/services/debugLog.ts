import type { RuntimeConfig } from '../runtime/sdk';
import { DEFAULT_CONFIG } from '../constants/defaults';
import type { FieldMapping, PluginConfig } from '../types/config';
import { getMissingRequiredFields } from './fieldMapping';

export const HOTEL_REVIEW_AI_CONFIG_DEBUG_MARKER = '__HOTEL_REVIEW_AI_CONFIG_DEBUG__';

export function logConfigDebug(stage: string, payload: Record<string, unknown>): void {
  console.info(HOTEL_REVIEW_AI_CONFIG_DEBUG_MARKER, JSON.stringify({ stage, ...payload }));
}

export function summarizePluginConfig(config: Partial<PluginConfig>): Record<string, unknown> {
  return {
    version: config.version,
    source: summarizeSourceConfig(config.source),
    filters: config.filters,
    backend: {
      endpointUrl: config.backend?.endpointUrl,
      hasBaseToken: Boolean(config.backend?.baseToken?.trim()),
    },
    ai: {
      model: config.ai?.model,
    },
    backendConfigId: config.backend?.configId,
    backendConfigVersion: config.backend?.configVersion,
    hasAnalysisCache: Boolean(config.analysisCache),
  };
}

export function summarizeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    dataConditions: config.dataConditions.map((condition) => ({
      tableId: condition.tableId,
      dataRange: condition.dataRange,
      groups: condition.groups,
      series: condition.series,
    })),
    hasCustomConfig: Boolean(config.customConfig),
    customConfig: config.customConfig ? summarizePluginConfig(config.customConfig) : undefined,
  };
}

export function summarizeFieldMapping(fields: Partial<FieldMapping> | undefined): Record<string, unknown> {
  const normalizedFields = {
    ...DEFAULT_CONFIG.source.fields,
    ...fields,
  };
  return {
    values: normalizedFields,
    missingRequiredFields: getMissingRequiredFields(normalizedFields),
    filledRequiredFieldCount: Object.values(normalizedFields).filter((value) => value.trim()).length,
  };
}

function summarizeSourceConfig(source: Partial<PluginConfig['source']> | undefined): Record<string, unknown> {
  return {
    tableId: source?.tableId,
    viewId: source?.viewId,
    dataRange: source?.dataRange,
    fields: summarizeFieldMapping(source?.fields),
  };
}
