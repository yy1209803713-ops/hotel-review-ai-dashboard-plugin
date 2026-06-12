import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type {
  ActionItem,
  AnalysisResult,
  BatchAiResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
  TopicMergeResult,
  TopicSummary,
} from '../types/analysis';
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

type SourceTopicMapping = {
  sourceLabel: string;
  sentiment: TopicEvidenceItem['sentiment'];
  mergeKey: string;
  category: string;
  displayTopic: string;
  summary: string;
  acceptedQuotes?: string[];
  action?: string;
};

export type AnalysisBatchTiming = {
  batchIndex: number;
  batchCount: number;
  recordCount: number;
  durationMs: number;
  status: 'success' | 'error';
};

export async function runAnalysis(params: {
  records: ReviewRecord[];
  config: AiConfig;
  filters: FilterState;
  fields: FieldMapping;
  now?: string;
  nowMs?: () => number;
  onBatchTiming?: (timing: AnalysisBatchTiming) => void;
  analyzeBatchImpl?: AnalyzeBatchImpl;
  mergeTopicsImpl?: MergeTopicsImpl;
}): Promise<AnalysisResult> {
  const analyze = params.analyzeBatchImpl ?? ((input) => analyzeBatch(input));
  const mergeTopics =
    params.mergeTopicsImpl ??
    (params.analyzeBatchImpl ? localMergeTopics : ((input) => mergeEvidenceTopics(input)));
  const batches = chunk(params.records, params.config.maxBatchSize);
  const batchResults = await analyzeBatches({
    batches,
    config: params.config,
    analyze,
    concurrency: params.config.batchConcurrency,
    nowMs: params.nowMs,
    onBatchTiming: params.onBatchTiming,
  });

  const validatedEvidence = validateEvidenceItems(batchResults.flatMap(extractEvidenceItems), params.records);
  const candidates = buildMergeCandidates(validatedEvidence);
  const mergeResult = candidates.length
    ? await mergeCandidateTopicsBySentiment({
        config: params.config,
        candidates,
        topN: params.config.topN,
        mergeTopics,
      })
    : { groups: [] };
  debugLog('analysis.merge-result', {
    candidateCount: candidates.length,
    rawGroups: mergeResult.groups.map((group) => ({
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
  const { positiveTopics, negativeTopics } = buildTopicSummaries(validatedEvidence, candidates, mergeResult.groups);

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
}): Promise<BatchAiResult[]> {
  const results: BatchAiResult[] = new Array(params.batches.length);
  const concurrency = normalizeConcurrency(params.concurrency, params.batches.length);
  const nowMs = params.nowMs ?? defaultNowMs;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < params.batches.length) {
      const index = nextIndex;
      nextIndex += 1;
      const batch = params.batches[index];
      const startedAt = nowMs();
      try {
        results[index] = await params.analyze({ config: params.config, records: batch });
        params.onBatchTiming?.({
          batchIndex: index,
          batchCount: params.batches.length,
          recordCount: batch.length,
          durationMs: roundDuration(nowMs() - startedAt),
          status: 'success',
        });
      } catch (cause) {
        params.onBatchTiming?.({
          batchIndex: index,
          batchCount: params.batches.length,
          recordCount: batch.length,
          durationMs: roundDuration(nowMs() - startedAt),
          status: 'error',
        });
        throw new Error(
          `第 ${index + 1}/${params.batches.length} 批 AI 分析失败（${batch.length} 条评论）：${formatBatchError(cause)}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
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

  return [...candidates.values()].map(({ recordIds: _recordIds, ...candidate }) => candidate);
}

async function mergeCandidateTopicsBySentiment(params: {
  config: AiConfig;
  candidates: TopicMergeCandidate[];
  topN: number;
  mergeTopics: MergeTopicsImpl;
}): Promise<TopicMergeResult> {
  const groups: TopicMergeGroup[] = [];
  const sentiments: Array<TopicEvidenceItem['sentiment']> = ['positive', 'negative'];

  for (const sentiment of sentiments) {
    const sentimentCandidates = params.candidates.filter((candidate) => candidate.sentiment === sentiment);
    if (!sentimentCandidates.length) {
      continue;
    }

    const result = await params.mergeTopics({
      config: params.config,
      candidates: sentimentCandidates,
      topN: params.topN,
    });
    groups.push(...result.groups);
  }

  return { groups };
}

function buildTopicSummaries(
  evidenceItems: TopicEvidenceItem[],
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): { positiveTopics: TopicSummary[]; negativeTopics: TopicSummary[] } {
  const mappingBySource = buildMappingBySource(candidates, groups);
  const topics = new Map<string, TopicSummary>();

  for (const item of evidenceItems) {
    const mapping = mappingBySource.get(evidenceKey(item.sentiment, item.aspectLabel)) ?? localMapping(item.aspectLabel, item.sentiment);
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
  const candidatesByKey = new Map(candidates.map((candidate) => [evidenceKey(candidate.sentiment, candidate.sourceLabel), candidate]));

  for (const candidate of candidates) {
    bySource.set(evidenceKey(candidate.sentiment, candidate.sourceLabel), localMapping(candidate.sourceLabel, candidate.sentiment));
  }

  for (const group of groups) {
    const mergeKey = group.mergeKey.trim() || group.members[0]?.sourceLabel || group.displayTopic;
    for (const member of group.members) {
      const key = evidenceKey(group.sentiment, member.sourceLabel);
      const candidate = candidatesByKey.get(key);
      if (!candidate) {
        continue;
      }
      bySource.set(key, {
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

  return bySource;
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
  return {
    mergeKey: sourceLabel,
    sentiment,
    category: sourceLabel,
    displayTopic: sourceLabel,
    summary: `${sourceLabel}相关评论证据。`,
    members: [
      {
        sourceLabel,
        acceptedQuotes: quotes,
      },
    ],
  };
}

function localMapping(sourceLabel: string, sentiment: TopicEvidenceItem['sentiment']): SourceTopicMapping {
  return {
    sourceLabel,
    sentiment,
    mergeKey: sourceLabel,
    category: sourceLabel,
    displayTopic: sourceLabel,
    summary: `${sourceLabel}相关评论证据。`,
  };
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
