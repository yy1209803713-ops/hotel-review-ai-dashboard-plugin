import { BackendAnalysisError } from './backendAnalysis';
import {
  analyzeFacilityChanges,
  createFacilityRecordFromBaseRecord,
  DEFAULT_FACILITY_FIELD_MAPPING,
  type FacilityAnalysisResult,
  type FacilityBaseRecord,
  type FacilityChangeSummarizer,
  type FacilityFieldMapping,
} from './facilityAnalysis';
import { createFacilityAiSummarizer } from './facilityAiSummarizer';
import { requireFeishuBaseAuthCode, type FeishuBaseRuntimeEnv } from './feishuBaseRuntimeConfig';
import { createLarkOpenApiRuntime, type LarkOpenApiRuntime } from './larkOpenApiRuntime';
import type { FacilityAnalysisBaseExporterPort } from './facilityAnalysisBaseExporter';

export type FacilityAnalysisRunRequest = {
  tenantKey: string;
  baseToken: string;
  tableId: string;
  viewId?: string;
  fieldMapping?: Partial<FacilityFieldMapping>;
  reanalyze?: boolean;
  reanalyzeDateRange?: {
    startDate: string;
    endDate: string;
  };
};

export type FacilityAnalysisStoredResult = {
  resultId: string;
  tenantKey: string;
  baseToken: string;
  tableId: string;
  viewId?: string;
  sourceRecordCount: number;
  result: FacilityAnalysisResult;
  createdAt: string;
  exportStatus?: string;
  exportStage?: string;
  exportError?: string;
  exportedAt?: string;
};

export type FacilityAnalysisStore = {
  saveResult(input: Omit<FacilityAnalysisStoredResult, 'resultId' | 'createdAt'>): Promise<FacilityAnalysisStoredResult>;
  markExportStatus?(input: {
    resultId: string;
    status: 'pending' | 'success' | 'failed';
    stage?: string;
    error?: string;
    exportedAt?: string;
  }): Promise<FacilityAnalysisStoredResult>;
};

export type FacilityAnalysisRunner = {
  run(input: FacilityAnalysisRunRequest): Promise<FacilityAnalysisStoredResult>;
};

export type FacilityAnalysisRunnerOptions = {
  store: FacilityAnalysisStore;
  env?: FeishuBaseRuntimeEnv;
  createRuntime?: typeof createLarkOpenApiRuntime;
  summarizeChanges?: FacilityChangeSummarizer;
  baseExporter?: FacilityAnalysisBaseExporterPort;
  now?: () => string;
  pageSize?: number;
};

export function createFacilityAnalysisRunner(options: FacilityAnalysisRunnerOptions): FacilityAnalysisRunner {
  const env = options.env ?? process.env;
  const createRuntime = options.createRuntime ?? createLarkOpenApiRuntime;
  const summarizeChanges = options.summarizeChanges ?? createFacilityAiSummarizer();
  const pageSize = options.pageSize ?? 500;

  return {
    async run(input) {
      validateRunRequest(input);
      const runtime = createRuntimeForBase(input.baseToken, env, createRuntime, Boolean(options.createRuntime));
      const rawRecords = await readAllFacilityBaseRecords(runtime, {
        tableId: input.tableId,
        viewId: input.viewId,
        pageSize,
      });
      const mapping = {
        ...DEFAULT_FACILITY_FIELD_MAPPING,
        ...input.fieldMapping,
      };
      const records = rawRecords.map((record) => createFacilityRecordFromBaseRecord(record, mapping));
      if (input.reanalyze === true) {
        const range = requireReanalysisDateRange(input.reanalyzeDateRange);
        if (!options.baseExporter?.clearDateRange) {
          throw new BackendAnalysisError(500, 'reanalyze', 'facility analysis exporter does not support clearing date ranges');
        }
        const reanalysisBatches = buildReanalysisBatches(records, range);
        await options.baseExporter.clearDateRange({
          baseToken: input.baseToken,
          startDate: range.startDate,
          endDate: range.endDate,
        });

        let latestSaved: FacilityAnalysisStoredResult | undefined;
        for (const batch of reanalysisBatches) {
          latestSaved = await analyzeSaveAndExport({
            input,
            store: options.store,
            baseExporter: options.baseExporter,
            records: batch.records,
            sourceRecordCount: batch.records.length,
            generatedAt: options.now?.() ?? new Date().toISOString(),
            summarizeChanges,
          });
        }
        if (!latestSaved) {
          throw new BackendAnalysisError(400, 'reanalyze', 'reanalyze date range is empty');
        }
        return latestSaved;
      }

      return analyzeSaveAndExport({
        input,
        store: options.store,
        baseExporter: options.baseExporter,
        records,
        sourceRecordCount: records.length,
        generatedAt: options.now?.() ?? new Date().toISOString(),
        summarizeChanges,
      });
    },
  };
}

