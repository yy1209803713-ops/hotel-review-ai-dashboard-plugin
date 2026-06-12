import { describe, expect, it } from 'vitest';
import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type { BatchAiResult, ReviewRecord, TopicEvidenceItem, TopicMergeCandidate } from '../types/analysis';
import { runAnalysis } from './analysisPipeline';

const config: AiConfig = {
  apiBaseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxBatchSize: 2,
  batchConcurrency: 1,
  topN: 1,
};

const filters: FilterState = {
  hotelName: '昆明中维翠湖宾馆',
  periodType: 'custom',
  startDate: '2026-06-01',
  endDate: '2026-06-30',
  checkInMonth: 'all',
  minScore: null,
  maxScore: null,
  replyStatus: 'all',
  keyword: '',
};

const fields: FieldMapping = {
  reviewId: 'reviewId',
  content: 'content',
  hotelName: 'hotelName',
  score: 'score',
  reviewDate: 'reviewDate',
  checkInMonth: 'checkInMonth',
  replyContent: 'replyContent',
  roomType: 'roomType',
};

const records: ReviewRecord[] = [
  makeRecord('rec1', 5),
  makeRecord('rec2', 4.8),
  makeRecord('rec3', 3.2),
];

describe('runAnalysis', () => {
  it('builds topics from validated evidence, supports mixed reviews, and filters wrong evidence attachments', async () => {
    const batchResults: BatchAiResult[] = [
      {
        evidenceItems: [
          evidence('rec1', '位置很好', 'positive', '地理位置优越'),
          evidence('rec1', '服务热情', 'positive', '服务热情'),
          evidence('rec2', '隔音不好', 'negative', '隔音问题'),
          evidence('rec2', '位置很好', 'positive', '地理位置优越'),
          evidence('rec3', '雪花酥很好吃', 'positive', '地理位置优越'),
        ],
      },
      {
        evidenceItems: [
          evidence('rec3', '雪花酥很好吃', 'positive', '欢迎礼体验'),
          evidence('rec3', '服务好', 'positive', '服务热情'),
        ],
      },
    ];
    const seenBatchSizes: number[] = [];

    const result = await runAnalysis({
      records,
      config: { ...config, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async ({ records }) => {
        seenBatchSizes.push(records.length);
        return batchResults.shift()!;
      },
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel === '地理位置优越' ? '位置便利' : candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: candidate.sourceLabel === '地理位置优越' ? '位置' : candidate.sourceLabel,
          displayTopic: candidate.sourceLabel === '地理位置优越' ? '位置便利' : candidate.sourceLabel,
          summary: `${candidate.sourceLabel} summary`,
          members: [
            {
              sourceLabel: candidate.sourceLabel,
              acceptedQuotes: candidate.sourceLabel === '地理位置优越' ? ['位置很好'] : candidate.quotes,
            },
          ],
        })),
      }),
    });

    expect(seenBatchSizes).toEqual([2, 1]);
    expect(result.overview).toMatchObject({
      totalReviews: 3,
      positiveReviews: 3,
      negativeOrRiskReviews: 1,
      mixedReviews: 1,
      neutralReviews: 0,
      averageScore: 4.33,
    });
    expect(result.positiveTopics.find((item) => item.topic === '位置便利')).toMatchObject({
      topic: '位置便利',
      count: 2,
      commentRecordIds: ['rec1', 'rec2'],
      evidencePhrases: ['位置很好'],
    });
    expect(result.positiveTopics.find((item) => item.topic === '位置便利')?.commentRecordIds).not.toContain('rec3');
    expect(result.positiveTopics.find((item) => item.topic === '欢迎礼体验')).toMatchObject({
      count: 1,
      commentRecordIds: ['rec3'],
    });
    expect(result.negativeTopics[0]).toMatchObject({
      topic: '隔音问题',
      count: 1,
      commentRecordIds: ['rec2'],
    });
    expect(result.actionItems[0]).toMatchObject({
      title: '优先处理：隔音问题',
      impactCount: 1,
    });
  });

  it('keeps category, merge key, and display topic separate when building ranked topics', async () => {
    const result = await runAnalysis({
      records,
      config: { ...config, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '服务热情', 'positive', '服务态度'),
          evidence('rec3', '服务好', 'positive', '员工服务'),
        ],
      }),
      mergeTopicsImpl: async () => ({
        groups: [
          {
            mergeKey: '服务体验',
            sentiment: 'positive',
            category: '服务',
            displayTopic: '服务热情，沟通顺畅',
            summary: '客人认可服务人员态度和沟通。',
            members: [
              { sourceLabel: '服务态度', acceptedQuotes: ['服务热情'] },
              { sourceLabel: '员工服务', acceptedQuotes: ['服务好'] },
            ],
          },
        ],
      }),
    });

    expect(result.positiveTopics[0]).toMatchObject({
      mergeKey: '服务体验',
      category: '服务',
      displayTopic: '服务热情，沟通顺畅',
      topic: '服务热情，沟通顺畅',
      count: 2,
      commentRecordIds: ['rec1', 'rec3'],
      evidencePhrases: ['服务热情', '服务好'],
    });
    expect(result.positiveTopics[0].topic).not.toBe('服务');
  });

  it('sends positive and negative candidates through separate topic merge calls', async () => {
    const mergeCalls: TopicMergeCandidate[][] = [];

    const result = await runAnalysis({
      records,
      config: { ...config, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '服务热情', 'positive', '服务体验'),
          evidence('rec2', '隔音不好', 'negative', '隔音问题'),
        ],
      }),
      mergeTopicsImpl: async ({ candidates }) => {
        mergeCalls.push(candidates);
        return {
          groups: candidates.map((candidate) => ({
            mergeKey: candidate.sourceLabel,
            sentiment: candidate.sentiment,
            category: candidate.sentiment === 'positive' ? '服务' : '设施',
            displayTopic: candidate.sentiment === 'positive' ? '服务热情，沟通顺畅' : '房间有噪音，影响休息',
            summary: `${candidate.sourceLabel} summary`,
            members: [
              {
                sourceLabel: candidate.sourceLabel,
                acceptedQuotes: candidate.quotes,
              },
            ],
          })),
        };
      },
    });

    expect(mergeCalls).toHaveLength(2);
    expect(mergeCalls[0].map((candidate) => candidate.sentiment)).toEqual(['positive']);
    expect(mergeCalls[1].map((candidate) => candidate.sentiment)).toEqual(['negative']);
    expect(result.positiveTopics[0].displayTopic).toBe('服务热情，沟通顺畅');
    expect(result.negativeTopics[0].displayTopic).toBe('房间有噪音，影响休息');
  });

  it('reports which batch failed without producing fallback analysis', async () => {
    await expect(
      runAnalysis({
        records,
        config,
        filters,
        fields,
        analyzeBatchImpl: async ({ records }) => {
          if (records.some((record) => record.recordId === 'rec3')) {
            throw new Error('AI API 网络请求失败');
          }
          return {
            evidenceItems: [],
          };
        },
      }),
    ).rejects.toThrow('第 2/2 批 AI 分析失败（1 条评论）：AI API 网络请求失败');
  });

  it('runs batches concurrently up to configured concurrency', async () => {
    const started: string[] = [];
    const resolvers: Array<(result: BatchAiResult) => void> = [];
    const analysisPromise = runAnalysis({
      records,
      config: { ...config, maxBatchSize: 1, batchConcurrency: 2 },
      filters,
      fields,
      analyzeBatchImpl: ({ records }) => {
        started.push(records[0].recordId);
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    });

    await Promise.resolve();
    expect(started).toEqual(['rec1', 'rec2']);

    resolvers[0](emptyBatchResult(1));
    await Promise.resolve();
    expect(started).toEqual(['rec1', 'rec2', 'rec3']);

    resolvers[1](emptyBatchResult(1));
    resolvers[2](emptyBatchResult(1));
    const result = await analysisPromise;

    expect(result.overview.totalReviews).toBe(3);
  });

  it('reports timing for each AI batch', async () => {
    const timings: Array<{
      batchIndex: number;
      batchCount: number;
      recordCount: number;
      durationMs: number;
      status: string;
    }> = [];
    const nowValues = [100, 135, 200, 260];

    await runAnalysis({
      records,
      config,
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      nowMs: () => nowValues.shift() ?? 0,
      onBatchTiming: (timing) => {
        timings.push(timing);
      },
      analyzeBatchImpl: async ({ records }) => emptyBatchResult(records.length),
    });

    expect(timings).toEqual([
      {
        batchIndex: 0,
        batchCount: 2,
        recordCount: 2,
        durationMs: 35,
        status: 'success',
      },
      {
        batchIndex: 1,
        batchCount: 2,
        recordCount: 1,
        durationMs: 60,
        status: 'success',
      },
    ]);
  });
});

