import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type {
  ActionItem,
  AnalysisResult,
  BatchAiResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicSentiment,
  TopicMergeCandidate,
  TopicMergeGroup,
  TopicMergeMember,
  TopicMergeResult,
  TopicSummary,
} from '../types/analysis';
import { TOPIC_CATEGORIES } from '../constants/defaults';
import { debugLog } from './debug';
import { analyzeBatch, mergeEvidenceTopics } from './aiClient';
import { calculateOverview } from './stats';

export type AnalyzeBatchImpl = (params: {
  config: AiConfig;
  records: ReviewRecord[];
}) => Promise<BatchAiResult>;

export type MergeTopicsImpl = (params: {
  config: AiConfig;
  candidates: TopicMergeCandidate[];
  topN: number;
}) => Promise<TopicMergeResult>;

export type AnalysisCacheUsage = {
  cachedEvidenceCount: number;
  cachedRecordCount: number;
  analyzedRecordCount: number;
  analyzedRecords: ReviewRecord[];
  newEvidenceItems: TopicEvidenceItem[];
};

export type SourceTopicMapping = {
  sourceLabel: string;
  sentiment: TopicEvidenceItem['sentiment'];
  mergeKey: string;
  category: string;
  displayTopic: string;
  summary: string;
  acceptedQuotes?: string[];
  action?: string;
};

export type TopicMappingUsage = {
  cachedMappingCount: number;
  missedCandidateCount: number;
  newCandidates: TopicMergeCandidate[];
  newGroups: TopicMergeGroup[];
};

export type TopicMappingReadResult = {
  cachedMappings: SourceTopicMapping[];
  cachedCandidates?: TopicMergeCandidate[];
};

export type ReadTopicMappingsImpl = (params: {
  candidates: TopicMergeCandidate[];
}) => Promise<TopicMappingReadResult>;

type TopicMergeStats = {
  candidateCount: number;
  mergeCallCount: number;
  groupCount: number;
};

type TopicMergeWithStats = {
  result: TopicMergeResult;
  stats: TopicMergeStats;
};

class InvalidTopicMergeCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTopicMergeCoverageError';
  }
}

const GENERIC_TOPIC_LABELS = [
  ...TOPIC_CATEGORIES,
  '环境',
  '周边',
  '整体体验',
  '服务质量',
  '服务态度',
  'service',
] as const;

export type AnalysisBatchTiming = {
  batchIndex: number;
  batchCount: number;
  recordCount: number;
  durationMs: number;
  status: 'success' | 'error';
};

export type AnalysisStageTiming = {
  step: 'AI 抽取证据' | 'AI 合并主题' | '本地汇总主题';
  durationMs: number;
  status: 'success' | 'error';
  records?: number;
  detail?: string;
};

export type AnalysisBatchFailureDiagnostic = {
  batchIndex: number;
  batchNumber: number;
  batchCount: number;
  recordCount: number;
  recordIds: string[];
  errorMessage: string;
  errorCode?: string;
  details?: unknown;
};

type AnalysisBatchFailureContext = {
  batchIndex: number;
  batchCount: number;
  records: ReviewRecord[];
  cause: unknown;
};

type AnalysisBatchResult = {
  result: BatchAiResult;
  records: ReviewRecord[];
};

type RunAnalysisParams = {
  records: ReviewRecord[];
  config: AiConfig;
  filters: FilterState;
  fields: FieldMapping;
  now?: string;
  nowMs?: () => number;
  onBatchTiming?: (timing: AnalysisBatchTiming) => void;
  onBatchFailure?: (failure: AnalysisBatchFailureDiagnostic) => void | Promise<void>;
  onStageTiming?: (timing: AnalysisStageTiming) => void;
  cachedEvidenceItems?: TopicEvidenceItem[];
  cacheMissRecords?: ReviewRecord[];
  cachedTopicMappings?: SourceTopicMapping[];
  readTopicMappingsImpl?: ReadTopicMappingsImpl;
  onCacheUsage?: (usage: AnalysisCacheUsage) => void | Promise<void>;
  onTopicMappingUsage?: (usage: TopicMappingUsage) => void | Promise<void>;
  analyzeBatchImpl?: AnalyzeBatchImpl;
  mergeTopicsImpl?: MergeTopicsImpl;
};

