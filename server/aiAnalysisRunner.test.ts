import { describe, expect, it } from 'vitest';
import { BackendAnalysisError } from './backendAnalysis';
import { createAiAnalysisRunner, readAiRuntimeConfig } from './aiAnalysisRunner';
import type { ReviewRecord } from './reviewSource';

describe('readAiRuntimeConfig', () => {
  it('requires backend-owned AI credentials instead of allowing local placeholder analysis', () => {
    expect(() => readAiRuntimeConfig({})).toThrow(BackendAnalysisError);
    expect(() => readAiRuntimeConfig({})).toThrow('AI_BASE_URL is required for backend analysis');
    expect(() => readAiRuntimeConfig({ AI_BASE_URL: 'https://api.example.com/v1' })).toThrow(
      'AI_API_KEY is required for backend analysis',
    );
    expect(() =>
      readAiRuntimeConfig({
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
      }),
    ).toThrow('AI_MODEL is required for backend analysis');
  });
});

describe('createAiAnalysisRunner', () => {
  it('runs the shared analysis pipeline with backend AI settings', async () => {
    const runner = createAiAnalysisRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
      },
      analyzeBatchImpl: async ({ config, records }) => {
        expect(config.apiBaseUrl).toBe('https://api.example.com/v1');
        expect(config.apiKey).toBe('sk-test');
        expect(config.model).toBe('qwen-plus');
        expect(records.map((record) => record.recordId)).toEqual(['rec-positive', 'rec-negative']);
        return {
          evidenceItems: [
            {
              recordId: 'rec-positive',
              quote: '位置非常方便',
              sentiment: 'positive',
              aspectLabel: '位置',
            },
            {
              recordId: 'rec-negative',
              quote: '空调噪音很大',
              sentiment: 'negative',
              aspectLabel: '噪音',
            },
          ],
        };
      },
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: candidate.sentiment === 'positive' ? '位置' : '设施',
          displayTopic: candidate.sentiment === 'positive' ? '位置方便出行省心' : '空调噪音影响睡眠',
          summary: `${candidate.sourceLabel} summary`,
          members: [
            {
              candidateId: candidate.id,
              sourceLabel: candidate.sourceLabel,
            },
          ],
        })),
      }),
      now: () => '2026-06-22T15:30:00.000Z',
    });

    const result = await runner.run({
      reviews: [
        review('rec-positive', '酒店位置非常方便，步行到景点很近。', '2026-06-10'),
        review('rec-negative', '房间空调噪音很大，晚上睡不好。', '2026-06-12'),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: {
          hotelName: 'all',
          periodType: 'month',
          startDate: '2026-05-22',
          endDate: '2026-06-22',
        },
      },
      jobId: 'job-1',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(result.summary).toMatchObject({
      model: 'qwen-plus',
      generatedAt: '2026-06-22T15:30:00.000Z',
      overview: {
        totalReviews: 2,
        positiveReviews: 1,
        negativeOrRiskReviews: 1,
      },
      positiveTopics: [expect.objectContaining({ displayTopic: '位置方便出行省心' })],
      negativeTopics: [expect.objectContaining({ displayTopic: '空调噪音影响睡眠' })],
    });
    expect(result.topics).toHaveLength(2);
    expect(result.evidenceByTopic).toMatchObject({
      位置: [
        expect.objectContaining({
          recordId: 'rec-positive',
          sentiment: 'positive',
          review: expect.objectContaining({
            content: '酒店位置非常方便，步行到景点很近。',
          }),
        }),
      ],
      噪音: [expect.objectContaining({ recordId: 'rec-negative', sentiment: 'negative' })],
    });
  });

  it('applies filters before sending reviews into analysis', async () => {
    const runner = createAiAnalysisRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
      },
      analyzeBatchImpl: async ({ records }) => {
        expect(records.map((record) => record.recordId)).toEqual(['rec-match']);
        return {
          evidenceItems: [
            {
              recordId: 'rec-match',
              quote: '位置很好',
              sentiment: 'positive',
              aspectLabel: '位置',
            },
          ],
        };
      },
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: candidate.sentiment,
          displayTopic: candidate.sourceLabel === '位置' ? '位置方便出行省心' : '房间噪音影响睡眠',
          summary: candidate.sourceLabel,
          members: [
            {
              candidateId: candidate.id,
              sourceLabel: candidate.sourceLabel,
            },
          ],
        })),
      }),
    });

    await runner.run({
      reviews: [
        review('rec-match', '酒店位置很好，靠近地铁。'),
        review('rec-skip', '房间很吵，空调噪音很大。'),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: {
          hotelName: 'all',
          periodType: 'custom',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
          keyword: '位置',
        },
      },
      jobId: 'job-2',
      pipelineVersion: 'backend-owned-v1',
    });
  });

  it('normalizes ReviewSource records before applying filters', async () => {
    const analyzeBatchImpl = vi.fn(async ({ records }) => {
      expect(records.map((record) => record.recordId)).toEqual(['rec-match']);
      return {
        evidenceItems: [
          {
            recordId: 'rec-match',
            quote: '位置很好',
            sentiment: 'positive',
            aspectLabel: '位置',
          },
        ],
      };
    });
    const runner = createAiAnalysisRunner({
      env: {
        AI_BASE_URL: 'https://api.example.com/v1',
        AI_API_KEY: 'sk-test',
        AI_MODEL: 'qwen-plus',
      },
      analyzeBatchImpl,
      mergeTopicsImpl: async ({ candidates }) => ({
        groups: candidates.map((candidate) => ({
          mergeKey: candidate.sourceLabel,
          sentiment: candidate.sentiment,
          category: '位置',
          displayTopic: '位置方便出行省心',
          summary: candidate.sourceLabel,
          members: [
            {
              candidateId: candidate.id,
              sourceLabel: candidate.sourceLabel,
            },
          ],
        })),
      }),
    });

    await runner.run({
      reviews: [
        sourceReview('rec-match', {
          content: '酒店位置很好，靠近地铁。',
          reviewDate: '2026-06-15 10:00:00',
        }),
        sourceReview('rec-outside-date', {
          content: '酒店位置也不错。',
          reviewDate: '2026-05-15 10:00:00',
        }),
      ],
      query: {
        tenantKey: 'tenant-a',
        baseToken: 'base-a',
        tableId: 'tbl-review',
        fieldMapping: {},
        filters: {
          hotelName: 'all',
          periodType: 'custom',
          startDate: '2026-06-01',
          endDate: '2026-06-30',
          keyword: '位置',
        },
      },
      jobId: 'job-3',
      pipelineVersion: 'backend-owned-v1',
    });

    expect(analyzeBatchImpl).toHaveBeenCalledTimes(1);
  });
});

function review(recordId: string, content: string, reviewDate = '2026-06-15'): ReviewRecord {
  return {
    recordId,
    fields: {},
    mappedFields: {
      content,
      reviewDate,
    },
    content,
    reviewDate,
    contentHash: `${recordId}-hash`,
  };
}

function sourceReview(recordId: string, overrides: Partial<Record<string, unknown>>): ReviewRecord {
  const mappedFields = {
    content: '酒店位置很好。',
    reviewDate: '2026-06-15 10:00:00',
    ...overrides,
  };
  return {
    recordId,
    fields: {},
    mappedFields,
    content: String(mappedFields.content ?? ''),
    contentHash: `${recordId}-hash`,
  };
}
