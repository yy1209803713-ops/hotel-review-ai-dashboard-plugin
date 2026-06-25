import { describe, expect, it, vi } from 'vitest';
import type { AiConfig, FieldMapping, FilterState } from '../types/config';
import type {
  BatchAiResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
  TopicMergeResult,
} from '../types/analysis';
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
          category: inferCategory(candidate.sourceLabel, candidate.sentiment),
          displayTopic: displayTopicFor(candidate.sourceLabel),
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
    expect(result.positiveTopics.find((item) => item.topic === '位置方便，出行省心')).toMatchObject({
      topic: '位置方便，出行省心',
      count: 2,
      commentRecordIds: ['rec1', 'rec2'],
      evidencePhrases: ['位置很好'],
    });
    expect(result.positiveTopics.find((item) => item.topic === '位置方便，出行省心')?.commentRecordIds).not.toContain('rec3');
    expect(result.positiveTopics.find((item) => item.topic === '欢迎礼让人有惊喜')).toMatchObject({
      count: 1,
      commentRecordIds: ['rec3'],
    });
    expect(result.negativeTopics[0]).toMatchObject({
      topic: '房间隔音不好，影响休息',
      count: 1,
      commentRecordIds: ['rec2'],
    });
    expect(result.actionItems[0]).toMatchObject({
      title: '优先处理：房间隔音不好，影响休息',
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

  it('maps topic merge members by stable candidate IDs when labels are rewritten', async () => {
    const result = await runAnalysis({
      records: makeRecordsForEvidence([
        ['rec1', '房间宽敞。', 5],
        ['rec2', '采光很好。', 5],
      ]),
      config: { ...config, maxBatchSize: 10, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '房间宽敞', 'positive', '房间空间'),
          evidence('rec2', '采光很好', 'positive', '房间采光'),
        ],
      }),
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: [
          {
            mergeKey: '房间空间采光',
            sentiment: 'positive',
            category: '房型',
            displayTopic: '房间宽敞，采光也好',
            summary: '客人认可房间空间和采光。',
            members: candidates.map((candidate) => ({
              candidateId: candidate.id,
              sourceLabel: `${candidate.sourceLabel}已归并`,
              acceptedQuotes: candidate.quotes,
            })),
          },
        ],
      }),
    });

    expect(result.positiveTopics[0]).toMatchObject({
      mergeKey: '房间空间采光',
      displayTopic: '房间宽敞，采光也好',
      count: 2,
      commentRecordIds: ['rec1', 'rec2'],
      evidencePhrases: ['房间宽敞', '采光很好'],
    });
  });

  it('reports extracted evidence before topic merge starts so cache can be saved on merge failure', async () => {
    const usages: Array<{
      newEvidenceItems: TopicEvidenceItem[];
    }> = [];

    await expect(
      runAnalysis({
        records: makeRecordsForEvidence([
          ['rec1', '房间宽敞。', 5],
        ]),
        config: { ...config, maxBatchSize: 10, topN: 10 },
        filters,
        fields,
        now: '2026-06-03T12:00:00+08:00',
        onCacheUsage: (usage) => {
          usages.push({ newEvidenceItems: usage.newEvidenceItems });
        },
        analyzeBatchImpl: async () => ({
          evidenceItems: [
            evidence('rec1', '房间宽敞', 'positive', '房间空间'),
          ],
        }),
        mergeTopicsImpl: async () => {
          throw new Error('AI 主题合并失败');
        },
      }),
    ).rejects.toThrow('AI 主题合并失败');

    expect(usages).toHaveLength(1);
    expect(usages[0].newEvidenceItems).toEqual([
      evidence('rec1', '房间宽敞', 'positive', '房间空间'),
    ]);
  });

  it('sends positive and negative candidates through concurrent sentiment merge calls', async () => {
    const mergeCalls: TopicMergeCandidate[][] = [];
    const started: Array<TopicMergeCandidate['sentiment']> = [];
    const resolvers: Array<(result: TopicMergeResult) => void> = [];

    const analysisPromise = runAnalysis({
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
        started.push(candidates[0].sentiment);
        return new Promise((resolve) => {
          resolvers.push(resolve);
        });
      },
    });

    await waitForCondition(() => started.length === 2);
    expect(started).toEqual(['positive', 'negative']);
    expect(resolvers).toHaveLength(2);

    resolvers[1](primaryMergeResult(mergeCalls[1]));
    resolvers[0](primaryMergeResult(mergeCalls[0]));
    const result = await analysisPromise;

    expect(mergeCalls).toHaveLength(2);
    expect(mergeCalls[0].map((candidate) => candidate.sentiment)).toEqual(['positive']);
    expect(mergeCalls[1].map((candidate) => candidate.sentiment)).toEqual(['negative']);
    expect(result.positiveTopics[0].displayTopic).toBe('服务体验让人满意');
    expect(result.negativeTopics[0].displayTopic).toBe('隔音问题让人满意');
  });

  it('logs structured evidence batch failures with AI error details', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const batchFailureSpy = vi.fn();

    await expect(
      runAnalysis({
        records,
        config: { ...config, maxBatchSize: 2 },
        filters,
        fields,
        onBatchFailure: batchFailureSpy,
        analyzeBatchImpl: async ({ records }) => {
          if (records.some((record) => record.recordId === 'rec3')) {
            const error = new Error('模型返回内容不是合法 JSON') as Error & {
              code: string;
              details: Record<string, unknown>;
            };
            error.code = 'invalid_json';
            error.details = {
              source: 'model_content',
              preview: 'not json',
              rawLength: 8,
              rawContent: 'not json',
            };
            throw error;
          }
          return { evidenceItems: [] };
        },
      }),
    ).rejects.toThrow('第 2/2 批 AI 分析失败（1 条评论）：模型返回内容不是合法 JSON');

    expect(batchFailureSpy).toHaveBeenCalledWith({
      batchIndex: 1,
      batchNumber: 2,
      batchCount: 2,
      recordCount: 1,
      recordIds: ['rec3'],
      errorMessage: '模型返回内容不是合法 JSON',
      errorCode: 'invalid_json',
      details: {
        source: 'model_content',
        preview: 'not json',
        rawLength: 8,
        rawContent: 'not json',
      },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      '__HOTEL_REVIEW_AI_EVIDENCE_BATCH_FAILED__',
      JSON.stringify({
        batchIndex: 1,
        batchNumber: 2,
        batchCount: 2,
        recordCount: 1,
        recordIds: ['rec3'],
        errorMessage: '模型返回内容不是合法 JSON',
        errorCode: 'invalid_json',
        details: {
          source: 'model_content',
          preview: 'not json',
          rawLength: 8,
        },
      }),
    );

    infoSpy.mockRestore();
  });

  it('runs one merge call per sentiment and keeps cached candidates isolated', async () => {
    const mergeCalls: TopicMergeCandidate[][] = [];
    const result = await runAnalysis({
      records: makeRecordsForEvidence([
        ['rec1', '房间宽敞，服务热情。', 5],
        ['rec2', '隔音不好，停车不便。', 3],
      ]),
      config: { ...config, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '房间宽敞', 'positive', '房间空间'),
          evidence('rec1', '服务热情', 'positive', '服务体验'),
          evidence('rec2', '隔音不好', 'negative', '隔音问题'),
          evidence('rec2', '停车不便', 'negative', '停车体验'),
        ],
      }),
      mergeTopicsImpl: async ({ candidates }) => {
        mergeCalls.push(candidates);
        return {
          groups: candidates.map((candidate) => ({
            mergeKey: candidate.sourceLabel,
            sentiment: candidate.sentiment,
            category: candidate.sentiment === 'positive' ? '服务' : '交通',
            displayTopic: `${candidate.sourceLabel}主题`,
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
    expect(mergeCalls[0].every((candidate) => candidate.sentiment === 'positive')).toBe(true);
    expect(mergeCalls[1].every((candidate) => candidate.sentiment === 'negative')).toBe(true);
    expect(result.positiveTopics).toHaveLength(2);
    expect(result.negativeTopics).toHaveLength(2);
  });

  it('sends all same-sentiment topic candidates in one flat merge call without second-level merging', async () => {
    const mergeCalls: TopicMergeCandidate[][] = [];
    const result = await runAnalysis({
      records: makeRecordsForEvidence([
        ['rec1', '床品舒服，服务热情。', 5],
        ['rec2', '早餐好吃。', 5],
        ['rec3', '位置方便。', 5],
        ['rec4', '卫生干净。', 5],
        ['rec5', '服务热情。', 5],
      ]),
      config: { ...config, maxBatchSize: 10, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '床品舒服', 'positive', '床品体验'),
          evidence('rec1', '服务热情', 'positive', '服务体验'),
          evidence('rec2', '早餐好吃', 'positive', '早餐体验'),
          evidence('rec3', '位置方便', 'positive', '位置体验'),
          evidence('rec4', '卫生干净', 'positive', '卫生体验'),
        ],
      }),
      mergeTopicsImpl: async ({ candidates }) => {
        mergeCalls.push(candidates);
        return {
          groups: [
            {
              mergeKey: '整体入住体验',
              sentiment: 'positive',
              category: '其他',
              displayTopic: '整体住得很舒服',
              summary: '客人整体认可入住体验。',
              members: candidates.map((candidate) => ({
                sourceLabel: candidate.sourceLabel,
                acceptedQuotes: candidate.quotes,
              })),
            },
          ],
        };
      },
    });

    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].map((candidate) => candidate.sourceLabel)).toEqual([
      '床品体验',
      '服务体验',
      '早餐体验',
      '位置体验',
      '卫生体验',
    ]);
    expect(result.positiveTopics).toHaveLength(1);
    expect(result.positiveTopics[0]).toMatchObject({
      displayTopic: '整体住得很舒服',
      count: 4,
      commentRecordIds: ['rec1', 'rec2', 'rec3', 'rec4'],
      evidencePhrases: ['床品舒服', '服务热情', '早餐好吃', '位置方便', '卫生干净'],
    });
  });

  it('builds topics from cached topic mappings without calling AI topic merge', async () => {
    const mergeTopicsImpl = vi.fn();
    const result = await runAnalysis({
      records: makeRecordsForEvidence([
        ['rec1', '房间很大，采光很好。', 5],
        ['rec2', '隔音不好。', 3],
      ]),
      config: { ...config, maxBatchSize: 10, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '房间很大', 'positive', '房间空间'),
          evidence('rec1', '采光很好', 'positive', '房间采光'),
          evidence('rec2', '隔音不好', 'negative', '隔音问题'),
        ],
      }),
      cachedTopicMappings: [
        {
          sourceLabel: '房间空间',
          sentiment: 'positive',
          mergeKey: '房间空间采光',
          category: '房型',
          displayTopic: '房间宽敞，采光也好',
          summary: '客人认可房间空间和采光。',
        },
        {
          sourceLabel: '房间采光',
          sentiment: 'positive',
          mergeKey: '房间空间采光',
          category: '房型',
          displayTopic: '房间宽敞，采光也好',
          summary: '客人认可房间空间和采光。',
        },
        {
          sourceLabel: '隔音问题',
          sentiment: 'negative',
          mergeKey: '隔音问题',
          category: '设施',
          displayTopic: '房间隔音不好，影响休息',
          summary: '隔音影响休息。',
          action: '排查临街房隔音并补充耳塞或换房提醒。',
        },
      ],
      mergeTopicsImpl,
    });

    expect(mergeTopicsImpl).not.toHaveBeenCalled();
    expect(result.positiveTopics[0]).toMatchObject({
      displayTopic: '房间宽敞，采光也好',
      count: 1,
      evidencePhrases: ['房间很大', '采光很好'],
    });
    expect(result.negativeTopics[0]).toMatchObject({
      displayTopic: '房间隔音不好，影响休息',
      action: '排查临街房隔音并补充耳塞或换房提醒。',
    });
  });

  it('sends only uncached topic candidates to AI merge and reports new mappings', async () => {
    const savedMappings: TopicMergeGroup[][] = [];
    const readMappingCalls: TopicMergeCandidate[][] = [];
    const mergeCalls: TopicMergeCandidate[][] = [];
    const result = await runAnalysis({
      records: makeRecordsForEvidence([
        ['rec1', '房间很大，采光很好。', 5],
        ['rec2', '服务热情。', 5],
      ]),
      config: { ...config, maxBatchSize: 10, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '房间很大', 'positive', '房间空间'),
          evidence('rec1', '采光很好', 'positive', '房间采光'),
          evidence('rec2', '服务热情', 'positive', '服务态度'),
        ],
      }),
      readTopicMappingsImpl: async ({ candidates }) => {
        readMappingCalls.push(candidates);
        return {
          cachedMappings: [
            {
              sourceLabel: '房间空间',
              sentiment: 'positive',
              mergeKey: '房间空间采光',
              category: '房型',
              displayTopic: '房间宽敞，采光也好',
              summary: '客人认可房间空间和采光。',
            },
          ],
        };
      },
      onTopicMappingUsage: (usage) => {
        savedMappings.push(usage.newGroups);
      },
      mergeTopicsImpl: async ({ candidates }) => {
        mergeCalls.push(candidates);
        return {
          groups: [
            {
              mergeKey: '房间空间采光',
              sentiment: 'positive',
              category: '房型',
              displayTopic: '房间宽敞，采光也好',
              summary: '客人认可房间空间和采光。',
              members: [
                {
                  candidateId: candidates[0].id,
                  sourceLabel: candidates[0].sourceLabel,
                  acceptedQuotes: candidates[0].quotes,
                },
              ],
            },
            {
              mergeKey: '服务态度',
              sentiment: 'positive',
              category: '服务',
              displayTopic: '服务热情，沟通顺畅',
              summary: '客人认可服务。',
              members: [
                {
                  candidateId: candidates[1].id,
                  sourceLabel: candidates[1].sourceLabel,
                  acceptedQuotes: candidates[1].quotes,
                },
              ],
            },
          ],
        };
      },
    });

    expect(readMappingCalls).toHaveLength(1);
    expect(readMappingCalls[0].map((candidate) => candidate.sourceLabel)).toEqual(['房间空间', '房间采光', '服务态度']);
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0].map((candidate) => candidate.sourceLabel)).toEqual(['房间采光', '服务态度']);
    expect(savedMappings).toHaveLength(1);
    expect(savedMappings[0][0].members.map((member: TopicMergeGroup['members'][number]) => member.sourceLabel)).toEqual(['房间采光']);
    expect(savedMappings[0][1].members.map((member: TopicMergeGroup['members'][number]) => member.sourceLabel)).toEqual(['服务态度']);
    expect(result.positiveTopics.map((topic) => topic.displayTopic)).toEqual([
      '房间宽敞，采光也好',
      '服务热情，沟通顺畅',
    ]);
  });

  it('rejects generic category names as final display topics', async () => {
    await expect(
      runAnalysis({
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
              displayTopic: '服务',
              summary: '客人认可服务。',
              members: [
                { sourceLabel: '服务态度', acceptedQuotes: ['服务热情'] },
                { sourceLabel: '员工服务', acceptedQuotes: ['服务好'] },
              ],
            },
          ],
        }),
      }),
    ).rejects.toThrow('displayTopic 不能使用上位类目“服务”');
  });

  it('rejects topic merge results that do not cover every candidate', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(
        runAnalysis({
          records,
          config: { ...config, topN: 10 },
          filters,
          fields,
          now: '2026-06-03T12:00:00+08:00',
          analyzeBatchImpl: async () => ({
            evidenceItems: [
              evidence('rec1', '服务热情', 'positive', '服务态度'),
              evidence('rec2', '位置很好', 'positive', '位置便利'),
            ],
          }),
          mergeTopicsImpl: async () => ({
            groups: [
              {
                mergeKey: '服务体验',
                sentiment: 'positive',
                category: '服务',
                displayTopic: '服务热情，沟通顺畅',
                summary: '客人认可服务。',
                members: [
                  { sourceLabel: '服务态度', acceptedQuotes: ['服务热情'] },
                ],
              },
            ],
          }),
        }),
      ).rejects.toThrow('好评主题合并结果无效：AI 主题归并漏掉候选标签');
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('rejects duplicate candidate coverage even when one member uses candidateId and another uses sourceLabel', async () => {
    await expect(
      runAnalysis({
        records: makeRecordsForEvidence([
          ['rec1', '房间宽敞。', 5],
        ]),
        config: { ...config, maxBatchSize: 10, topN: 10 },
        filters,
        fields,
        now: '2026-06-03T12:00:00+08:00',
        analyzeBatchImpl: async () => ({
          evidenceItems: [
            evidence('rec1', '房间宽敞', 'positive', '房间空间'),
          ],
        }),
        mergeTopicsImpl: async ({ candidates }) => ({
          groups: [
            {
              mergeKey: '房间空间',
              sentiment: 'positive',
              category: '房型',
              displayTopic: '房间宽敞，住着舒服',
              summary: '客人认可房间空间。',
              members: [
                {
                  candidateId: candidates[0].id,
                  sourceLabel: candidates[0].sourceLabel,
                  acceptedQuotes: ['房间宽敞'],
                },
              ],
            },
            {
              mergeKey: '房间空间重复',
              sentiment: 'positive',
              category: '房型',
              displayTopic: '房间空间重复覆盖',
              summary: '重复覆盖同一个候选。',
              members: [
                {
                  sourceLabel: candidates[0].sourceLabel,
                  acceptedQuotes: ['房间宽敞'],
                },
              ],
            },
          ],
        }),
      }),
    ).rejects.toThrow('AI 主题归并重复覆盖候选标签：id|c001');
  });

  it('rejects topic merge results that assign a candidate to the opposite sentiment group', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(
        runAnalysis({
          records: makeRecordsForEvidence([
            ['rec1', '服务热情。', 5],
            ['rec2', '隔音不好。', 3],
          ]),
          config: { ...config, maxBatchSize: 10, topN: 10 },
          filters,
          fields,
          now: '2026-06-03T12:00:00+08:00',
          analyzeBatchImpl: async () => ({
            evidenceItems: [
              evidence('rec1', '服务热情', 'positive', '服务体验'),
              evidence('rec2', '隔音不好', 'negative', '隔音问题'),
            ],
          }),
          mergeTopicsImpl: async ({ candidates }) => ({
            groups: [
              {
                mergeKey: '体验混放',
                sentiment: candidates[0].sentiment === 'positive' ? 'negative' : 'positive',
                category: '其他',
                displayTopic: '体验混放导致判断失真',
                summary: '故意把候选放进相反情绪组。',
                members: [
                  {
                    candidateId: candidates[0].id,
                    sourceLabel: candidates[0].sourceLabel,
                    acceptedQuotes: candidates[0].quotes,
                  },
                ],
              },
            ],
          }),
        }),
      ).rejects.toThrow('AI 主题归并把候选放入了相反情绪分组：positive|服务体验 -> negative');

      const diagnosticCall = infoSpy.mock.calls.find(
        ([label]) => label === '__HOTEL_REVIEW_AI_TOPIC_MERGE_INVALID__',
      );
      expect(diagnosticCall).toBeTruthy();
      const payload = JSON.parse(String(diagnosticCall?.[1]));
      expect(payload.sentimentMismatchKeys).toEqual(['positive|服务体验 -> negative']);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('rejects invalid flat topic merge results instead of splitting or falling back', async () => {
    const mergeCalls: TopicMergeCandidate[][] = [];
    await expect(
      runAnalysis({
        records: makeRecordsForEvidence([
          ['rec1', '床品舒服。', 5],
          ['rec2', '服务热情。', 5],
          ['rec3', '早餐好吃。', 5],
          ['rec4', '位置方便。', 5],
        ]),
        config: { ...config, maxBatchSize: 10, topN: 10 },
        filters,
        fields,
        now: '2026-06-03T12:00:00+08:00',
        analyzeBatchImpl: async () => ({
          evidenceItems: [
            evidence('rec1', '床品舒服', 'positive', '床品体验'),
          evidence('rec2', '服务热情', 'positive', '服务体验'),
          evidence('rec3', '早餐好吃', 'positive', '早餐体验'),
          evidence('rec4', '位置方便', 'positive', '位置体验'),
        ],
        }),
        mergeTopicsImpl: async ({ candidates }) => {
          mergeCalls.push(candidates);
          if (candidates.length === 4) {
            return {
              groups: [
                {
                  mergeKey: '局部服务体验',
                  sentiment: 'positive',
                category: '服务',
                displayTopic: '服务热情，沟通顺畅',
                summary: '故意漏掉三个候选，模拟大批次模型覆盖不全。',
                members: [
                  {
                    candidateId: candidates[1].id,
                    sourceLabel: candidates[1].sourceLabel,
                    acceptedQuotes: candidates[1].quotes,
                  },
                ],
                },
              ],
            };
          }
          return primaryMergeResult(candidates, 'chunk');
        },
      }),
    ).rejects.toThrow('AI 主题归并漏掉候选标签');
    expect(mergeCalls[0].map((candidate) => candidate.sourceLabel)).toEqual([
      '床品体验',
      '服务体验',
      '早餐体验',
      '位置体验',
    ]);
    expect(mergeCalls).toHaveLength(1);
  });

  it('logs invalid topic merge diagnostics before rejecting unknown candidate labels', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      await expect(
        runAnalysis({
          records: makeRecordsForEvidence([
            ['rec1', '房间宽敞。', 5],
            ['rec2', '采光很好。', 5],
          ]),
          config: { ...config, maxBatchSize: 10, topN: 10 },
          filters,
          fields,
          now: '2026-06-03T12:00:00+08:00',
          analyzeBatchImpl: async () => ({
            evidenceItems: [
              evidence('rec1', '房间宽敞', 'positive', '房间空间'),
              evidence('rec2', '采光很好', 'positive', '房间采光'),
            ],
          }),
          mergeTopicsImpl: async () => ({
            groups: [
              {
                mergeKey: '房间空间采光',
                sentiment: 'positive',
                category: '房型',
                displayTopic: '房间宽敞，采光也好',
                summary: '客人认可房间空间和采光。',
                members: [
                  {
                    sourceLabel: '房间空间与采光',
                    acceptedQuotes: ['房间宽敞', '采光很好'],
                  },
                ],
              },
            ],
          }),
        }),
      ).rejects.toThrow('AI 主题归并返回了未知候选标签：positive|房间空间与采光');

      const diagnosticCall = infoSpy.mock.calls.find(
        ([label]) => label === '__HOTEL_REVIEW_AI_TOPIC_MERGE_INVALID__',
      );
      expect(diagnosticCall).toBeTruthy();
      const payload = JSON.parse(String(diagnosticCall?.[1]));
      expect(payload).toMatchObject({
        context: '好评主题合并',
        candidateCount: 2,
        groupCount: 1,
        unknownMemberKeys: ['positive|房间空间与采光'],
        missingCandidateKeys: ['positive|房间空间', 'positive|房间采光'],
        duplicateMemberKeys: [],
      });
      expect(payload.candidates.map((candidate: { sourceLabel: string }) => candidate.sourceLabel)).toEqual([
        '房间空间',
        '房间采光',
      ]);
      expect(payload.groups[0].members.map((member: { sourceLabel: string }) => member.sourceLabel)).toEqual([
        '房间空间与采光',
      ]);
    } finally {
      infoSpy.mockRestore();
    }
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
    await flushPromises();
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
      config: { ...config, topN: 10 },
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

  it('reports timing for major analysis stages around batch extraction and topic merge', async () => {
    const stages: Array<{
      step: string;
      durationMs: number;
      status: string;
      records?: number;
      detail?: string;
    }> = [];
    const nowValues = [100, 145, 200, 260, 300, 325];

    await runAnalysis({
      records,
      config: { ...config, topN: 10 },
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      nowMs: () => nowValues.shift() ?? 0,
      onStageTiming: (stage) => {
        stages.push(stage);
      },
      analyzeBatchImpl: async () => ({
        evidenceItems: [
          evidence('rec1', '位置很好', 'positive', '位置便利'),
          evidence('rec2', '隔音不好', 'negative', '隔音问题'),
        ],
      }),
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: candidate.sentiment === 'positive' ? '位置' : '设施',
          displayTopic: candidate.sentiment === 'positive' ? '位置方便，出行省心' : '房间隔音不好，影响休息',
          summary: `${candidate.sourceLabel} summary`,
          members: [
            {
              sourceLabel: candidate.sourceLabel,
              acceptedQuotes: candidate.quotes,
            },
          ],
        })),
      }),
    });

    expect(stages).toEqual([
      {
        step: 'AI 抽取证据',
        durationMs: 160,
        status: 'success',
        records: 3,
        detail: '批次 2；新增证据 4 条',
      },
      {
        step: 'AI 合并主题',
        durationMs: 25,
        status: 'success',
        records: 2,
        detail: '候选主题 2 个；AI 调用 2 次；合并主题 2 个',
      },
      {
        step: '本地汇总主题',
        durationMs: 0,
        status: 'success',
        records: 3,
        detail: '有效证据 2 条；好评主题 1 个；风险主题 1 个',
      },
    ]);
  });

  it('reuses cached first-stage evidence and analyzes only cache misses', async () => {
    const seenRecords: string[] = [];
    const result = await runAnalysis({
      records,
      config,
      filters,
      fields,
      now: '2026-06-03T12:00:00+08:00',
      cachedEvidenceItems: [evidence('rec1', '位置很好', 'positive', '地理位置优越')],
      cacheMissRecords: records.filter((record) => record.recordId !== 'rec1'),
      analyzeBatchImpl: async ({ records }) => {
        seenRecords.push(...records.map((record) => record.recordId));
        return {
          evidenceItems: [
            evidence('rec2', '隔音不好', 'negative', '隔音问题'),
            evidence('rec3', '服务好', 'positive', '服务体验'),
          ],
        };
      },
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: candidate.sentiment === 'positive' ? '正向体验' : '风险体验',
          displayTopic: candidate.sourceLabel === '地理位置优越'
            ? '地理位置好，出行方便'
            : `${candidate.sourceLabel}相关体验`,
          summary: `${candidate.sourceLabel} summary`,
          members: [
            {
              sourceLabel: candidate.sourceLabel,
              acceptedQuotes: candidate.quotes,
            },
          ],
        })),
      }),
    });

    expect(seenRecords).toEqual(['rec2', 'rec3']);
    expect(result.positiveTopics.map((topic) => topic.displayTopic)).toEqual(['地理位置好，出行方便']);
    expect(result.negativeTopics[0]).toMatchObject({
      displayTopic: '隔音问题相关体验',
      commentRecordIds: ['rec2'],
    });
    expect(result.overview).toMatchObject({
      positiveReviews: 2,
      negativeOrRiskReviews: 1,
    });
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

