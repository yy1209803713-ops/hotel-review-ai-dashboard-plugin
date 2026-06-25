import type { ReviewRecord, ReviewSourceQuery } from './reviewSource';
import { BackendAnalysisError, type JsonValue, type TopicEvidence } from './backendAnalysis';
import { readAiRuntimeConfig, type AiRuntimeEnv } from './aiAnalysisRunner';
import { DEFAULT_CONFIG } from '../src/constants/defaults';
import { filterReviews } from '../src/services/filtering';
import { runAnalysis, type AnalyzeBatchImpl, type MergeTopicsImpl } from '../src/services/analysisPipeline';
import type { AnalysisRunner } from './analysisWorker';
import type { ReviewRecord as PipelineReviewRecord } from '../src/types/analysis';
import type { FieldMapping, FilterState } from '../src/types/config';
import {
  EVIDENCE_CACHE_EXTRACTOR_VERSION,
  resolveAnalysisCacheSourceIdentity,
  type AnalysisCacheRepository,
} from './postgresAnalysisCache';

type FormalAnalysisCacheRuntimeEnv = AiRuntimeEnv;

export type FormalAnalysisCacheRunnerOptions = {
  env?: FormalAnalysisCacheRuntimeEnv;
  analyzeBatchImpl?: AnalyzeBatchImpl;
  mergeTopicsImpl?: MergeTopicsImpl;
  now?: () => string;
  cacheRepository?: AnalysisCacheRepository;
};

export function createFormalAnalysisCacheRunner(options: FormalAnalysisCacheRunnerOptions = {}): AnalysisRunner {
  const env = options.env ?? process.env;
  return {
    async run({ reviews, query, jobId }) {
      const config = readAiRuntimeConfig(env);
      const now = options.now?.() ?? new Date().toISOString();
      const cacheRepository = requireAnalysisCacheRepository(options.cacheRepository);
      const filters = readFilterState(query.filters);
      const cacheIdentity = resolveAnalysisCacheSourceIdentity(query);
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
      const evidenceCache = await cacheRepository.readEvidenceCache({
        ...cacheIdentity,
        model: config.model,
        records: pipelineRecords,
        now,
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
        onBatchFailure: async (failure) => {
          const recordsById = new Map(evidenceCache.misses.map((record) => [record.recordId, record]));
          const failedRecords = failure.recordIds.flatMap((recordId) => {
            const record = recordsById.get(recordId);
            return record ? [record] : [];
          });
          try {
            await cacheRepository.saveEvidenceBatchDiagnostic?.({
              ...cacheIdentity,
              jobId,
              model: config.model,
              extractorVersion: EVIDENCE_CACHE_EXTRACTOR_VERSION,
              batchIndex: failure.batchIndex,
              batchNumber: failure.batchNumber,
              batchCount: failure.batchCount,
              recordIds: failure.recordIds,
              records: failedRecords,
              errorCode: failure.errorCode,
              errorMessage: failure.errorMessage,
              rawContent: readRawContent(failure.details),
              rawLength: readRawLength(failure.details),
              preview: readPreview(failure.details),
              details: failure.details,
              createdAt: now,
            });
          } catch (cause) {
            console.error('__HOTEL_REVIEW_AI_BATCH_DIAGNOSTIC_SAVE_FAILED__', cause);
          }
        },
        readTopicMappingsImpl: async ({ candidates }) => {
          const cache = await cacheRepository.readTopicMappingCache({
            ...cacheIdentity,
            model: config.model,
            candidates,
            now,
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
          await cacheRepository.saveEvidenceCacheEntries({
            ...cacheIdentity,
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
          await cacheRepository.saveTopicMappingCacheEntries({
            ...cacheIdentity,
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

function readFilterState(value: JsonValue | undefined): FilterState {
  const source = isRecord(value) ? value : {};
  return {
    ...DEFAULT_CONFIG.filters,
    ...source,
  } as FilterState;
}

function requireAnalysisCacheRepository(repository: AnalysisCacheRepository | undefined): AnalysisCacheRepository {
  if (!repository) {
    throw new BackendAnalysisError(500, 'read_evidence_cache', 'analysis cache repository is required');
  }
  return repository;
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

function readRawContent(details: unknown): string | undefined {
  return isRecord(details) && typeof details.rawContent === 'string' ? details.rawContent : undefined;
}

function readPreview(details: unknown): string | undefined {
  return isRecord(details) && typeof details.preview === 'string' ? details.preview : undefined;
}

function readRawLength(details: unknown): number | undefined {
  return isRecord(details) && typeof details.rawLength === 'number' ? details.rawLength : undefined;
}
