import { createHash } from 'node:crypto';
import {
  BackendAnalysisError,
  canonicalJson,
  type BackendAnalysisSourceKind,
  type JsonValue,
  type SourceVersion,
} from './backendAnalysis';
import type { LarkOpenApiRuntime } from './larkOpenApiRuntime';

export type ReviewSourceKind = BackendAnalysisSourceKind;

export type ReviewSourceQuery = {
  tenantKey: string;
  baseToken?: string;
  tableId?: string;
  viewId?: string;
  fieldMapping: Record<string, string>;
  filters?: JsonValue;
  hostScope?: JsonValue;
  sourceConfig?: Record<string, JsonValue | undefined>;
  pageSize?: number;
};

export type ReviewRecord = {
  recordId: string;
  fields: Record<string, unknown>;
  mappedFields: Record<string, unknown>;
  content?: string;
  contentHash: string;
};

export type ReviewSourceMetrics = {
  baseReadDurationMs: number;
  recordCount: number;
  pageCount: number;
  recordsPerSecond: number;
  apiRetryCount: number;
  rateLimitCount: number;
  readErrorCount: number;
};

export type ReviewSource = {
  kind: ReviewSourceKind;
  listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]>;
  getSourceVersion(query: ReviewSourceQuery, reviews?: ReviewRecord[]): Promise<SourceVersion>;
};

export type FeishuBaseReviewSourceOptions = {
  runtime: LarkOpenApiRuntime;
  defaultPageSize?: number;
  now?: () => number;
};

const DEFAULT_PAGE_SIZE = 100;

export class FeishuBaseReviewSource implements ReviewSource {
  readonly kind = 'feishu_base';

  private readonly runtime: LarkOpenApiRuntime;
  private readonly defaultPageSize: number;
  private readonly now: () => number;
  private lastMetrics: ReviewSourceMetrics = emptyMetrics();

  constructor(options: FeishuBaseReviewSourceOptions) {
    this.runtime = options.runtime;
    this.defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.now = options.now ?? Date.now;
  }

  getLastMetrics(): ReviewSourceMetrics {
    return { ...this.lastMetrics };
  }

  async listReviews(query: ReviewSourceQuery): Promise<ReviewRecord[]> {
    if (!isNonEmptyString(query.tableId)) {
      throw new BackendAnalysisError(400, 'read_source', 'tableId is required for feishu_base source');
    }

    const startedAt = this.now();
    const metrics = emptyMetrics();
    const reviews: ReviewRecord[] = [];
    let pageToken: unknown = undefined;

    try {
      do {
        metrics.pageCount += 1;
        const page = await this.runtime.readRecordsPage(query.tableId, {
          viewId: query.viewId,
          pageSize: query.pageSize ?? this.defaultPageSize,
          pageToken,
        });
        for (const record of page.records) {
          reviews.push(toReviewRecord(record, query.fieldMapping));
        }
        pageToken = page.hasMore ? page.pageToken : undefined;
      } while (pageToken !== undefined && pageToken !== null && pageToken !== '');

      metrics.recordCount = reviews.length;
      this.lastMetrics = finalizeMetrics(metrics, startedAt, this.now());
      return reviews;
    } catch (cause) {
      metrics.readErrorCount = 1;
      if (isRateLimitError(cause)) {
        metrics.rateLimitCount = 1;
      }
      this.lastMetrics = finalizeMetrics(metrics, startedAt, this.now());
      if (cause instanceof BackendAnalysisError) {
        throw cause;
      }
      throw new BackendAnalysisError(502, 'read_source', errorMessage(cause));
    }
  }

  async getSourceVersion(query: ReviewSourceQuery, reviews?: ReviewRecord[]): Promise<SourceVersion> {
    const sourceReviews = reviews ?? (await this.listReviews(query));
    const stableRecords = sourceReviews
      .map((review) => ({
        recordId: review.recordId,
        contentHash: review.contentHash,
        mappedFields: review.mappedFields,
      }))
      .sort(compareVersionRecords);
    const contentHash = sha256(
      canonicalJson({
        sourceId: buildFeishuSourceId(query),
        records: stableRecords,
      }),
    );

    return {
      kind: 'feishu_base',
      sourceId: buildFeishuSourceId(query),
      version: `source-${contentHash.slice(0, 16)}`,
      generatedAt: new Date(this.now()).toISOString(),
      recordCount: sourceReviews.length,
      contentHash,
    };
  }
}

function toReviewRecord(
  record: { recordId: string; fields: Record<string, unknown> },
  fieldMapping: Record<string, string>,
): ReviewRecord {
  const mappedFields: Record<string, unknown> = {};

  for (const [name, fieldId] of Object.entries(fieldMapping)) {
    if (!Object.prototype.hasOwnProperty.call(record.fields, fieldId)) {
      throw new BackendAnalysisError(502, 'read_source', `mapped field ${name}(${fieldId}) is missing in record ${record.recordId}`);
    }
    mappedFields[name] = record.fields[fieldId];
  }

  const contentValue = mappedFields.content ?? mappedFields.reviewText;
  const content = typeof contentValue === 'string' ? contentValue : contentValue === undefined ? undefined : String(contentValue);
  const contentHash = sha256(
    canonicalJson({
      recordId: record.recordId,
      fields: record.fields,
      mappedFields,
      content: content ?? null,
    }),
  );

  return {
    recordId: record.recordId,
    fields: { ...record.fields },
    mappedFields,
    content,
    contentHash,
  };
}

function buildFeishuSourceId(query: ReviewSourceQuery): string {
  return [query.baseToken, query.tableId, query.viewId].filter(isNonEmptyString).join(':') || 'feishu_base';
}

function finalizeMetrics(metrics: ReviewSourceMetrics, startedAt: number, finishedAt: number): ReviewSourceMetrics {
  const durationMs = Math.max(0, finishedAt - startedAt);
  return {
    ...metrics,
    baseReadDurationMs: durationMs,
    recordsPerSecond: Math.round((metrics.recordCount * 1_000) / Math.max(durationMs, 1)),
  };
}

function emptyMetrics(): ReviewSourceMetrics {
  return {
    baseReadDurationMs: 0,
    recordCount: 0,
    pageCount: 0,
    recordsPerSecond: 0,
    apiRetryCount: 0,
    rateLimitCount: 0,
    readErrorCount: 0,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function compareVersionRecords(
  left: { recordId: string; contentHash: string; mappedFields: Record<string, unknown> },
  right: { recordId: string; contentHash: string; mappedFields: Record<string, unknown> },
): number {
  return (
    left.recordId.localeCompare(right.recordId) ||
    left.contentHash.localeCompare(right.contentHash) ||
    canonicalJson(left.mappedFields).localeCompare(canonicalJson(right.mappedFields))
  );
}

function isRateLimitError(cause: unknown): boolean {
  const statusOrCode = isRecord(cause) ? cause.status ?? cause.code : undefined;
  if (statusOrCode === 429 || statusOrCode === '429') {
    return true;
  }

  const message = errorMessage(cause).toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('ratelimit');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