function displayTopicFor(sourceLabel: string): string {
  const topics: Record<string, string> = {
    地理位置优越: '位置方便，出行省心',
    服务热情: '服务热情，沟通顺畅',
    欢迎礼体验: '欢迎礼让人有惊喜',
    隔音问题: '房间隔音不好，影响休息',
  };
  return topics[sourceLabel] ?? `${sourceLabel}相关体验`;
}

function inferCategory(sourceLabel: string, sentiment: 'positive' | 'negative'): string {
  if (/位置|地理/.test(sourceLabel)) {
    return '位置';
  }
  if (/服务/.test(sourceLabel)) {
    return '服务';
  }
  if (/欢迎礼|早餐|餐饮/.test(sourceLabel)) {
    return '餐饮';
  }
  if (/隔音|设施/.test(sourceLabel)) {
    return '设施';
  }
  return '其他';
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

function makeRecordsForEvidence(items: Array<[recordId: string, content: string, score: number]>): ReviewRecord[] {
  return items.map(([recordId, content, score]) => ({
    recordId,
    reviewId: recordId,
    hotelName: '昆明中维翠湖宾馆',
    score,
    reviewDate: '2026-06-01 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content,
  }));
}

function primaryMergeResult(candidates: TopicMergeCandidate[], mode: 'single' | 'chunk' = 'single'): TopicMergeResult {
  if (mode === 'chunk') {
    const first = candidates[0];
    return {
      groups: [
        {
          mergeKey: `${first.sourceLabel}等体验`,
          sentiment: first.sentiment,
          category: inferCategory(first.sourceLabel, first.sentiment),
          displayTopic: `${first.sourceLabel}等体验不错`,
          summary: `${first.sourceLabel}等体验 summary`,
          members: candidates.map((candidate) => ({
            sourceLabel: candidate.sourceLabel,
            acceptedQuotes: candidate.quotes,
          })),
        },
      ],
    };
  }
  return {
    groups: candidates.map((candidate) => ({
      mergeKey: candidate.sourceLabel,
      sentiment: candidate.sentiment,
      category: inferCategory(candidate.sourceLabel, candidate.sentiment),
      displayTopic: `${candidate.sourceLabel}让人满意`,
      summary: `${candidate.sourceLabel} summary`,
      members: [
        {
          sourceLabel: candidate.sourceLabel,
          acceptedQuotes: candidate.quotes,
        },
      ],
    })),
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (predicate()) {
      return;
    }
    await flushPromises();
  }
  throw new Error('condition was not met before the async queue settled');
}
