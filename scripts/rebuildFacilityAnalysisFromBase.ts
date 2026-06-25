import { createPostgresPool } from '../server/db/postgres';
import {
  analyzeFacilityChanges,
  createFacilityRecordFromBaseRecord,
  DEFAULT_FACILITY_FIELD_MAPPING,
  type FacilityBaseRecord,
  type FacilityRecord,
} from '../server/facilityAnalysis';
import { createFacilityAiSummarizer } from '../server/facilityAiSummarizer';
import { createFacilityAnalysisBaseExporterFactory } from '../server/facilityAnalysisBaseExporter';
import { requireFeishuBaseAuthCode } from '../server/feishuBaseRuntimeConfig';
import { createLarkOpenApiRuntime, type LarkOpenApiRuntime } from '../server/larkOpenApiRuntime';
import { createPostgresFacilityAnalysisStore } from '../server/postgresFacilityAnalysisStore';

const baseToken = requiredEnv('FACILITY_BASE_TOKEN');
const tableId = requiredEnv('FACILITY_TABLE_ID');
const viewId = process.env.FACILITY_VIEW_ID?.trim() || undefined;
const tenantKey = process.env.FACILITY_TENANT_KEY?.trim() || 'feishu_base';
const authCode = requireFeishuBaseAuthCode(process.env, 'read_source', 'facility analysis rebuild');

const runtime = createLarkOpenApiRuntime({ baseToken, authCode });
const rawRecords = await readAllFacilityBaseRecords(runtime, { tableId, viewId, pageSize: 500 });
const records = rawRecords.map((record) => createFacilityRecordFromBaseRecord(record, DEFAULT_FACILITY_FIELD_MAPPING));
const collectionDates = [...new Set(records.map((record) => record.collectionDate))].sort();

const pool = createPostgresPool();
try {
  const store = createPostgresFacilityAnalysisStore(pool);
  const exporter = createFacilityAnalysisBaseExporterFactory({ store });
  const exportRuntime = createLarkOpenApiRuntime({ baseToken, authCode });
  const tables = await ensureExportTables(exportRuntime);
  const deleted = await clearExportTables(exportRuntime, [tables.change.tableId, tables.hotel.tableId, tables.batch.tableId]);

  const savedRuns = [];
  for (const collectionDate of collectionDates) {
    const scopedRecords = records.filter((record) => record.collectionDate <= collectionDate);
    const result = await analyzeFacilityChanges(scopedRecords, {
      summarizeChanges: createFacilityAiSummarizer(),
    });
    const saved = await store.saveResult({
      tenantKey,
      baseToken,
      tableId,
      viewId,
      sourceRecordCount: scopedRecords.length,
      result,
    });
    await exporter.export(saved);
    savedRuns.push({
      resultId: saved.resultId,
      collectionDate: saved.result.collectionDate,
      sourceRecordCount: saved.sourceRecordCount,
      summary: saved.result.summary,
      dailySummary: saved.result.dailySummary,
    });
  }

  console.log(JSON.stringify({
    sourceRecordCount: records.length,
    collectionDates,
    deleted,
    savedRuns,
  }, null, 2));
} finally {
  await pool.end();
}

async function ensureExportTables(
  runtime: LarkOpenApiRuntime,
): Promise<{ batch: { tableId: string }; hotel: { tableId: string }; change: { tableId: string } }> {
  const exporter = createFacilityAnalysisBaseExporterFactory();
  const probe = await storelessProbeSavedResult();
  await exporter.export(probe);
  const tables = await runtime.getTableList();
  return {
    batch: findTable(tables, '设施和政策变动汇总'),
    hotel: findTable(tables, '设施酒店变动明细'),
    change: findTable(tables, '设施变动项明细'),
  };
}

async function storelessProbeSavedResult() {
  const generatedAt = new Date().toISOString();
  return {
    resultId: `rebuild-probe-${generatedAt}`,
    tenantKey,
    baseToken,
    tableId,
    viewId,
    sourceRecordCount: 0,
    createdAt: generatedAt,
    result: {
      analysisId: `rebuild-probe-${generatedAt}`,
      generatedAt,
      collectionDate: '2000-01-01',
      summary: {
        collectionDate: '2000-01-01',
        currentHotelCount: 0,
        unchangedHotelCount: 0,
        changedHotelCount: 0,
        newHotelCount: 0,
      },
      dailySummary: '重建展示表探针记录',
      hotelDiffs: [],
    },
  };
}

function findTable(tables: Array<{ tableId: string; tableName: string }>, tableName: string): { tableId: string } {
  const table = tables.find((item) => item.tableName === tableName);
  if (!table) {
    throw new Error(`export table not found after ensure: ${tableName}`);
  }
  return { tableId: table.tableId };
}

async function clearExportTables(runtime: LarkOpenApiRuntime, tableIds: string[]): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const tableId of tableIds) {
    const recordIds = await readAllRecordIds(runtime, tableId);
    deleted[tableId] = recordIds.length;
    for (const chunk of chunkArray(recordIds, 200)) {
      await runtime.deleteRecords(tableId, chunk);
    }
  }
  return deleted;
}

async function readAllRecordIds(runtime: LarkOpenApiRuntime, tableId: string): Promise<string[]> {
  const recordIds: string[] = [];
  let pageToken: unknown = undefined;
  do {
    const page = await runtime.readRecordsPage(tableId, { pageSize: 500, pageToken });
    recordIds.push(...page.records.map((record) => record.recordId));
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined && pageToken !== null && pageToken !== '');
  return recordIds;
}

async function readAllFacilityBaseRecords(
  sourceRuntime: LarkOpenApiRuntime,
  input: { tableId: string; viewId?: string; pageSize: number },
): Promise<FacilityBaseRecord[]> {
  const sourceRecords: FacilityBaseRecord[] = [];
  let pageToken: unknown = undefined;
  do {
    const page = await sourceRuntime.readRecordsPage(input.tableId, {
      viewId: input.viewId,
      pageSize: input.pageSize,
      pageToken,
    });
    sourceRecords.push(...page.records);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined && pageToken !== null && pageToken !== '');
  return sourceRecords;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