async function analyzeSaveAndExport(input: {
  input: FacilityAnalysisRunRequest;
  store: FacilityAnalysisStore;
  baseExporter?: FacilityAnalysisBaseExporterPort;
  records: ReturnType<typeof createFacilityRecordFromBaseRecord>[];
  sourceRecordCount: number;
  generatedAt: string;
  summarizeChanges: FacilityChangeSummarizer;
}): Promise<FacilityAnalysisStoredResult> {
  const result = await analyzeFacilityChanges(input.records, {
    generatedAt: input.generatedAt,
    summarizeChanges: input.summarizeChanges,
  });
  const saved = await input.store.saveResult({
    tenantKey: input.input.tenantKey,
    baseToken: input.input.baseToken,
    tableId: input.input.tableId,
    viewId: input.input.viewId,
    sourceRecordCount: input.sourceRecordCount,
    result,
  });
  await input.baseExporter?.export(saved);
  return saved;
}

function buildReanalysisBatches(
  records: ReturnType<typeof createFacilityRecordFromBaseRecord>[],
  range: { startDate: string; endDate: string },
): Array<{ collectionDate: string; records: ReturnType<typeof createFacilityRecordFromBaseRecord>[] }> {
  return enumerateDateRange(range.startDate, range.endDate).map((collectionDate) => {
    const scopedRecords = records.filter((record) => record.collectionDate <= collectionDate);
    if (!scopedRecords.some((record) => record.collectionDate === collectionDate)) {
      throw new BackendAnalysisError(400, 'reanalyze', `no facility records found for collection date ${collectionDate}`);
    }
    return { collectionDate, records: scopedRecords };
  });
}

async function readAllFacilityBaseRecords(
  runtime: LarkOpenApiRuntime,
  input: {
    tableId: string;
    viewId?: string;
    pageSize: number;
  },
): Promise<FacilityBaseRecord[]> {
  const records: FacilityBaseRecord[] = [];
  let pageToken: unknown = undefined;
  do {
    const page = await runtime.readRecordsPage(input.tableId, {
      viewId: input.viewId,
      pageSize: input.pageSize,
      pageToken,
    });
    records.push(...page.records);
    pageToken = page.hasMore ? page.pageToken : undefined;
  } while (pageToken !== undefined && pageToken !== null && pageToken !== '');
  return records;
}

function createRuntimeForBase(
  baseToken: string,
  env: FeishuBaseRuntimeEnv,
  createRuntime: typeof createLarkOpenApiRuntime,
  isInjectedRuntimeFactory: boolean,
): LarkOpenApiRuntime {
  return createRuntime({
    baseToken,
    authCode: isInjectedRuntimeFactory ? 'injected-runtime-auth-code' : requireFeishuBaseAuthCode(env, 'read_source', 'facility analysis runner'),
  });
}

function validateRunRequest(input: FacilityAnalysisRunRequest): void {
  const missing = ['tenantKey', 'baseToken', 'tableId'].filter((key) => !isNonEmptyString(input[key as keyof FacilityAnalysisRunRequest]));
  if (missing.length) {
    throw new BackendAnalysisError(400, 'validate_request', `missing required fields: ${missing.join(', ')}`);
  }
  if (input.reanalyze === true) {
    requireReanalysisDateRange(input.reanalyzeDateRange);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireReanalysisDateRange(
  value: FacilityAnalysisRunRequest['reanalyzeDateRange'],
): { startDate: string; endDate: string } {
  if (!value || !isValidDateOnly(value.startDate) || !isValidDateOnly(value.endDate)) {
    throw new BackendAnalysisError(400, 'validate_request', 'reanalyzeDateRange.startDate and reanalyzeDateRange.endDate must be YYYY-MM-DD');
  }
  if (value.startDate > value.endDate) {
    throw new BackendAnalysisError(400, 'validate_request', 'reanalyzeDateRange.startDate must be on or before reanalyzeDateRange.endDate');
  }
  return value;
}

function enumerateDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const cursor = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(formatDateOnly(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  return formatDateOnly(parseDateOnly(value)) === value;
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateOnly(value: Date): string {
  const year = String(value.getUTCFullYear()).padStart(4, '0');
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
