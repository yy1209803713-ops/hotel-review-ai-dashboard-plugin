import { BackendAnalysisError } from './backendAnalysis';
import type { FacilityAnalysisStoredResult } from './facilityAnalysisRunner';
import { requireFeishuBaseAuthCode, type FeishuBaseRuntimeEnv } from './feishuBaseRuntimeConfig';
import { createLarkOpenApiRuntime, type LarkOpenApiRuntime } from './larkOpenApiRuntime';
import type { FacilityAnalysisStore } from './facilityAnalysisRunner';

export type FacilityAnalysisBaseExporterFactoryOptions = {
  env?: FeishuBaseRuntimeEnv;
  createRuntime?: typeof createLarkOpenApiRuntime;
  store?: FacilityAnalysisStore;
};

export type FacilityAnalysisDateRangeClearResult = {
  batch: number;
  hotel: number;
  change: number;
};

export type FacilityAnalysisBaseExporterPort = {
  export(result: FacilityAnalysisStoredResult): Promise<void>;
  clearDateRange?(input: {
    baseToken: string;
    startDate: string;
    endDate: string;
  }): Promise<FacilityAnalysisDateRangeClearResult>;
};

const BATCH_TABLE_NAME = '设施和政策变动汇总';
const HOTEL_TABLE_NAME = '设施酒店变动明细';
const CHANGE_TABLE_NAME = '设施变动项明细';

type RuntimeTable = { tableId: string; tableName: string };

type ExportTables = {
  batch: RuntimeTable;
  hotel: RuntimeTable;
  change: RuntimeTable;
};

type ExportField = {
  name: string;
  type: number | string;
  style?: Record<string, unknown>;
};

export function createFacilityAnalysisBaseExporterFactory(options: FacilityAnalysisBaseExporterFactoryOptions = {}) {
  return new FacilityAnalysisBaseExporter(options.env ?? process.env, options.createRuntime ?? createLarkOpenApiRuntime, options.store);
}

export class FacilityAnalysisBaseExporter implements FacilityAnalysisBaseExporterPort {
  constructor(
    private readonly env: FeishuBaseRuntimeEnv,
    private readonly createRuntime: typeof createLarkOpenApiRuntime,
    private readonly store?: FacilityAnalysisStore,
  ) {}

