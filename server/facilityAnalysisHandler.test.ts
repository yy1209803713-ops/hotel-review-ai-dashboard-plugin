import { describe, expect, it, vi } from 'vitest';
import { handleFacilityAnalysisRequest } from './facilityAnalysisHandler';
import type { FacilityAnalysisResult } from './facilityAnalysis';

describe('handleFacilityAnalysisRequest', () => {
  it('runs facility analysis for Feishu Workflow requests and returns the persisted result id', async () => {
    const result = minimalResult();
    const run = vi.fn(async () => ({
      resultId: 'facility-result-1',
      result,
    }));

    const response = await handleFacilityAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/facilities/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer facility-secret',
        },
        body: JSON.stringify({
          tenantKey: 'tenant-a',
          baseToken: 'base-token-a',
          tableId: 'tbl4E0oXrtLaqVD1',
          viewId: 'vew4lxWDMf',
        }),
      }),
      {
        secret: 'facility-secret',
        runner: { run },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resultId: 'facility-result-1',
      summary: result.summary,
      dailySummary: result.dailySummary,
    });
    expect(run).toHaveBeenCalledWith({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl4E0oXrtLaqVD1',
      viewId: 'vew4lxWDMf',
      fieldMapping: undefined,
    });
  });

  it('rejects missing authorization and required table fields', async () => {
    const runner = { run: vi.fn() };

    const unauthorized = await handleFacilityAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/facilities/analyze', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: JSON.stringify({ tenantKey: 'tenant-a', baseToken: 'base-token-a', tableId: 'tbl' }),
      }),
      { secret: 'facility-secret', runner },
    );
    const invalid = await handleFacilityAnalysisRequest(
      new Request('http://127.0.0.1:8787/api/hotel-review-ai/facilities/analyze', {
        method: 'POST',
        headers: { Authorization: 'Bearer facility-secret' },
        body: JSON.stringify({ tenantKey: 'tenant-a', baseToken: 'base-token-a' }),
      }),
      { secret: 'facility-secret', runner },
    );

    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({ stage: 'validate_request' });
    expect(unauthorized.headers.get('Access-Control-Allow-Private-Network')).toBe('true');
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ message: 'missing required fields: tableId' });
    expect(runner.run).not.toHaveBeenCalled();
  });
});

function minimalResult(): FacilityAnalysisResult {
  return {
    analysisId: 'facility-analysis-1',
    generatedAt: '2026-06-23T12:05:00.000+08:00',
    collectionDate: '2026-06-23',
    summary: {
      collectionDate: '2026-06-23',
      currentHotelCount: 1,
      unchangedHotelCount: 0,
      changedHotelCount: 0,
      newHotelCount: 1,
    },
    dailySummary: '本次分析1家酒店：1家为新采集。',
    hotelDiffs: [
      {
        hotelId: 'C',
        hotelName: 'C酒店',
        status: 'new',
        currentRecordId: 'rec-c',
        currentCollectedAt: '2026-06-23T12:00:00.000',
        changes: [],
        aiSummary: 'C酒店为新采集，无历史数据。',
      },
    ],
  };
}
