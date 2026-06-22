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

const DEFAULT_PAGE_SIZE = 500;

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
          const normalized = toReviewRecord(record, query.fieldMapping);
          if (normalized.content.trim()) {
            reviews.push(normalized);
          }
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
      if (name === 'replyContent') {
        mappedFields[name] = null;
        continue;
      }
      throw new BackendAnalysisError(502, 'read_source', `mapped field ${name}(${fieldId}) is missing in record ${record.recordId}`);
    }
    mappedFields[name] = normalizeMappedField(name, record.fields[fieldId], record.recordId);
  }

  const contentValue = mappedFields.content ?? mappedFields.reviewText;
  const content = typeof contentValue === 'string' ? contentValue : '';
  const contentHash = sha256(
    canonicalJson({
      recordId: record.recordId,
      fields: record.fields,
      mappedFields,
      content,
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

function normalizeMappedField(fieldName: string, rawValue: unknown, recordId: string): unknown {
  switch (fieldName) {
    case 'reviewId':
      return cellToText(rawValue) ?? recordId;
    case 'content':
    case 'reviewText':
    case 'hotelName':
    case 'roomType':
      return cellToText(rawValue) ?? '';
    case 'score':
      return cellToNumber(rawValue);
    case 'reviewDate':
      return cellToText(rawValue);
    case 'checkInMonth':
      return cellToFirstText(rawValue);
    case 'replyContent':
      return cellToText(rawValue);
    default:
      return rawValue ?? null;
  }
}

function cellToText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => cellToText(item))
      .filter((item): item is string => item !== null)
      .join('');
    return text || null;
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === 'string') {
      return objectValue.text;
    }
    if (typeof objectValue.name === 'string') {
      return objectValue.name;
    }
  }

  return null;
}

function cellToFirstText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = cellToText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }

  return cellToText(value);
}

function cellToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = cellToText(value);
  if (!text) {
    return null;
  }

  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : null;
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