  async export(result: FacilityAnalysisStoredResult): Promise<void> {
    const runtime = this.getRuntime(result.baseToken);
    await this.updateExportStatus(result.resultId, 'pending', 'ensure_tables');
    try {
      const tables = await ensureTables(runtime);
      const existing = await findExistingResultRows(runtime, tables.batch.tableId, result.resultId);
      if (existing.length) {
        await this.updateExportStatus(result.resultId, 'success', 'skip_existing');
        return;
      }

      const batchRow = buildBatchRow(result);
      const hotelRows = buildHotelRows(result);
      const changeRows = buildChangeRows(result);

      const batchIds = await runtime.addRecords(tables.batch.tableId, [{ fields: batchRow }]);
      const batchRecordId = batchIds[0];
      if (!batchRecordId) {
        throw new BackendAnalysisError(500, 'export_summary', 'failed to create facility batch record');
      }

      if (hotelRows.length) {
        await runtime.addRecords(tables.hotel.tableId, hotelRows.map((fields) => ({ fields: { ...fields, '批次记录ID': batchRecordId } })));
      }
      if (changeRows.length) {
        await runtime.addRecords(tables.change.tableId, changeRows.map((fields) => ({ fields: { ...fields, '批次记录ID': batchRecordId } })));
      }
      await this.updateExportStatus(result.resultId, 'success', 'done');
    } catch (error) {
      await this.updateExportStatus(
        result.resultId,
        'failed',
        'export_error',
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  async clearDateRange(input: {
    baseToken: string;
    startDate: string;
    endDate: string;
  }): Promise<FacilityAnalysisDateRangeClearResult> {
    validateDateRange(input.startDate, input.endDate);
    const runtime = this.getRuntime(input.baseToken);
    const tables = await ensureTables(runtime);
    const [change, hotel, batch] = await Promise.all([
      deleteRowsByCollectionDateRange(runtime, tables.change.tableId, input.startDate, input.endDate),
      deleteRowsByCollectionDateRange(runtime, tables.hotel.tableId, input.startDate, input.endDate),
      deleteRowsByCollectionDateRange(runtime, tables.batch.tableId, input.startDate, input.endDate),
    ]);
    return { batch, hotel, change };
  }

  private getRuntime(baseToken: string): LarkOpenApiRuntime {
    const authCode = requireFeishuBaseAuthCode(this.env, 'export_summary', 'facility analysis export');
    return this.createRuntime({ baseToken, authCode });
  }

  private async updateExportStatus(
    resultId: string,
    status: 'pending' | 'success' | 'failed',
    stage?: string,
    error?: string,
  ): Promise<void> {
    if (!this.store?.markExportStatus) {
      return;
    }
    await this.store.markExportStatus({
      resultId,
      status,
      stage,
      error,
      exportedAt: status === 'success' ? new Date().toISOString() : undefined,
    });
  }
}

async function deleteRowsByCollectionDateRange(
  runtime: LarkOpenApiRuntime,
  tableId: string,
  startDate: string,
  endDate: string,
): Promise<number> {
  const recordIds: string[] = [];
  let pageToken: unknown = undefined;
  do {
    const page = await runtime.readRecordsPage(tableId, { pageSize: 500, pageToken });
    recordIds.push(
      ...page.records
        .filter((record) => {
          const collectionDate = readCollectionDate(record.fields);
          return collectionDate !== undefined && collectionDate >= startDate && collectionDate <= endDate;
        })
        .map((record) => record.recordId),
    );
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined && pageToken !== null && pageToken !== '');

  for (const chunk of chunkArray(recordIds, 200)) {
    await runtime.deleteRecords(tableId, chunk);
  }
  return recordIds.length;
}

function readCollectionDate(fields: Record<string, unknown>): string | undefined {
  return normalizeCollectionDate(fields.数据采集日期 ?? fields['数据采集日期']);
}

function normalizeCollectionDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatDateInChinaTimezone(new Date(value));
  }
  if (value instanceof Date) {
    return formatDateInChinaTimezone(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const dateOnly = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (dateOnly) {
      return dateOnly[1];
    }
    const slashDate = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (slashDate) {
      return `${slashDate[1]}-${slashDate[2].padStart(2, '0')}-${slashDate[3].padStart(2, '0')}`;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return formatDateInChinaTimezone(new Date(parsed));
    }
  }
  return undefined;
}

function formatDateInChinaTimezone(value: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(value);
}

function validateDateRange(startDate: string, endDate: string): void {
  if (!isValidDateOnly(startDate) || !isValidDateOnly(endDate)) {
    throw new BackendAnalysisError(400, 'reanalyze', 'reanalyze date range must use YYYY-MM-DD');
  }
  if (startDate > endDate) {
    throw new BackendAnalysisError(400, 'reanalyze', 'reanalyze startDate must be on or before endDate');
  }
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function ensureTables(runtime: LarkOpenApiRuntime): Promise<ExportTables> {
  const tables = await runtime.getTableList();
  const batch = await ensureTable(runtime, tables, BATCH_TABLE_NAME, batchFields);
  const hotel = await ensureTable(runtime, tables, HOTEL_TABLE_NAME, hotelFields);
  const change = await ensureTable(runtime, tables, CHANGE_TABLE_NAME, changeFields);
  return { batch, hotel, change };
}

async function ensureTable(
  runtime: LarkOpenApiRuntime,
  tables: RuntimeTable[],
  tableName: string,
  fields: ExportField[],
): Promise<RuntimeTable> {
  const existing = tables.find((table) => table.tableName === tableName);
  if (existing) {
    await ensureFields(runtime, existing.tableId, fields);
    return existing;
  }
  const created = await runtime.addTable(tableName, fields);
  return { tableId: created.tableId, tableName };
}

async function ensureFields(runtime: LarkOpenApiRuntime, tableId: string, fields: ExportField[]): Promise<void> {
  const existingFields = await runtime.getFieldMetaList(tableId);
  const existingNames = new Set(existingFields.map((field) => field.fieldName));
  for (const field of fields) {
    if (!existingNames.has(field.name)) {
      await runtime.addField(tableId, field);
    }
  }
}

async function findExistingResultRows(runtime: LarkOpenApiRuntime, tableId: string, resultId: string): Promise<Array<{ recordId: string; fields: Record<string, unknown> }>> {
  const records: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
  let pageToken: unknown = undefined;
  do {
    const page = await runtime.readRecordsPage(tableId, { pageSize: 500, pageToken });
    records.push(...page.records.filter((record) => String(record.fields['结果ID'] ?? record.fields['结果 ID'] ?? '') === resultId));
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined && pageToken !== null && pageToken !== '');
  return records;
}

function buildBatchRow(result: FacilityAnalysisStoredResult): Record<string, unknown> {
  return omitEmptyFields({
    结果ID: result.resultId,
    分析时间: dateTimeToTimestamp(result.result.generatedAt),
    数据采集日期: dateOnlyToTimestamp(result.result.collectionDate),
    对比日期: dateOnlyToTimestampOrEmpty(getComparisonDate(result)),
    当前酒店数: result.result.summary.currentHotelCount,
    无变动数: result.result.summary.unchangedHotelCount,
    变动数: result.result.summary.changedHotelCount,
    新采集数: result.result.summary.newHotelCount,
    总结: result.result.dailySummary,
    变动明细: buildBatchChangeDetail(result),
    原始JSON: JSON.stringify(result.result),
  });
}

function getComparisonDate(result: FacilityAnalysisStoredResult): string | undefined {
  const previousDates = result.result.hotelDiffs
    .map((diff) => datePart(diff.previousCollectedAt))
    .filter((date): date is string => Boolean(date));
  return previousDates.sort().at(-1);
}

function datePart(value: string | undefined): string | undefined {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1];
}

function dateTimeToTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new BackendAnalysisError(500, 'export_summary', `invalid analysis time: ${value}`);
  }
  return timestamp;
}

