import { SourceType, type IDataCondition, type IDataRange } from '@lark-base-open/js-sdk';
import type { RuntimeConfig } from '../runtime/sdk';
import type { PluginConfig } from '../types/config';

export function getPrimaryDataCondition(config: RuntimeConfig): IDataCondition | null {
  return config.dataConditions[0] ? config.dataConditions[0] : null;
}

export function buildDataConditions(config: PluginConfig): IDataCondition[] {
  if (!config.source.tableId) {
    return [];
  }

  const reviewIdField = config.source.fields.reviewId;
  return [
    {
      tableId: config.source.tableId,
      dataRange: normalizeDataRange(config.source.dataRange, config.source.viewId),
      groups: reviewIdField ? [{ fieldId: reviewIdField }] : undefined,
      series: 'COUNTA',
    },
  ];
}

export function mergeConfigWithDataCondition(config: PluginConfig, dataCondition: IDataCondition | null): PluginConfig {
  if (!dataCondition) {
    return config;
  }

  return {
    ...config,
    source: {
      ...config.source,
      tableId: dataCondition.tableId ?? config.source.tableId,
      viewId: dataCondition.dataRange?.type === SourceType.VIEW ? dataCondition.dataRange.viewId : config.source.viewId,
      dataRange: dataCondition.dataRange ?? config.source.dataRange,
    },
  };
}

function normalizeDataRange(dataRange: unknown, viewId?: string): IDataRange | undefined {
  if (dataRange && typeof dataRange === 'object') {
    return dataRange as IDataRange;
  }

  return viewId ? { type: SourceType.VIEW, viewId, viewName: '表格' } : { type: SourceType.ALL };
}
