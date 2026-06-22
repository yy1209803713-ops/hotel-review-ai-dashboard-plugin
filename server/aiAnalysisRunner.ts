import { BackendAnalysisError, type JsonValue, type TopicEvidence } from './backendAnalysis';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord, ReviewSourceQuery } from './reviewSource';
import { DEFAULT_CONFIG } from '../src/constants/defaults';
import { runAnalysis, type AnalyzeBatchImpl, type MergeTopicsImpl } from '../src/services/analysisPipeline';
import type { ReviewRecord as PipelineReviewRecord } from '../src/types/analysis';
import type { AiConfig, FieldMapping, FilterState } from '../src/types/config';

export type AiRuntimeEnv = {
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_TEMPERATURE?: string;
  AI_MAX_BATCH_SIZE?: string;
  AI_BATCH_CONCURRENCY?: string;
  AI_REQUEST_TIMEOUT_SECONDS?: string;
  AI_TOP_N?: string;
};

export type AiRuntimeConfig = AiConfig;

export type AiAnalysisRunnerOptions = {
  env?: AiRuntimeEnv;
  analyzeBatchImpl?: AnalyzeBatchImpl;
  mergeTopicsImpl?: MergeTopicsImpl;
  now?: () => string;
};

export function createAiAnalysisRunner(options: AiAnalysisRunnerOptions = {}): AnalysisRunner {
  return {
    async run({ reviews, query }) {
      const config = readAiRuntimeConfig(options.env ?? process.env);
      const now = options.now?.() ?? new Date().toISOString();
      const result = await runAnalysis({
        records: reviews.map(toPipelineReviewRecord),
        config,
        filters: readFilterState(query.filters),
        fields: readFieldMapping(query.fieldMapping),
        now,
        analyzeBatchImpl: options.analyzeBatchImpl,
        mergeTopicsImpl: options.mergeTopicsImpl,
      });

      return {
        summary: result as unknown as JsonValue,
        topics: [...result.positiveTopics, ...result.negativeTopics] as unknown as JsonValue[],
        evidenceByTopic: Object.fromEntries(
          [...result.positiveTopics, ...result.negativeTopics].map((topic) => [
            topic.mergeKey,
            (topic.evidenceItems ?? []).map((item, index) => ({
              evidenceId: `${topic.mergeKey}-${item.recordId}-${index + 1}`,
              recordId: item.recordId,
              quote: item.quote,
              sentiment: item.sentiment,
              aspectLabel: item.aspectLabel,
              reason: item.reason,
            } satisfies TopicEvidence)),
          ]),
        ),
      };
    },
  };
}

export function readAiRuntimeConfig(env: AiRuntimeEnv): AiRuntimeConfig {
  const apiBaseUrl = env.AI_BASE_URL?.trim() ?? '';
  const apiKey = env.AI_API_KEY?.trim() ?? '';
  const model = env.AI_MODEL?.trim() ?? '';

  if (!apiBaseUrl) {
    throw new BackendAnalysisError(500, 'extract_evidence', 'AI_BASE_URL is required for backend analysis');
  }
  if (!apiKey) {
    throw new BackendAnalysisError(500, 'extract_evidence', 'AI_API_KEY is required for backend analysis');
  }
  if (!model) {
    throw new BackendAnalysisError(500, 'extract_evidence', 'AI_MODEL is required for backend analysis');
  }

  return {
    ...DEFAULT_CONFIG.ai,
    apiBaseUrl,
    apiKey,
    model,
    temperature: readOptionalNumber(env.AI_TEMPERATURE, DEFAULT_CONFIG.ai.temperature, 'AI_TEMPERATURE'),
    maxBatchSize: readOptionalInteger(env.AI_MAX_BATCH_SIZE, DEFAULT_CONFIG.ai.maxBatchSize, 'AI_MAX_BATCH_SIZE'),
    batchConcurrency: readOptionalInteger(env.AI_BATCH_CONCURRENCY, DEFAULT_CONFIG.ai.batchConcurrency ?? 1, 'AI_BATCH_CONCURRENCY'),
    requestTimeoutSeconds: readOptionalInteger(
      env.AI_REQUEST_TIMEOUT_SECONDS,
      DEFAULT_CONFIG.ai.requestTimeoutSeconds ?? 600,
      'AI_REQUEST_TIMEOUT_SECONDS',
    ),
    topN: readOptionalInteger(env.AI_TOP_N, DEFAULT_CONFIG.ai.topN, 'AI_TOP_N'),
  };
}

function toPipelineReviewRecord(review: ReviewRecord): PipelineReviewRecord {
  return {
    recordId: review.recordId,
    reviewId: stringValue(review.mappedFields.reviewId, review.recordId),
    hotelName: stringValue(review.mappedFields.hotelName, ''),
    score: numberOrNull(review.mappedFields.score ?? review.mappedFields.rating),
    reviewDate: nullableString(review.mappedFields.reviewDate),
    checkInMonth: nullableString(review.mappedFields.checkInMonth),
    roomType: nullableString(review.mappedFields.roomType),
    hasReply: Boolean(nullableString(review.mappedFields.replyContent)),
    replyContent: nullableString(review.mappedFields.replyContent),
    content: review.content ?? stringValue(review.mappedFields.content ?? review.mappedFields.reviewText, ''),
  };
}

function readFilterState(value: JsonValue | undefined): FilterState {
  const source = isRecord(value) ? value : {};
  return {
    ...DEFAULT_CONFIG.filters,
    ...source,
  } as FilterState;
}

function readFieldMapping(value: Record<string, string>): FieldMapping {
  return {
    ...DEFAULT_CONFIG.source.fields,
    ...value,
  };
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readOptionalNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BackendAnalysisError(500, 'validate_request', `${name} must be a number`);
  }
  return parsed;
}

function readOptionalInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = readOptionalNumber(value, fallback, name);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BackendAnalysisError(500, 'validate_request', `${name} must be a positive integer`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
