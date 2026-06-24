import {
  BackendAnalysisError,
  type AnalysisPreflightSyncRunner,
  type BackendAnalysisConfig,
  type BackendAnalysisSourceKind,
} from './backendAnalysis';
import type { ReviewSyncService, ReviewSyncSourceKey } from './reviewSync';

export function createAnalysisPreflightSyncRunner(service: ReviewSyncService): AnalysisPreflightSyncRunner {
  return {
    async run({ config }) {
      await service.runFullSync(toReviewSyncSourceKey(config), 'analysis_preflight');
    },
  };
}

export function toReviewSyncSourceKey(config: BackendAnalysisConfig): ReviewSyncSourceKey {
  if (config.source.kind !== 'postgres') {
    throw new BackendAnalysisError(400, 'sync_source', 'analysis preflight sync requires a postgres source config');
  }

  const sourceConfig = config.source as Record<string, unknown>;
  const sourceId = requireNonEmptyString(sourceConfig.sourceId, 'source.sourceId is required for postgres analysis preflight sync');
  const sourceKind = normalizeSourceKind(sourceConfig.upstreamSourceKind ?? sourceConfig.sourceKind ?? 'feishu_base');
  const tableId = requireNonEmptyString(config.source.tableId, 'source.tableId is required for postgres analysis preflight sync');
  const baseToken = requireNonEmptyString(config.baseToken, 'baseToken is required for postgres analysis preflight sync');

  return {
    tenantKey: config.tenantKey,
    sourceKind,
    sourceId,
    baseToken,
    tableId,
    viewId: config.source.viewId,
    fieldMapping: config.source.fieldMapping,
  };
}

function normalizeSourceKind(value: unknown): BackendAnalysisSourceKind {
  if (value === 'feishu_base' || value === 'postgres' || value === 'external') {
    return value;
  }
  throw new BackendAnalysisError(400, 'sync_source', 'postgres upstream source kind must be feishu_base, postgres, or external');
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BackendAnalysisError(400, 'sync_source', message);
  }
  return value.trim();
}
