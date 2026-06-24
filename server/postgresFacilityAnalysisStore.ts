import type { FacilityAnalysisResult } from './facilityAnalysis';
import type { FacilityAnalysisStore, FacilityAnalysisStoredResult } from './facilityAnalysisRunner';
import type { PostgresQueryClient } from './postgresReviewSyncStore';

export function createPostgresFacilityAnalysisStore(client: PostgresQueryClient): FacilityAnalysisStore {
  return {
    async saveResult(input) {
      const { rows } = await client.query<FacilityAnalysisRunRow>(
        `insert into facility_analysis_runs (
          tenant_key, base_token, table_id, view_id, collection_date,
          source_record_count, result_json, generated_at
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        returning *`,
        [
          input.tenantKey,
          input.baseToken,
          input.tableId,
          input.viewId ?? null,
          input.result.collectionDate,
          input.sourceRecordCount,
          JSON.stringify(input.result),
          input.result.generatedAt,
        ],
      );
      const row = rows[0];
      if (!row) {
        throw new Error('saved facility analysis result missing');
      }
      return facilityAnalysisResultFromRow(row);
    },
    async markExportStatus(input) {
      const { rows } = await client.query<FacilityAnalysisRunRow>(
        `update facility_analysis_runs
            set export_status = $2, export_stage = $3, export_error = $4, exported_at = $5
          where id = $1
          returning *`,
        [input.resultId, input.status, input.stage ?? null, input.error ?? null, input.exportedAt ?? null],
      );
      const row = rows[0];
      if (!row) {
        throw new Error('updated facility analysis result missing');
      }
      return facilityAnalysisResultFromRow(row);
    },
  };
}

type FacilityAnalysisRunRow = {
  id: string;
  tenant_key: string;
  base_token: string;
  table_id: string;
  view_id?: string | null;
  source_record_count: number;
  result_json: FacilityAnalysisResult | string;
  created_at: string | Date;
  export_status?: string | null;
  export_stage?: string | null;
  export_error?: string | null;
  exported_at?: string | Date | null;
};

function facilityAnalysisResultFromRow(row: FacilityAnalysisRunRow): FacilityAnalysisStoredResult {
  return {
    resultId: row.id,
    tenantKey: row.tenant_key,
    baseToken: row.base_token,
    tableId: row.table_id,
    viewId: row.view_id ?? undefined,
    sourceRecordCount: Number(row.source_record_count),
    result: typeof row.result_json === 'string' ? JSON.parse(row.result_json) as FacilityAnalysisResult : row.result_json,
    createdAt: toIsoString(row.created_at),
    exportStatus: row.export_status ?? 'pending',
    exportStage: row.export_stage ?? undefined,
    exportError: row.export_error ?? undefined,
    exportedAt: row.exported_at ? toIsoString(row.exported_at) : undefined,
  };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