function dateOnlyToTimestamp(date: string): number {
  const timestamp = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp)) {
    throw new BackendAnalysisError(500, 'export_summary', `invalid collection date: ${date}`);
  }
  return timestamp;
}

function dateOnlyToTimestampOrEmpty(date: string | undefined): number | string {
  return date ? dateOnlyToTimestamp(date) : '';
}

function omitEmptyFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ''));
}

function buildBatchChangeDetail(result: FacilityAnalysisStoredResult): string {
  const changedDiffs = result.result.hotelDiffs.filter((diff) => diff.changes.length > 0);
  if (!changedDiffs.length) {
    return '无';
  }
  return changedDiffs
    .map((diff) => {
      const aiSummary = cleanAiChangeSummary(diff.hotelName, diff.aiSummary);
      if (aiSummary) {
        return `${diff.hotelName}：${aiSummary}`;
      }
      const details = diff.changes
        .map((change) => change.description || formatChangeDescription(change))
        .filter((detail) => detail.trim().length > 0)
        .join('；');
      return details ? `${diff.hotelName}：${details}` : `${diff.hotelName}：有变动`;
    })
    .join('\n');
}

function cleanAiChangeSummary(hotelName: string, summary: string | undefined): string {
  if (!summary) {
    return '';
  }
  return summary
    .trim()
    .replace(/[。；;，,\s]+$/g, '')
    .replace(new RegExp(`^${escapeRegExp(hotelName)}[：:，,\\s]*`), '')
    .replace(/^该酒店[：:，,\s]*/, '')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatChangeDescription(change: { field: string; before?: unknown; after?: unknown; kind?: string }): string {
  const before = valueToText(change.before);
  const after = valueToText(change.after);
  if (before && after) {
    return `${change.field}由“${before}”变为“${after}”`;
  }
  if (after) {
    return `${change.field}新增“${after}”`;
  }
  if (before) {
    return `${change.field}取消“${before}”`;
  }
  return `${change.field || change.kind || '项目'}发生变动`;
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function buildHotelRows(result: FacilityAnalysisStoredResult): Array<Record<string, unknown>> {
  return result.result.hotelDiffs.map((diff) => omitEmptyFields({
    结果ID: result.resultId,
    分析时间: dateTimeToTimestamp(result.result.generatedAt),
    数据采集日期: dateOnlyToTimestamp(result.result.collectionDate),
    对比日期: dateOnlyToTimestampOrEmpty(datePart(diff.previousCollectedAt)),
    酒店ID: diff.hotelId,
    酒店名称: diff.hotelName,
    状态: diff.status,
    上次采集时间: diff.previousCollectedAt ?? '',
    本次采集时间: diff.currentCollectedAt,
    AI摘要: diff.aiSummary ?? '',
    原始JSON: JSON.stringify(diff),
  }));
}

function buildChangeRows(result: FacilityAnalysisStoredResult): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const diff of result.result.hotelDiffs) {
    for (const change of diff.changes) {
      rows.push(omitEmptyFields({
        结果ID: result.resultId,
        分析时间: dateTimeToTimestamp(result.result.generatedAt),
        数据采集日期: dateOnlyToTimestamp(result.result.collectionDate),
        对比日期: dateOnlyToTimestampOrEmpty(datePart(diff.previousCollectedAt)),
        酒店ID: diff.hotelId,
        酒店名称: diff.hotelName,
        变动类型: change.kind,
        变动字段: change.field,
        变动前: change.before ?? '',
        变动后: change.after ?? '',
        变动描述: change.description,
        原始JSON: JSON.stringify(change),
      }));
    }
  }
  return rows;
}