export async function runAnalysis(params: RunAnalysisParams): Promise<AnalysisResult> {
  const analyze = params.analyzeBatchImpl ?? ((input) => analyzeBatch(input));
  const mergeTopics =
    params.mergeTopicsImpl ??
    (params.analyzeBatchImpl ? localMergeTopics : ((input) => mergeEvidenceTopics(input)));
  const recordsToAnalyze = params.cacheMissRecords ?? params.records;
  const batches = chunk(recordsToAnalyze, params.config.maxBatchSize);
  const nowMs = params.nowMs ?? defaultNowMs;
  const extractionStartedAt = params.onStageTiming ? nowMs() : 0;
  let newEvidenceItems: TopicEvidenceItem[];
  let analyzedRecords: ReviewRecord[];

  try {
    const batchResults = await analyzeBatches({
      batches,
      config: params.config,
      analyze,
      concurrency: params.config.batchConcurrency,
      nowMs,
      onBatchTiming: params.onBatchTiming,
      onBatchFailure: params.onBatchFailure,
    });

    newEvidenceItems = batchResults.flatMap((item) => extractEvidenceItems(item.result));
    analyzedRecords = batchResults.flatMap((item) => item.records);
    if (params.onStageTiming) {
      params.onStageTiming({
        step: 'AI 抽取证据',
        durationMs: roundDuration(nowMs() - extractionStartedAt),
        status: 'success',
        records: recordsToAnalyze.length,
        detail: `批次 ${batches.length}；新增证据 ${newEvidenceItems.length} 条`,
      });
    }
  } catch (cause) {
    if (params.onStageTiming) {
      params.onStageTiming({
        step: 'AI 抽取证据',
        durationMs: roundDuration(nowMs() - extractionStartedAt),
        status: 'error',
        records: recordsToAnalyze.length,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    throw cause;
  }

  return finishAnalysis({
    params,
    mergeTopics,
    newEvidenceItems,
    analyzedRecords,
    cachedEvidenceItems: params.cachedEvidenceItems ?? [],
    nowMs,
  });
}

async function finishAnalysis(input: {
  params: RunAnalysisParams;
  mergeTopics: MergeTopicsImpl;
  newEvidenceItems: TopicEvidenceItem[];
  analyzedRecords: ReviewRecord[];
  cachedEvidenceItems: TopicEvidenceItem[];
  nowMs: () => number;
}): Promise<AnalysisResult> {
  const { params, mergeTopics, newEvidenceItems, analyzedRecords, cachedEvidenceItems, nowMs } = input;
  const recordsToAnalyze = params.cacheMissRecords ?? params.records;
  await params.onCacheUsage?.({
    cachedEvidenceCount: cachedEvidenceItems.length,
    cachedRecordCount: unique(cachedEvidenceItems.map((item) => item.recordId)).length,
    analyzedRecordCount: analyzedRecords.length,
    analyzedRecords,
    newEvidenceItems,
  });

  const validatedEvidence = validateEvidenceItems([...cachedEvidenceItems, ...newEvidenceItems], params.records);
  const candidates = buildMergeCandidates(validatedEvidence);
  const dynamicTopicMappings = candidates.length && params.readTopicMappingsImpl
    ? await params.readTopicMappingsImpl({ candidates })
    : { cachedMappings: [], cachedCandidates: [] };
  const mergeStartedAt = params.onStageTiming ? nowMs() : 0;
  let mergeOutput: TopicMergeWithStats;
  try {
        mergeOutput = candidates.length
      ? await mergeCandidateTopicsBySentiment({
          config: params.config,
          candidates,
          topN: params.config.topN,
          mergeTopics,
          cachedMappings: [...(params.cachedTopicMappings ?? []), ...dynamicTopicMappings.cachedMappings],
          onTopicMappingUsage: params.onTopicMappingUsage,
        })
      : {
          result: { groups: [] },
          stats: {
            candidateCount: 0,
            mergeCallCount: 0,
            groupCount: 0,
          },
        };
    if (params.onStageTiming) {
      params.onStageTiming({
        step: 'AI 合并主题',
        durationMs: roundDuration(nowMs() - mergeStartedAt),
        status: 'success',
        records: validatedEvidence.length,
        detail:
          `候选主题 ${mergeOutput.stats.candidateCount} 个；AI 调用 ${mergeOutput.stats.mergeCallCount} 次；` +
          `合并主题 ${mergeOutput.stats.groupCount} 个`,
      });
    }
  } catch (cause) {
    if (params.onStageTiming) {
      params.onStageTiming({
        step: 'AI 合并主题',
        durationMs: roundDuration(nowMs() - mergeStartedAt),
        status: 'error',
        records: validatedEvidence.length,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }
    throw cause;
  }
  debugLog('analysis.merge-result', {
    candidateCount: candidates.length,
    rawGroups: mergeOutput.result.groups.map((group) => ({
      mergeKey: group.mergeKey,
      sentiment: group.sentiment,
      category: group.category,
      displayTopic: group.displayTopic,
      summary: group.summary,
      action: group.action,
      members: group.members.map((member) => ({
        sourceLabel: member.sourceLabel,
        acceptedQuotes: member.acceptedQuotes,
      })),
    })),
  });
  const summaryStartedAt = params.onStageTiming ? nowMs() : 0;
  const { positiveTopics, negativeTopics } = buildTopicSummaries(validatedEvidence, candidates, mergeOutput.result.groups);

  const sortedPositive = sortAndLimit(positiveTopics, params.config.topN);
  const sortedNegative = sortAndLimit(negativeTopics, params.config.topN);
  debugLog('analysis.final-topics', {
    positiveTopics: sortedPositive.map(previewTopic),
    negativeTopics: sortedNegative.map(previewTopic),
  });
  const overview = calculateOverview(params.records);
  const positiveReviewIds = idsBySentiment(validatedEvidence, 'positive');
  const negativeReviewIds = idsBySentiment(validatedEvidence, 'negative');
  const mixedReviewIds = intersection(positiveReviewIds, negativeReviewIds);
  const mentionedReviewIds = new Set([...positiveReviewIds, ...negativeReviewIds]);

  overview.positiveReviews = positiveReviewIds.size;
  overview.negativeOrRiskReviews = negativeReviewIds.size;
  overview.mixedReviews = mixedReviewIds.size;
  overview.neutralReviews = Math.max(0, params.records.length - mentionedReviewIds.size);
  if (params.onStageTiming) {
    params.onStageTiming({
      step: '本地汇总主题',
      durationMs: roundDuration(nowMs() - summaryStartedAt),
      status: 'success',
      records: params.records.length,
      detail: `有效证据 ${validatedEvidence.length} 条；好评主题 ${sortedPositive.length} 个；风险主题 ${sortedNegative.length} 个`,
    });
  }

  return {
    analysisId: createAnalysisId(params.now),
    generatedAt: params.now ?? new Date().toISOString(),
    model: params.config.model,
    status: 'complete',
    scope: {
      hotelName: params.filters.hotelName,
      periodType: params.filters.periodType,
      startDate: params.filters.startDate,
      endDate: params.filters.endDate,
    },
    overview,
    positiveTopics: sortedPositive,
    negativeTopics: sortedNegative,
    actionItems: sortedNegative.map((topic, index) => topicToActionItem(topic, index)),
  };
}

async function analyzeBatches(params: {
  batches: ReviewRecord[][];
  config: AiConfig;
  analyze: AnalyzeBatchImpl;
  concurrency?: number;
  nowMs?: () => number;
  onBatchTiming?: (timing: AnalysisBatchTiming) => void;
  onBatchFailure?: (failure: AnalysisBatchFailureDiagnostic) => void | Promise<void>;
}): Promise<AnalysisBatchResult[]> {
  const nowMs = params.nowMs ?? defaultNowMs;
  const batchResults = await runConcurrent(params.batches, params.concurrency, async (batch, index) => {
    const startedAt = nowMs();
    try {
      const result = await params.analyze({ config: params.config, records: batch });
      params.onBatchTiming?.({
        batchIndex: index,
        batchCount: params.batches.length,
        recordCount: batch.length,
        durationMs: roundDuration(nowMs() - startedAt),
        status: 'success',
      });
      return [{ result, records: batch }];
    } catch (cause) {
      params.onBatchTiming?.({
        batchIndex: index,
        batchCount: params.batches.length,
        recordCount: batch.length,
        durationMs: roundDuration(nowMs() - startedAt),
        status: 'error',
      });
      return retryFailedBatchAsSingleRecords({
        batchIndex: index,
        batchCount: params.batches.length,
        records: batch,
        cause,
      }, params);
    }
  });
  return batchResults.flat();
}

async function retryFailedBatchAsSingleRecords(
  context: AnalysisBatchFailureContext,
  params: {
    config: AiConfig;
    analyze: AnalyzeBatchImpl;
    onBatchFailure?: (failure: AnalysisBatchFailureDiagnostic) => void | Promise<void>;
  },
): Promise<AnalysisBatchResult[]> {
  const results: AnalysisBatchResult[] = [];
  for (const record of context.records) {
    try {
      const result = await params.analyze({ config: params.config, records: [record] });
      results.push({ result, records: [record] });
    } catch (cause) {
      logEvidenceBatchFailure({
        batchIndex: context.batchIndex,
        batchCount: context.batchCount,
        recordCount: 1,
        recordIds: [record.recordId],
        cause,
        retryOfRecordCount: context.records.length,
        retryOfErrorMessage: formatBatchError(context.cause),
        retryOfErrorCode: readErrorCode(context.cause),
      });
      await params.onBatchFailure?.({
        batchIndex: context.batchIndex,
        batchNumber: context.batchIndex + 1,
        batchCount: context.batchCount,
        recordCount: 1,
        recordIds: [record.recordId],
        errorMessage: formatBatchError(cause),
        errorCode: readErrorCode(cause),
        details: readErrorDetails(cause),
      });
    }
  }
  return results;
}

function logEvidenceBatchFailure(params: {
  batchIndex: number;
  batchCount: number;
  recordCount: number;
  recordIds: string[];
  cause: unknown;
  retryOfRecordCount?: number;
  retryOfErrorMessage?: string;
  retryOfErrorCode?: string;
}): void {
  console.info('__HOTEL_REVIEW_AI_EVIDENCE_BATCH_FAILED__', JSON.stringify({
    batchIndex: params.batchIndex,
    batchNumber: params.batchIndex + 1,
    batchCount: params.batchCount,
    recordCount: params.recordCount,
    recordIds: params.recordIds,
    errorMessage: formatBatchError(params.cause),
    errorCode: readErrorCode(params.cause),
    details: sanitizeErrorDetailsForLog(readErrorDetails(params.cause)),
    retryOfRecordCount: params.retryOfRecordCount,
    retryOfErrorMessage: params.retryOfErrorMessage,
    retryOfErrorCode: params.retryOfErrorCode,
  }));
}

function sortAndLimit(topics: TopicSummary[], limit: number): TopicSummary[] {
  return topics
    .sort((left, right) => right.count - left.count || left.displayTopic.localeCompare(right.displayTopic))
    .slice(0, limit);
}

function extractEvidenceItems(result: BatchAiResult): TopicEvidenceItem[] {
  if (result.evidenceItems?.length) {
    return result.evidenceItems;
  }

  return [...(result.positiveTopics ?? []), ...(result.negativeTopics ?? [])].flatMap((topic) =>
    topic.commentRecordIds.flatMap((recordId) =>
      topic.evidencePhrases.map((quote) => ({
        recordId,
        quote,
        sentiment: topic.sentiment,
        aspectLabel: topic.displayTopic ?? topic.topic,
        reason: topic.summary,
      })),
    ),
  );
}

function validateEvidenceItems(evidenceItems: TopicEvidenceItem[], records: ReviewRecord[]): TopicEvidenceItem[] {
  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const seen = new Set<string>();
  const validated: TopicEvidenceItem[] = [];

  for (const item of evidenceItems) {
    const record = recordsById.get(item.recordId);
    const quote = item.quote.trim();
    const aspectLabel = item.aspectLabel.trim();
    if (!record || !quote || !aspectLabel || !quoteExistsInContent(record.content, quote)) {
      continue;
    }

    const key = `${item.recordId}|${item.sentiment}|${normalizeTopic(aspectLabel)}|${normalizeQuote(quote)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    validated.push({
      recordId: item.recordId,
      quote,
      sentiment: item.sentiment,
      aspectLabel,
      reason: item.reason?.trim() || undefined,
    });
  }

  return validated;
}

function buildMergeCandidates(evidenceItems: TopicEvidenceItem[]): TopicMergeCandidate[] {
  const candidates = new Map<string, TopicMergeCandidate & { recordIds: string[] }>();

  for (const item of evidenceItems) {
    const key = evidenceKey(item.sentiment, item.aspectLabel);
    const current = candidates.get(key);
    if (!current) {
      candidates.set(key, {
        sourceLabel: item.aspectLabel,
        sentiment: item.sentiment,
        count: 1,
        quotes: [item.quote],
        recordIds: [item.recordId],
      });
      continue;
    }

    current.recordIds = unique([...current.recordIds, item.recordId]);
    current.count = current.recordIds.length;
    current.quotes = unique([...current.quotes, item.quote]).slice(0, 8);
  }

  return [...candidates.values()].map(({ recordIds: _recordIds, ...candidate }, index) => ({
    ...candidate,
    id: createCandidateId(index),
  }));
}

async function mergeCandidateTopicsBySentiment(params: {
  config: AiConfig;
  candidates: TopicMergeCandidate[];
  topN: number;
  mergeTopics: MergeTopicsImpl;
  cachedMappings: SourceTopicMapping[];
  onTopicMappingUsage?: (usage: TopicMappingUsage) => void | Promise<void>;
}): Promise<TopicMergeWithStats> {
  const cachedGroups = groupsFromCachedMappings(params.candidates, params.cachedMappings);
  const cachedKeys = new Set(
    cachedGroups.flatMap((group) =>
      group.members.map((member) => memberCoverageKey(group.sentiment, member)),
    ),
  );
  const missedCandidates = params.candidates.filter((candidate) => !isCandidateCovered(candidate, cachedKeys));
  const groups: TopicMergeGroup[] = [...cachedGroups];
  const newGroups: TopicMergeGroup[] = [];
  const mergeInputs = splitCandidatesBySentiment(missedCandidates);

  if (mergeInputs.length) {
    const mergedGroups = await Promise.all(mergeInputs.map(async (candidates) => {
      const result = await params.mergeTopics({
        config: params.config,
        candidates,
        topN: params.topN,
      });
      ensureMergeResultCoversCandidates(candidates, result.groups, describeTopicMergeContext(candidates));
      return hydrateAcceptedQuotes(candidates, result.groups);
    }));

    for (const hydratedGroups of mergedGroups) {
      newGroups.push(...hydratedGroups);
      groups.push(...hydratedGroups);
    }
  }

  await params.onTopicMappingUsage?.({
    cachedMappingCount: params.candidates.length - missedCandidates.length,
    missedCandidateCount: missedCandidates.length,
    newCandidates: missedCandidates,
    newGroups,
  });

  return {
    result: { groups },
    stats: {
      candidateCount: params.candidates.length,
      mergeCallCount: mergeInputs.length,
      groupCount: groups.length,
    },
  };
}

function splitCandidatesBySentiment(candidates: TopicMergeCandidate[]): TopicMergeCandidate[][] {
  return (['positive', 'negative'] as const)
    .map((sentiment) => candidates.filter((candidate) => candidate.sentiment === sentiment))
    .filter((sentimentCandidates) => sentimentCandidates.length);
}

function describeTopicMergeContext(candidates: TopicMergeCandidate[]): string {
  const sentiments = unique(candidates.map((candidate) => candidate.sentiment));
  if (sentiments.length === 1 && sentiments[0] === 'positive') {
    return '好评主题合并';
  }
  if (sentiments.length === 1 && sentiments[0] === 'negative') {
    return '风险主题合并';
  }
  return 'AI 主题合并';
}

function groupsFromCachedMappings(
  candidates: TopicMergeCandidate[],
  mappings: SourceTopicMapping[],
): TopicMergeGroup[] {
  if (!mappings.length) {
    return [];
  }
  const mappingsByKey = new Map(mappings.map((mapping) => [evidenceKey(mapping.sentiment, mapping.sourceLabel), mapping]));
  const groups = new Map<string, TopicMergeGroup>();

  for (const candidate of candidates) {
    const mapping = mappingsByKey.get(evidenceKey(candidate.sentiment, candidate.sourceLabel));
    if (!mapping) {
      continue;
    }
    const groupKey = evidenceKey(mapping.sentiment, mapping.mergeKey);
    const current = groups.get(groupKey);
    const member: TopicMergeMember = {
      candidateId: candidate.id,
      sourceLabel: candidate.sourceLabel,
      acceptedQuotes: mapping.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
    };
    if (!current) {
      groups.set(groupKey, {
        mergeKey: mapping.mergeKey,
        sentiment: mapping.sentiment,
        category: mapping.category,
        displayTopic: mapping.displayTopic,
        summary: mapping.summary,
        action: mapping.action,
        members: [member],
      });
      continue;
    }

    current.members.push(member);
    if (mapping.summary.length > current.summary.length) {
      current.summary = mapping.summary;
    }
    current.action = current.action || mapping.action;
  }

  return [...groups.values()];
}

function hydrateAcceptedQuotes(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): TopicMergeGroup[] {
  const candidatesByKey = buildCandidateLookup(candidates, (candidate) => candidate);
  return groups.map((group) => ({
    ...group,
    members: group.members.map((member) => {
      if (member.acceptedQuotes !== undefined) {
        return member;
      }
      const candidate = candidatesByKey.get(memberCoverageKey(group.sentiment, member));
      return {
        ...member,
        acceptedQuotes: candidate?.quotes ?? [],
      };
    }),
  }));
}

function createCandidateId(index: number): string {
  return `c${String(index + 1).padStart(3, '0')}`;
}

function buildTopicSummaries(
  evidenceItems: TopicEvidenceItem[],
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): { positiveTopics: TopicSummary[]; negativeTopics: TopicSummary[] } {
  const mappingBySource = buildMappingBySource(candidates, groups);
  const topics = new Map<string, TopicSummary>();

  for (const item of evidenceItems) {
    const key = evidenceKey(item.sentiment, item.aspectLabel);
    const mapping = mappingBySource.get(key);
    if (!mapping) {
      throw new Error(`AI 主题归并缺少候选映射：${key}`);
    }
    if (!isQuoteAccepted(mapping, item.quote)) {
      continue;
    }
    const topicKey = evidenceKey(item.sentiment, mapping.mergeKey);
    const current = topics.get(topicKey);
    if (!current) {
      topics.set(topicKey, {
        mergeKey: mapping.mergeKey,
        topic: mapping.displayTopic,
        displayTopic: mapping.displayTopic,
        category: mapping.category,
        count: 0,
        sentiment: item.sentiment,
        commentRecordIds: [item.recordId],
        evidencePhrases: [item.quote],
        evidenceItems: [item],
        summary: mapping.summary,
        action: mapping.action,
      });
      continue;
    }

    current.commentRecordIds = unique([...current.commentRecordIds, item.recordId]);
    current.evidencePhrases = unique([...current.evidencePhrases, item.quote]);
    current.evidenceItems = [...(current.evidenceItems ?? []), item];
    if (mapping.summary.length > current.summary.length) {
      current.summary = mapping.summary;
    }
    current.action = current.action || mapping.action;
    current.topic = current.displayTopic;
  }

  const values = [...topics.values()].map((topic) => ({
    ...topic,
    count: unique(topic.commentRecordIds).length,
    evidencePhrases: topic.evidencePhrases.slice(0, 12),
  }));

  return {
    positiveTopics: values.filter((topic) => topic.sentiment === 'positive'),
    negativeTopics: values.filter((topic) => topic.sentiment === 'negative'),
  };
}

function buildMappingBySource(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): Map<string, SourceTopicMapping> {
  const bySource = new Map<string, SourceTopicMapping>();
  const candidatesByKey = buildCandidateLookup(candidates, (candidate) => candidate);
  const coveredCandidateKeys = new Set<string>();

  for (const group of groups) {
    validateDisplayTopic(group);
    const mergeKey = group.mergeKey.trim() || group.members[0]?.sourceLabel || group.displayTopic;
    for (const member of group.members) {
      const key = memberCoverageKey(group.sentiment, member);
      const candidate = candidatesByKey.get(key);
      if (!candidate) {
        throw new Error(`AI 主题归并返回了未知候选标签：${describeMemberKey(group.sentiment, member)}`);
      }
      const canonicalKey = candidateCoverageKey(candidate);
      if (coveredCandidateKeys.has(canonicalKey)) {
        throw new Error(`AI 主题归并重复覆盖候选标签：${describeCandidateCoverageKey(candidate)}`);
      }
      coveredCandidateKeys.add(canonicalKey);
      bySource.set(evidenceKey(candidate.sentiment, candidate.sourceLabel), {
        sourceLabel: candidate.sourceLabel,
        sentiment: group.sentiment,
        mergeKey,
        category: group.category.trim() || candidate.sourceLabel,
        displayTopic: group.displayTopic.trim() || candidate.sourceLabel,
        summary: group.summary.trim() || `${group.displayTopic || mergeKey || candidate.sourceLabel}相关评论证据。`,
        acceptedQuotes: member.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
        action: group.action?.trim() || undefined,
      });
    }
  }

  const missing = candidates
    .filter((candidate) => !coveredCandidateKeys.has(candidateCoverageKey(candidate)))
    .map(candidateCoverageKey);
  if (missing.length) {
    throw new Error(`AI 主题归并漏掉候选标签：${missing.map((key) => describeCandidateByCoverageKey(key, candidates)).join('、')}`);
  }

  return bySource;
}

function ensureMergeResultCoversCandidates(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
  context: string,
): void {
  const candidateKeys = new Set(candidates.flatMap(candidateCoverageKeys));
  const candidatesByKey = buildCandidateLookup(candidates, (candidate) => candidate);
  const coveredKeys = new Set<string>();
  const unknownMemberKeys: string[] = [];
  const duplicateMemberKeys: string[] = [];
  const sentimentMismatchKeys: string[] = [];
  for (const group of groups) {
    for (const member of group.members) {
      const key = memberCoverageKey(group.sentiment, member);
      const candidate = candidatesByKey.get(key);
      if (!candidate || !candidateKeys.has(key)) {
        unknownMemberKeys.push(describeMemberKey(group.sentiment, member));
        continue;
      }
      const canonicalKey = candidateCoverageKey(candidate);
      if (coveredKeys.has(canonicalKey)) {
        duplicateMemberKeys.push(describeCandidateCoverageKey(candidate));
        continue;
      }
      if (candidate.sentiment !== group.sentiment) {
        sentimentMismatchKeys.push(describeSentimentMismatch(candidate, group.sentiment));
        continue;
      }
      coveredKeys.add(canonicalKey);
    }
  }
  const missingCandidateKeys = candidates
    .filter((candidate) => !coveredKeys.has(candidateCoverageKey(candidate)))
    .map(describeCandidateKey);
  if (unknownMemberKeys.length || duplicateMemberKeys.length || sentimentMismatchKeys.length || missingCandidateKeys.length) {
    logInvalidTopicMergeResult({
      context,
      candidates,
      groups,
      unknownMemberKeys,
      duplicateMemberKeys,
      sentimentMismatchKeys,
      missingCandidateKeys,
    });
  }
  if (unknownMemberKeys.length) {
    throw new InvalidTopicMergeCoverageError(
      `${context}结果无效：AI 主题归并返回了未知候选标签：${unique(unknownMemberKeys).join('、')}`,
    );
  }
  if (duplicateMemberKeys.length) {
    throw new InvalidTopicMergeCoverageError(
      `${context}结果无效：AI 主题归并重复覆盖候选标签：${unique(duplicateMemberKeys).join('、')}`,
    );
  }
  if (sentimentMismatchKeys.length) {
    throw new InvalidTopicMergeCoverageError(
      `${context}结果无效：AI 主题归并把候选放入了相反情绪分组：${unique(sentimentMismatchKeys).join('、')}`,
    );
  }
  if (missingCandidateKeys.length) {
    throw new InvalidTopicMergeCoverageError(
      `${context}结果无效：AI 主题归并漏掉候选标签：${missingCandidateKeys.join('、')}`,
    );
  }
}

function logInvalidTopicMergeResult(params: {
  context: string;
  candidates: TopicMergeCandidate[];
  groups: TopicMergeGroup[];
  unknownMemberKeys: string[];
  duplicateMemberKeys: string[];
  sentimentMismatchKeys: string[];
  missingCandidateKeys: string[];
}): void {
  console.info('__HOTEL_REVIEW_AI_TOPIC_MERGE_INVALID__', JSON.stringify({
    context: params.context,
    candidateCount: params.candidates.length,
    groupCount: params.groups.length,
    unknownMemberKeys: unique(params.unknownMemberKeys),
    duplicateMemberKeys: unique(params.duplicateMemberKeys),
    sentimentMismatchKeys: unique(params.sentimentMismatchKeys),
    missingCandidateKeys: unique(params.missingCandidateKeys),
    candidates: params.candidates.map((candidate) => ({
      key: evidenceKey(candidate.sentiment, candidate.sourceLabel),
      id: candidate.id,
      sourceLabel: candidate.sourceLabel,
      sentiment: candidate.sentiment,
      count: candidate.count,
      quotes: candidate.quotes.slice(0, 5),
    })),
    groups: params.groups.map((group) => ({
      mergeKey: group.mergeKey,
      sentiment: group.sentiment,
      category: group.category,
      displayTopic: group.displayTopic,
      members: group.members.map((member) => ({
        key: describeMemberKey(group.sentiment, member),
        candidateId: member.candidateId,
        sourceLabel: member.sourceLabel,
        acceptedQuotes: member.acceptedQuotes?.slice(0, 5),
      })),
    })),
  }));
}

async function localMergeTopics(params: {
  candidates: TopicMergeCandidate[];
}): Promise<TopicMergeResult> {
  return {
    groups: params.candidates.map((candidate) => localGroup(candidate.sourceLabel, candidate.sentiment, candidate.quotes)),
  };
}

function localGroup(
  sourceLabel: string,
  sentiment: TopicEvidenceItem['sentiment'],
  quotes: string[],
): TopicMergeGroup {
  const category = inferLocalCategory(sourceLabel);
  return {
    mergeKey: sourceLabel,
    sentiment,
    category,
    displayTopic: `${sourceLabel}相关体验`,
    summary: `${sourceLabel}相关评论证据。`,
    members: [
      {
        sourceLabel,
        acceptedQuotes: quotes,
      },
    ],
  };
}

function inferLocalCategory(sourceLabel: string): string {
  if (/位置|地理|周边|交通|出行/.test(sourceLabel)) {
    return '位置';
  }
  if (/服务|员工|前台|响应/.test(sourceLabel)) {
    return '服务';
  }
  if (/卫生|清洁|毛巾|干净/.test(sourceLabel)) {
    return '卫生';
  }
  if (/设施|隔音|噪音|空调|电梯|停车/.test(sourceLabel)) {
    return '设施';
  }
  if (/早餐|餐饮|口味|菜品/.test(sourceLabel)) {
    return '餐饮';
  }
  return '其他';
}

function validateDisplayTopic(group: TopicMergeGroup): void {
  const displayTopic = group.displayTopic.trim();
  const category = group.category.trim();
  if (!displayTopic) {
    throw new Error('AI 主题归并返回了空 displayTopic');
  }
  if (isGenericTopicLabel(displayTopic, category)) {
    throw new Error(`displayTopic 不能使用上位类目“${displayTopic}”`);
  }
  if (displayTopic.length < 4) {
    throw new Error(`displayTopic 过于笼统，不能使用“${displayTopic}”`);
  }
  if (!/[\u4e00-\u9fa5]/.test(displayTopic)) {
    throw new Error(`displayTopic 必须是中文口语短句，不能使用“${displayTopic}”`);
  }
}

function isGenericTopicLabel(displayTopic: string, category: string): boolean {
  const normalizedTopic = normalizeTopic(displayTopic);
  if (normalizedTopic === normalizeTopic(category)) {
    return true;
  }
  return GENERIC_TOPIC_LABELS.some((label) => normalizedTopic === normalizeTopic(label));
}

function isQuoteAccepted(mapping: SourceTopicMapping, quote: string): boolean {
  if (mapping.acceptedQuotes === undefined) {
    return true;
  }
  if (!mapping.acceptedQuotes.length) {
    return false;
  }
  const normalizedQuote = normalizeQuote(quote);
  return mapping.acceptedQuotes.some((acceptedQuote) => normalizeQuote(acceptedQuote) === normalizedQuote);
}

function idsBySentiment(evidenceItems: TopicEvidenceItem[], sentiment: TopicEvidenceItem['sentiment']): Set<string> {
  return new Set(evidenceItems.filter((item) => item.sentiment === sentiment).map((item) => item.recordId));
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  return new Set([...left].filter((item) => right.has(item)));
}

function evidenceKey(sentiment: TopicEvidenceItem['sentiment'], label: string): string {
  return `${sentiment}|${normalizeTopic(label)}`;
}

function candidateCoverageKey(candidate: TopicMergeCandidate): string {
  return candidate.id?.trim() ? `id|${candidate.id.trim()}` : evidenceKey(candidate.sentiment, candidate.sourceLabel);
}

function candidateCoverageKeys(candidate: TopicMergeCandidate): string[] {
  return unique([
    candidate.id?.trim() ? `id|${candidate.id.trim()}` : '',
    evidenceKey(candidate.sentiment, candidate.sourceLabel),
  ]);
}

function memberCoverageKey(sentiment: TopicSentiment, member: TopicMergeMember): string {
  return member.candidateId?.trim() ? `id|${member.candidateId.trim()}` : evidenceKey(sentiment, member.sourceLabel);
}

function buildCandidateLookup<TValue>(
  candidates: TopicMergeCandidate[],
  getValue: (candidate: TopicMergeCandidate, index: number) => TValue,
): Map<string, TValue> {
  const lookup = new Map<string, TValue>();
  candidates.forEach((candidate, index) => {
    const value = getValue(candidate, index);
    for (const key of candidateCoverageKeys(candidate)) {
      lookup.set(key, value);
    }
  });
  return lookup;
}

function isCandidateCovered(candidate: TopicMergeCandidate, coveredKeys: Set<string>): boolean {
  return candidateCoverageKeys(candidate).some((key) => coveredKeys.has(key));
}

function describeMemberKey(sentiment: TopicSentiment, member: TopicMergeMember): string {
  return member.candidateId?.trim() ? `id|${member.candidateId.trim()}` : evidenceKey(sentiment, member.sourceLabel);
}

function describeCandidateKey(candidate: TopicMergeCandidate): string {
  return evidenceKey(candidate.sentiment, candidate.sourceLabel);
}

function describeCandidateCoverageKey(candidate: TopicMergeCandidate): string {
  return candidate.id?.trim() ? `id|${candidate.id.trim()}` : describeCandidateKey(candidate);
}

function describeSentimentMismatch(candidate: TopicMergeCandidate, groupSentiment: TopicSentiment): string {
  return `${describeCandidateKey(candidate)} -> ${groupSentiment}`;
}

function describeCandidateByCoverageKey(key: string, candidates: TopicMergeCandidate[]): string {
  const candidate = candidates.find((item) => candidateCoverageKey(item) === key);
  return candidate ? describeCandidateKey(candidate) : key;
}

function quoteExistsInContent(content: string, quote: string): boolean {
  if (content.includes(quote)) {
    return true;
  }
  return normalizeQuote(content).includes(normalizeQuote(quote));
}

function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function topicToActionItem(topic: TopicSummary, index: number): ActionItem {
  return {
    id: `action-${index + 1}`,
    title: `优先处理：${topic.displayTopic}`,
    description: topic.action || topic.summary || `围绕${topic.displayTopic}制定整改动作，并在评论回复中说明进展。`,
    impactCount: topic.count,
    topic: topic.displayTopic,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, size);
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    batches.push(items.slice(index, index + safeSize));
  }
  return batches;
}

async function runConcurrent<TInput, TOutput>(
  items: TInput[],
  concurrencyValue: number | undefined,
  task: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  const concurrency = normalizeConcurrency(concurrencyValue, items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function normalizeConcurrency(value: number | undefined, batchCount: number): number {
  const numericValue = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.max(1, Math.min(batchCount || 1, numericValue));
}

function defaultNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundDuration(durationMs: number): number {
  return Math.round(durationMs);
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatBatchError(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'AI API 请求失败';
}

function readErrorCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;
}

function readErrorDetails(cause: unknown): unknown {
  return typeof cause === 'object' && cause !== null && 'details' in cause ? cause.details : undefined;
}

function sanitizeErrorDetailsForLog(details: unknown): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return details;
  }
  const { rawContent, ...rest } = details as Record<string, unknown>;
  return rest;
}

function createAnalysisId(now?: string): string {
  const prefix = now ? now.replace(/[^0-9]/g, '').slice(0, 14) : Date.now().toString();
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `analysis-${prefix}-${random}`;
}

function previewTopic(topic: TopicSummary): Record<string, unknown> {
  return {
    mergeKey: topic.mergeKey,
    topic: topic.topic,
    displayTopic: topic.displayTopic,
    category: topic.category,
    count: topic.count,
    sentiment: topic.sentiment,
    evidencePhrases: topic.evidencePhrases.slice(0, 3),
    commentRecordIds: topic.commentRecordIds.slice(0, 3),
  };
}