function makeRecord(recordId: string, score: number): ReviewRecord {
  const contentById: Record<string, string> = {
    rec1: '位置很好，服务热情。',
    rec2: '位置很好，但是隔音不好。',
    rec3: '雪花酥很好吃。服务好。设施好，卫生好，环境好。',
  };

  return {
    recordId,
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score,
    reviewDate: '2026-06-01 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content: contentById[recordId] ?? `${recordId} 评论内容`,
  };
}

function topic(
  topic: string,
  category: string,
  count: number,
  sentiment: 'positive' | 'negative',
  commentRecordIds: string[],
  evidencePhrases: string[],
) {
  return {
    mergeKey: topic,
    topic,
    displayTopic: topic,
    category,
    count,
    sentiment,
    commentRecordIds,
    evidencePhrases,
    summary: `${topic} summary`,
  };
}

function evidence(
  recordId: string,
  quote: string,
  sentiment: 'positive' | 'negative',
  aspectLabel: string,
): TopicEvidenceItem {
  return {
    recordId,
    quote,
    sentiment,
    aspectLabel,
    reason: `${aspectLabel} reason`,
  };
}

function emptyBatchResult(positiveCount: number): BatchAiResult {
  return {
    evidenceItems:
      positiveCount > 0
        ? Array.from({ length: positiveCount }, (_, index) =>
            evidence(records[index]?.recordId ?? `rec${index + 1}`, '评论内容', 'positive', '整体好评'),
          )
        : [],
  };
}
