import { describe, expect, it } from 'vitest';
import { createPostgresFacilityAnalysisStore } from './postgresFacilityAnalysisStore';
import type { PostgresQueryClient } from './postgresReviewSyncStore';
import type { FacilityAnalysisResult } from './facilityAnalysis';

describe('createPostgresFacilityAnalysisStore', () => {
  it('saves facility analysis results into facility_analysis_runs and maps the saved row', async () => {
    const client = new FakePostgresClient();
    const store = createPostgresFacilityAnalysisStore(client);
    const result = minimalResult();

    const saved = await store.saveResult({
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
      sourceRecordCount: 26,
      result,
    });

    expect(client.queries[0].text).toContain('insert into facility_analysis_runs');
    expect(client.queries[0].values).toEqual([
      'tenant-a',
      'base-token-a',
      'tbl-facility',
      'view-facility',
      '2026-06-23',
      26,
      JSON.stringify(result),
      result.generatedAt,
    ]);
    expect(saved).toEqual({
      resultId: 'facility-result-1',
      tenantKey: 'tenant-a',
      baseToken: 'base-token-a',
      tableId: 'tbl-facility',
      viewId: 'view-facility',
      sourceRecordCount: 26,
      result,
      createdAt: '2026-06-23T12:05:01.000Z',
      exportStatus: 'pending',
    });
  });
});

class FakePostgresClient implements PostgresQueryClient {
  queries: Array<{ text: string; values?: unknown[] }> = [];

  async query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ text, values });
    return {
      rows: [
        {
          id: 'facility-result-1',
          tenant_key: values?.[0],
          base_token: values?.[1],
          table_id: values?.[2],
          view_id: values?.[3],
          source_record_count: values?.[5],
          result_json: JSON.parse(String(values?.[6])),
          created_at: '2026-06-23T12:05:01.000Z',
        },
      ] as T[],
    };
  }
}

function minimalResult(): FacilityAnalysisResult {
  return {
    analysisId: 'facility-analysis-1',
    generatedAt: '2026-06-23T12:05:00.000+08:00',
    collectionDate: '2026-06-23',
    summary: {
      collectionDate: '2026-06-23',
      currentHotelCount: 26,
      unchangedHotelCount: 24,
      changedHotelCount: 1,
      newHotelCount: 1,
    },
    dailySummary: '本次采集26家酒店：24家无变动，1家有变动，1家新采集。',
    hotelDiffs: [],
  };
}
