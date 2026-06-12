import type { FieldMapping, FilterState } from '../types/config';
import type { OverviewMetrics, ReviewRecord } from '../types/analysis';

export const ANALYSIS_COPY_VERSION = 'v1.2-conversational-copy';

export type ScopeSnapshot = {
  filters: FilterState;
  fields: FieldMapping;
  model: string;
  analysisCopyVersion: string;
  totalReviews: number;
  firstRecordId: string | null;
  lastRecordId: string | null;
};

export function calculateOverview(records: ReviewRecord[]): OverviewMetrics {
  const scores = records
    .map((record) => record.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  const averageScore = scores.length
    ? roundTo(scores.reduce((sum, score) => sum + score, 0) / scores.length, 2)
    : null;
  const replyCount = records.filter((record) => record.hasReply).length;

  return {
    totalReviews: records.length,
    positiveReviews: 0,
    negativeOrRiskReviews: 0,
    mixedReviews: 0,
    neutralReviews: 0,
    averageScore,
    replyRate: records.length ? replyCount / records.length : 0,
  };
}

export function buildScopeSnapshot(
  records: ReviewRecord[],
  filters: FilterState,
  fields: FieldMapping,
  model: string,
): ScopeSnapshot {
  return {
    filters,
    fields,
    model,
    analysisCopyVersion: ANALYSIS_COPY_VERSION,
    totalReviews: records.length,
    firstRecordId: records[0]?.recordId ?? null,
    lastRecordId: records[records.length - 1]?.recordId ?? null,
  };
}

export function isCacheStale(cached: ScopeSnapshot | null | undefined, current: ScopeSnapshot): boolean {
  if (!cached) {
    return true;
  }

  return stableStringify(cached) !== stableStringify(current);
}

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }

  return value;
}