const text = 'text';
const number = 'number';
const datetime = 'datetime';

const integerStyle = {
  type: 'plain',
  precision: 0,
  percentage: false,
  thousands_separator: false,
};

const batchFields = [
  { name: '结果ID', type: text },
  { name: '分析时间', type: datetime, style: { format: 'yyyy/MM/dd HH:mm' } },
  { name: '数据采集日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '对比日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '当前酒店数', type: number, style: integerStyle },
  { name: '无变动数', type: number, style: integerStyle },
  { name: '变动数', type: number, style: integerStyle },
  { name: '新采集数', type: number, style: integerStyle },
  { name: '总结', type: text },
  { name: '变动明细', type: text },
  { name: '原始JSON', type: text },
];

const hotelFields = [
  { name: '批次记录ID', type: text },
  { name: '结果ID', type: text },
  { name: '分析时间', type: datetime, style: { format: 'yyyy/MM/dd HH:mm' } },
  { name: '数据采集日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '对比日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '酒店ID', type: text },
  { name: '酒店名称', type: text },
  { name: '状态', type: text },
  { name: '上次采集时间', type: text },
  { name: '本次采集时间', type: text },
  { name: 'AI摘要', type: text },
  { name: '原始JSON', type: text },
];

const changeFields = [
  { name: '批次记录ID', type: text },
  { name: '结果ID', type: text },
  { name: '分析时间', type: datetime, style: { format: 'yyyy/MM/dd HH:mm' } },
  { name: '数据采集日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '对比日期', type: datetime, style: { format: 'yyyy/MM/dd' } },
  { name: '酒店ID', type: text },
  { name: '酒店名称', type: text },
  { name: '变动类型', type: text },
  { name: '变动字段', type: text },
  { name: '变动前', type: text },
  { name: '变动后', type: text },
  { name: '变动描述', type: text },
  { name: '原始JSON', type: text },
];
