import {
  BackendAnalysisError,
  type BackendAnalysisSourceKind,
  type SourceVersion,
} from './backendAnalysis';
import type { ReviewSyncStore } from './postgresReviewSyncStore';
import { GLOBAL_REVIEW_SOURCE_TENANT_KEY, type ReviewSyncSourceKey } from './reviewSync';
import type { ReviewRecord, ReviewSource, ReviewSourceQuery } from './reviewSource';
import { formatReviewDateRangeBoundary, isReviewDateRangeBoundaryString } from '../src/services/filtering';

export type PostgresReviewSourceOptions = {
  store: ReviewSyncStore;
};

export class PostgresReviewSource implements ReviewSource {
  readonly kind = 'postgres';

  constructor(private readonly options: PostgresReviewSourceOptions) {}

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    const sourceKey = toReadModelSourceKey(query);
    const records = await this.options.store.listReviewRecords(sourceKey, {
      reviewDateRange: readReviewDateRange(query.filters),
    });
    return records.map((record) => ({
      recordId: record.recordId,
      fields: structuredClone(record.fields),
      mappedFields: structuredClone(record.parsedReview),
      content: record.content,
      contentHash: record.contentHash,
    }));
  }

  async getSourceVersion(query: ReviewSourceQuery): Promise<SourceVersion> {
    const sourceKey = toReadModelSourceKey(query);
    const sourceVersion = await this.options.store.getLatestSourceVersion(sourceKey);
    if (!sourceVersion) {
      throw new BackendAnalysisError(404, 'resolve_source', `source version not found for ${sourceKey.sourceId}; run sync first`);
    }
    return {
      ...sourceVersion,
      kind: 'postgres',
    };
  }
}

function readReviewDateRange(filters: ReviewSourceQuery['filters']): { startDate?: string; endDate?: string } | undefined {
  if (!isRecord(filters)) {
    return undefined;
  }
  const startDate = pickReviewDateBoundary(filters.startDate, 'startDate', 'start');
  const endDate = pickReviewDateBoundary(filters.endDate, 'endDate', 'end');
  if (!startDate && !endDate) {
    return undefined;
  }
  return {
    startDate,
    endDate,
  };
}

function pickReviewDateBoundary(value: unknown, fieldName: string, boundary: 'start' | 'end'): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isReviewDateRangeBoundaryString(value)) {
    throw new BackendAnalysisError(400, 'resolve_source', `${fieldName} must be YYYY-MM-DD or YYYY-MM-DD HH:mm:ss`);
  }
  return formatReviewDateRangeBoundary(value, boundary);
}

function toReadModelSourceKey(query: ReviewSourceQuery): ReviewSyncSourceKey {
  const sourceId = resolveSourceId(query);
  return {
    tenantKey: GLOBAL_REVIEW_SOURCE_TENANT_KEY,
    sourceKind: resolveUpstreamSourceKind(query),
    sourceId,
    baseToken: query.baseToken,
    tableId: query.tableId,
    fieldMapping: query.fieldMapping,
  };
}

function resolveSourceId(query: ReviewSourceQuery): string {
  const configuredSourceId = pickNonEmptyString(query.sourceConfig?.sourceId);
  if (configuredSourceId) {
    return configuredSourceId;
  }

  const feishuSourceId = [query.baseToken, query.tableId].filter(isNonEmptyString).join(':');
  if (feishuSourceId) {
    return feishuSourceId;
  }

  throw new BackendAnalysisError(400, 'resolve_source', 'sourceConfig.sourceId is required for postgres review source');
}

function resolveUpstreamSourceKind(query: ReviewSourceQuery): BackendAnalysisSourceKind {
  const configuredKind = pickNonEmptyString(query.sourceConfig?.upstreamSourceKind ?? query.sourceConfig?.sourceKind);
  if (configuredKind) {
    if (configuredKind === 'feishu_base' || configuredKind === 'postgres' || configuredKind === 'external') {
      return configuredKind;
    }
    throw new BackendAnalysisError(400, 'resolve_source', 'postgres upstream source kind must be feishu_base, postgres, or external');
  }

  if (query.baseToken || query.tableId) {
    return 'feishu_base';
  }

  return 'postgres';
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (!isNonEmptyString(value)) {
    throw new BackendAnalysisError(400, 'resolve_source', message);
  }
  return value;
}

function pickNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
