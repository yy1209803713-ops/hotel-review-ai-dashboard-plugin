import { spawnSync } from 'node:child_process';
import { createPostgresPool } from '../server/db/postgres';
import { analyzeFacilityChanges, createFacilityRecordFromBaseRecord, type FacilityBaseRecord } from '../server/facilityAnalysis';
import { createFacilityAiSummarizer } from '../server/facilityAiSummarizer';
import { createFacilityAnalysisBaseExporterFactory } from '../server/facilityAnalysisBaseExporter';
import { createPostgresFacilityAnalysisStore } from '../server/postgresFacilityAnalysisStore';

const excelPath = process.argv[2];
if (!excelPath) {
  throw new Error('usage: vite-node scripts/analyzeFacilityExcel.ts <xlsx-path>');
}

const sheetName = process.env.FACILITY_EXCEL_SHEET_NAME?.trim() || '酒店设施和政策';
const rawRecords = readExcelRecords(excelPath, sheetName);
const invalidJsonFields = stripInvalidOptionalJsonFields(rawRecords);
const records = rawRecords.map((record) => createFacilityRecordFromBaseRecord(record));
const collectionDates = getCollectionDates(records);

const pool = createPostgresPool();
try {
  const store = createPostgresFacilityAnalysisStore(pool);
  const exporter = createFacilityAnalysisBaseExporterFactory({ store });
  const savedRuns = [];
  for (const collectionDate of collectionDates) {
    const scopedRecords = collectionDate
      ? records.filter((record) => record.collectionDate <= collectionDate)
      : records;
    const result = await analyzeFacilityChanges(scopedRecords, {
      summarizeChanges: createFacilityAiSummarizer(),
    });
    const saved = await store.saveResult({
      tenantKey: process.env.FACILITY_EXCEL_TENANT_KEY?.trim() || 'local_excel',
      baseToken: process.env.FACILITY_EXCEL_BASE_TOKEN?.trim() || `excel:${excelPath}`,
      tableId: process.env.FACILITY_EXCEL_TABLE_ID?.trim() || sheetName,
      viewId: process.env.FACILITY_EXCEL_VIEW_ID?.trim() || `sheet:${sheetName}`,
      sourceRecordCount: scopedRecords.length,
      result,
    });
    await exporter.export(saved);
    savedRuns.push({
      resultId: saved.resultId,
      tenantKey: saved.tenantKey,
      tableId: saved.tableId,
      viewId: saved.viewId,
      sourceRecordCount: saved.sourceRecordCount,
      collectionDate: saved.result.collectionDate,
      summary: saved.result.summary,
      dailySummary: saved.result.dailySummary,
      exportStatus: saved.exportStatus,
      exportStage: saved.exportStage,
      exportError: saved.exportError,
    });
  }

  console.log(JSON.stringify({
    savedRuns,
    invalidJsonFields,
  }, null, 2));
} finally {
  await pool.end();
}

function shouldRunAllDates(): boolean {
  const value = process.env.FACILITY_EXCEL_RUN_ALL_DATES?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function getCollectionDates(records: Array<{ collectionDate: string }>): Array<string | undefined> {
  const targetDate = process.env.FACILITY_EXCEL_TARGET_DATE?.trim();
  if (targetDate) {
    return [targetDate];
  }
  return shouldRunAllDates()
    ? [...new Set(records.map((record) => record.collectionDate))].sort()
    : [undefined];
}

function stripInvalidOptionalJsonFields(records: FacilityBaseRecord[]) {
  const invalidFields: Array<{ recordId: string; field: string; message: string }> = [];
  for (const record of records) {
    for (const field of ['酒店设施JSON', '酒店政策JSON']) {
      const value = record.fields[field];
      if (value === null || value === undefined || value === '') {
        continue;
      }
      try {
        JSON.parse(String(value));
      } catch (cause) {
        invalidFields.push({
          recordId: record.recordId,
          field,
          message: cause instanceof Error ? cause.message : String(cause),
        });
        record.fields[field] = null;
      }
    }
  }
  return invalidFields;
}

function readExcelRecords(path: string, sheet: string): FacilityBaseRecord[] {
  const python = String.raw`
from openpyxl import load_workbook
import datetime
import json
import sys

path = sys.argv[1]
sheet_name = sys.argv[2]
wb = load_workbook(path, read_only=True, data_only=True)
if sheet_name not in wb.sheetnames:
    raise SystemExit(f"sheet not found: {sheet_name}")
ws = wb[sheet_name]
ws.reset_dimensions()
rows = ws.iter_rows(values_only=True)
headers = [str(value).strip() if value is not None else "" for value in next(rows)]
records = []
for index, row in enumerate(rows, start=2):
    fields = {}
    has_value = False
    for header, value in zip(headers, row):
        if not header:
            continue
        if value is None:
            fields[header] = None
            continue
        has_value = True
        if isinstance(value, datetime.datetime):
            fields[header] = value.strftime("%Y-%m-%d %H:%M:%S")
        elif isinstance(value, datetime.date):
            fields[header] = value.strftime("%Y-%m-%d")
        else:
            fields[header] = value
    if not has_value:
        continue
    source_id = fields.get("id") or index
    records.append({"recordId": f"excel-{source_id}", "fields": fields})
print(json.dumps(records, ensure_ascii=False))
`;

  const result = spawnSync('python3', ['-c', python, path, sheet], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `python exited with status ${result.status}`);
  }
  return JSON.parse(result.stdout) as FacilityBaseRecord[];
}
