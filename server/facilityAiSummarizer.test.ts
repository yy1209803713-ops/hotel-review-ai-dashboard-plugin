import { describe, expect, it, vi } from 'vitest';
import { createFacilityAiSummarizer } from './facilityAiSummarizer';
import type { FacilityHotelDiff } from './facilityAnalysis';

describe('createFacilityAiSummarizer', () => {
  it('summarizes deterministic facility diffs through OpenAI-compatible chat completions', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain('酒店设施和政策变动分析助手');
      expect(body.messages[1].content).toContain('早餐价格由58调整为68');
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                dailySummary: '本次分析2家酒店：1家设施政策无变动，1家有变动。',
                hotelSummaries: [
                  {
                    hotelId: 'A',
                    summary: 'A酒店早餐价格由58调整为68，较上次上调10元。',
                  },
                ],
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const summarize = createFacilityAiSummarizer({
      env: {
        AI_BASE_URL: 'https://example.test/v1',
        AI_API_KEY: 'key',
        AI_MODEL: 'gpt-test',
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(summarize({
      collectionDate: '2026-06-23',
      hotelDiffs: [changedHotelDiff('A'), unchangedHotelDiff('B')],
    })).resolves.toEqual({
      dailySummary: '本次分析2家酒店：1家设施政策无变动，1家有变动。',
      hotelSummaries: {
        A: 'A酒店早餐价格由58调整为68，较上次上调10元。',
      },
    });
  });

  it('fails when the model omits required hotelSummaries', async () => {
    const summarize = createFacilityAiSummarizer({
      env: {
        AI_BASE_URL: 'https://example.test/v1',
        AI_API_KEY: 'key',
        AI_MODEL: 'gpt-test',
      },
      fetchImpl: (async () => new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ dailySummary: 'bad' }) } }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    });

    await expect(summarize({
      collectionDate: '2026-06-23',
      hotelDiffs: [changedHotelDiff('A')],
    })).rejects.toThrow(/hotelSummaries/);
  });
});

function changedHotelDiff(hotelId: string): FacilityHotelDiff {
  return {
    hotelId,
    hotelName: `${hotelId}酒店`,
    status: 'changed',
    currentRecordId: `current-${hotelId}`,
    previousRecordId: `previous-${hotelId}`,
    currentCollectedAt: '2026-06-23T12:00:00.000',
    previousCollectedAt: '2026-06-13T12:00:00.000',
    daysSincePrevious: 10,
    changes: [
      {
        kind: 'field_changed',
        field: '早餐价格',
        before: '58',
        after: '68',
        description: '早餐价格由58调整为68',
      },
    ],
  };
}

function unchangedHotelDiff(hotelId: string): FacilityHotelDiff {
  return {
    hotelId,
    hotelName: `${hotelId}酒店`,
    status: 'unchanged',
    currentRecordId: `current-${hotelId}`,
    previousRecordId: `previous-${hotelId}`,
    currentCollectedAt: '2026-06-23T12:00:00.000',
    previousCollectedAt: '2026-06-22T12:00:00.000',
    changes: [],
  };
}
