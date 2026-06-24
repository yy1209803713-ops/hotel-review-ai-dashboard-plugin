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
import type { FacilityAnalysisBaseExporter } from './facilityAnalysisBaseExporter';

export type FacilityAnalysisRunRequest = {
  tenantKey: string;
  baseToken: string;
  tableId: string;
  viewId?: string;
  fieldMapping?: Partial<FacilityFieldMapping>;
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
  baseExporter?: FacilityAnalysisBaseExporter;
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
      const result = await analyzeFacilityChanges(records, {
        generatedAt: options.now?.() ?? new Date().toISOString(),
        summarizeChanges,
      });
      const saved = await options.store.saveResult({
        tenantKey: input.tenantKey,
        baseToken: input.baseToken,
        tableId: input.tableId,
        viewId: input.viewId,
        sourceRecordCount: records.length,
        result,
      });
      await options.baseExporter?.export(saved);
      return saved;
    },
  };
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
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
