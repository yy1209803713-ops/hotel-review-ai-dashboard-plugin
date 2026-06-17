// @vitest-environment node

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/constants/defaults';
import { FIXTURE_SOURCE_CONFIG } from '../src/fixtures/dashboardSource';
import { normalizeReviewRecord } from '../src/services/baseRecords';
import { csvTextToRawReviewRecords } from '../src/services/csvRecords';
import { filterReviews } from '../src/services/filtering';
import { runAnalysis } from '../src/services/analysisPipeline';
import type {
  AnalysisBatchTiming,
  AnalysisStageTiming,
  SourceTopicMapping,
  TopicMappingUsage,
} from '../src/services/analysisPipeline';
import type { TopicEvidenceItem } from '../src/types/analysis';

const CSV_PATH = '/Users/yxk/Downloads/hotel_xx_comments_25_merged_with_names.csv';

describe('real 123 review smoke', () => {
  it(
    'runs June 2026 reviews through real AI analysis',
    async () => {
      const apiKey = process.env.HOTEL_REVIEW_AI_API_KEY;
      if (!apiKey) {
        throw new Error('HOTEL_REVIEW_AI_API_KEY is required for this smoke test');
      }

      const rawRecords = csvTextToRawReviewRecords(readFileSync(CSV_PATH, 'utf8'));
      const records = rawRecords.map((record) => normalizeReviewRecord(record, FIXTURE_SOURCE_CONFIG.fields));
      const filters = {
        hotelName: 'all',
        periodType: 'custom' as const,
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        checkInMonth: 'all',
        minScore: null,
        maxScore: null,
        replyStatus: 'all' as const,
        keyword: '',
      };
      const filteredRecords = filterReviews(records, filters);
      const batchTimings: AnalysisBatchTiming[] = [];
      const stageTimings: AnalysisStageTiming[] = [];
      let extractedEvidenceItems: TopicEvidenceItem[] = [];
      let topicMappings: SourceTopicMapping[] = [];

      expect(filteredRecords).toHaveLength(123);

      const result = await runAnalysis({
        records: filteredRecords,
        config: {
          ...DEFAULT_CONFIG.ai,
          apiKey,
          model: 'qwen-plus',
          maxBatchSize: 10,
          batchConcurrency: 10,
          requestTimeoutSeconds: 600,
          topN: 10,
        },
        filters,
        fields: FIXTURE_SOURCE_CONFIG.fields,
        onBatchTiming: (timing) => {
          batchTimings.push(timing);
          console.info('__REAL_123_BATCH__', JSON.stringify(timing));
        },
        onStageTiming: (timing) => {
          stageTimings.push(timing);
          console.info('__REAL_123_STAGE__', JSON.stringify(timing));
        },
        onCacheUsage: (usage) => {
          extractedEvidenceItems = [...usage.newEvidenceItems];
        },
        onTopicMappingUsage: (usage) => {
          topicMappings = buildTopicMappingsFromUsage(usage);
        },
      });

      console.info(
        '__REAL_123_RESULT__',
        JSON.stringify({
          totalReviews: result.overview.totalReviews,
          positiveTopics: result.positiveTopics.length,
          negativeTopics: result.negativeTopics.length,
          firstPositiveTopic: result.positiveTopics[0]?.displayTopic,
          firstNegativeTopic: result.negativeTopics[0]?.displayTopic,
          batchTimings,
          stageTimings,
        }),
      );

      expect(result.status).toBe('complete');
      expect(result.overview.totalReviews).toBe(123);
      expect(result.positiveTopics.length + result.negativeTopics.length).toBeGreaterThan(0);
      expect(extractedEvidenceItems.length).toBeGreaterThan(0);
      expect(topicMappings.length).toBeGreaterThan(0);

      const warmStageTimings: AnalysisStageTiming[] = [];
      const warmResult = await runAnalysis({
        records: filteredRecords,
        config: {
          ...DEFAULT_CONFIG.ai,
          apiKey,
          model: 'qwen-plus',
          maxBatchSize: 10,
          batchConcurrency: 10,
          requestTimeoutSeconds: 600,
          topN: 10,
        },
        filters,
        fields: FIXTURE_SOURCE_CONFIG.fields,
        cachedEvidenceItems: extractedEvidenceItems,
        cacheMissRecords: [],
        cachedTopicMappings: topicMappings,
        analyzeBatchImpl: async () => {
          throw new Error('warm run should not extract evidence');
        },
        mergeTopicsImpl: async () => {
          throw new Error('warm run should not call AI topic merge');
        },
        onStageTiming: (timing) => {
          warmStageTimings.push(timing);
          console.info('__REAL_123_WARM_STAGE__', JSON.stringify(timing));
        },
      });

      console.info(
        '__REAL_123_WARM_RESULT__',
        JSON.stringify({
          totalReviews: warmResult.overview.totalReviews,
          positiveTopics: warmResult.positiveTopics.length,
          negativeTopics: warmResult.negativeTopics.length,
          stageTimings: warmStageTimings,
        }),
      );

      expect(warmResult.status).toBe('complete');
      expect(warmResult.overview.totalReviews).toBe(123);
      expect(warmResult.positiveTopics.length + warmResult.negativeTopics.length).toBeGreaterThan(0);
      expect(warmStageTimings.find((timing) => timing.step === 'AI 合并主题')?.detail).toContain('AI 调用 0 次');
    },
    15 * 60 * 1000,
  );
});

function buildTopicMappingsFromUsage(usage: TopicMappingUsage): SourceTopicMapping[] {
  const mappings: SourceTopicMapping[] = [];
  const candidatesById = new Map(usage.newCandidates.map((candidate) => [candidate.id, candidate]));
  const candidatesByKey = new Map(
    usage.newCandidates.map((candidate) => [`${candidate.sentiment}|${normalizeTopic(candidate.sourceLabel)}`, candidate]),
  );

  for (const group of usage.newGroups) {
    for (const member of group.members) {
      const candidate =
        (member.candidateId ? candidatesById.get(member.candidateId) : undefined) ??
        candidatesByKey.get(`${group.sentiment}|${normalizeTopic(member.sourceLabel)}`);
      if (!candidate) {
        continue;
      }
      mappings.push({
        sourceLabel: candidate.sourceLabel,
        sentiment: candidate.sentiment,
        mergeKey: group.mergeKey,
        category: group.category,
        displayTopic: group.displayTopic,
        summary: group.summary,
        action: group.action,
        acceptedQuotes: member.acceptedQuotes,
      });
    }
  }

  return mappings;
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}
