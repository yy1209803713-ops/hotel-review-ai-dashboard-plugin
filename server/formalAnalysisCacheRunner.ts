import type { DashboardRuntime } from '../src/runtime/sdk';
import type { ReviewRecord, ReviewSourceQuery } from './reviewSource';
import { BackendAnalysisError, type JsonValue, type TopicEvidence } from './backendAnalysis';
import { readAiRuntimeConfig, type AiRuntimeEnv } from './aiAnalysisRunner';
import { createLarkOpenApiRuntime } from './larkOpenApiRuntime';
import { requireFeishuBaseAuthCode, type FeishuBaseRuntimeEnv } from './feishuBaseRuntimeConfig';
import { DEFAULT_CONFIG } from '../src/constants/defaults';
import { filterReviews } from '../src/services/filtering';
import { readEvidenceCache, saveEvidenceCacheEntries } from '../src/services/evidenceCache';
import {
  readTopicMappingCache,
  saveTopicMappingCacheEntries,
} from '../src/services/topicMappingCache';
import { runAnalysis, type AnalyzeBatchImpl, type MergeTopicsImpl } from '../src/services/analysisPipeline';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord as PipelineReviewRecord } from '../src/types/analysis';
import type { FieldMapping, FilterState } from '../src/types/config';

type FormalAnalysisCacheRuntimeEnv = AiRuntimeEnv & FeishuBaseRuntimeEnv;

export type FormalAnalysisCacheRunnerOptions = {
  env?: FormalAnalysisCacheRuntimeEnv;
  analyzeBatchImpl?: AnalyzeBatchImpl;
  mergeTopicsImpl?: MergeTopicsImpl;
  now?: () => string;
  createRuntime?: typeof createLarkOpenApiRuntime;
  readEvidenceCacheImpl?: typeof readEvidenceCache;
  saveEvidenceCacheEntriesImpl?: typeof saveEvidenceCacheEntries;
  readTopicMappingCacheImpl?: typeof readTopicMappingCache;
  saveTopicMappingCacheEntriesImpl?: typeof saveTopicMappingCacheEntries;
};

export function createFormalAnalysisCacheRunner(options: FormalAnalysisCacheRunnerOptions = {}): AnalysisRunner {
  const env = options.env ?? process.env;
  const createRuntime = options.createRuntime ?? createLarkOpenApiRuntime;
  return {
    async run({ reviews, query }) {
      const config = readAiRuntimeConfig(env);
      const now = options.now?.() ?? new Date().toISOString();
      const filters = readFilterState(query.filters);
      const runtime = createFormalCacheRuntime(query, env, createRuntime);
      const reviewRecords = reviews.map(toPipelineReviewRecord);
      const filteredReviews = filterReviews(reviewRecords, filters);
      console.info(
        '__HOTEL_REVIEW_AI_FORMAL_FILTER__',
        JSON.stringify({
          tableId: query.tableId ?? null,
          viewId: query.viewId ?? null,
          rawReviewCount: reviews.length,
          filteredReviewCount: filteredReviews.length,
          filters,
        }),
      );
      const pipelineRecords = filteredReviews;
      const evidenceCache = await (options.readEvidenceCacheImpl ?? readEvidenceCache)(runtime, {
        tableId: requireTableId(query),
        model: config.model,
        records: pipelineRecords,
      });
      console.info(
        '__HOTEL_REVIEW_AI_FORMAL_CACHE_READ__',
        JSON.stringify({
          tableId: query.tableId ?? null,
          filteredReviewCount: filteredReviews.length,
          evidenceCacheHits: evidenceCache.hits.length,
          evidenceCacheMisses: evidenceCache.misses.length,
          cachedEvidenceItemCount: evidenceCache.hits.reduce((sum, hit) => sum + hit.evidenceItems.length, 0),
        }),
      );
      const result = await runAnalysis({
        records: pipelineRecords,
        config,
        filters,
        fields: readFieldMapping(query.fieldMapping),
        now,
        analyzeBatchImpl: options.analyzeBatchImpl,
        mergeTopicsImpl: options.mergeTopicsImpl,
        cachedEvidenceItems: evidenceCache.hits.flatMap((hit) => hit.evidenceItems),
        cacheMissRecords: evidenceCache.misses,
        readTopicMappingsImpl: async ({ candidates }) => {
          const cache = await (options.readTopicMappingCacheImpl ?? readTopicMappingCache)(runtime, {
            tableId: requireTableId(query),
            model: config.model,
            candidates,
          });
          return {
            cachedMappings: cache.hits.map((hit) => hit.mapping),
            cachedCandidates: cache.hits.map((hit) => hit.candidate),
          };
        },
        onCacheUsage: async (usage) => {
          if (!evidenceCache.misses.length || !filteredReviews.length) {
            return;
          }
          await (options.saveEvidenceCacheEntriesImpl ?? saveEvidenceCacheEntries)(runtime, {
            tableId: requireTableId(query),
            model: config.model,
            records: evidenceCache.misses,
            evidenceItems: usage.newEvidenceItems,
            now,
          });
        },
        onTopicMappingUsage: async (usage) => {
          if (!usage.newCandidates.length || !usage.newGroups.length) {
            return;
          }
          await (options.saveTopicMappingCacheEntriesImpl ?? saveTopicMappingCacheEntries)(runtime, {
            tableId: requireTableId(query),
            model: config.model,
            candidates: usage.newCandidates,
            groups: usage.newGroups,
            now,
          });
        },
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

function createFormalCacheRuntime(
  query: ReviewSourceQuery,
  env: FormalAnalysisCacheRuntimeEnv,
  createRuntime: typeof createLarkOpenApiRuntime,
): DashboardRuntime {
  return createRuntime({
    baseToken: requireBaseToken(query),
    authCode: requireFeishuBaseAuthCode(env, 'read_evidence_cache', 'formal analysis cache runner'),
  }) as unknown as DashboardRuntime;
}

function readFilterState(value: JsonValue | undefined): FilterState {
  const source = isRecord(value) ? value : {};
  return {
    ...DEFAULT_CONFIG.filters,
    ...source,
  } as FilterState;
}

function requireBaseToken(query: ReviewSourceQuery): string {
  if (!query.baseToken?.trim()) {
    throw new BackendAnalysisError(400, 'resolve_source', 'baseToken is required for analysis cache runtime');
  }
  return query.baseToken;
}

function requireTableId(query: ReviewSourceQuery): string {
  if (!query.tableId?.trim()) {
    throw new BackendAnalysisError(400, 'resolve_source', 'tableId is required for analysis cache runtime');
  }
  return query.tableId;
}

function readFieldMapping(value: Record<string, string>): FieldMapping {
  return {
    ...DEFAULT_CONFIG.source.fields,
    ...value,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
