import {
  bitable,
  bridge,
  dashboard,
  DashboardState,
  FieldType,
  OperationType,
  PermissionEntity,
  SourceType,
  type ICategory,
  type IDataRange,
} from '@lark-base-open/js-sdk';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { FIXTURE_ANALYSIS_RESULT } from '../fixtures/analysis';
import { FIXTURE_RAW_RECORDS } from '../fixtures/reviews';
import type { RawSdkRecord, RecordsPage } from '../services/baseRecords';
import { csvTextToRawReviewRecords, LOCAL_CSV_DATASET_PATH } from '../services/csvRecords';
import type { PluginConfig } from '../types/config';

const FIXTURE_CONFIG_STORAGE_KEY = 'hotel-review-ai-dashboard:fixture-config';

export type DashboardStateName = 'Create' | 'Config' | 'View' | 'FullScreen';

export type RuntimeConfig = {
  dataConditions: unknown[];
  customConfig?: PluginConfig;
};

export type RuntimeTable = {
  tableId: string;
  tableName: string;
};

export type RuntimeTheme = {
  theme: 'LIGHT' | 'DARK';
  chartBgColor: string;
  labelColorTokenList: string[];
  themePalette: string[];
};

export type DashboardRuntime = {
  isFixture: boolean;
  getState(): DashboardStateName;
  getTheme(): Promise<RuntimeTheme>;
  onThemeChange(callback: (theme: RuntimeTheme) => void): () => void;
  getConfig(): Promise<RuntimeConfig>;
  saveConfig(config: RuntimeConfig): Promise<boolean>;
  onConfigChange(callback: (config: RuntimeConfig) => void): () => void;
  getTableList(): Promise<RuntimeTable[]>;
  getFieldMetaList(tableId: string): Promise<RuntimeCategory[]>;
  getTableDataRange(tableId: string): Promise<IDataRange[] | unknown[]>;
  getCategories(tableId: string): Promise<ICategory[] | RuntimeCategory[]>;
  readRecordsPage(
    tableId: string,
    params: { viewId?: string; pageSize: number; pageToken?: unknown },
  ): Promise<RecordsPage>;
  readRecordsByIds(tableId: string, recordIds: string[]): Promise<RawSdkRecord[]>;
  canEditBase(): Promise<boolean>;
  addTable(name: string, fields: unknown[]): Promise<{ tableId: string }>;
  addRecords(tableId: string, records: Array<{ fields: Record<string, unknown> }>): Promise<string[]>;
  setRendered(): Promise<boolean>;
  getInstanceId(): Promise<string>;
};

export type RuntimeCategory = {
  fieldId: string;
  fieldName: string;
  fieldType: string | number;
};

export function createFixtureRuntime(
  options: { state?: DashboardStateName; records?: RawSdkRecord[]; csvUrl?: string; demoAnalysis?: boolean } = {},
): DashboardRuntime {
  const demoAnalysis = options.demoAnalysis ?? getFixtureDemoFromUrl();
  let config: RuntimeConfig = demoAnalysis ? createFixtureConfig(true) : loadFixtureConfig() ?? createFixtureConfig(false);
  const state = options.state ?? 'View';
  let recordsPromise: Promise<RawSdkRecord[]> | null = null;

  const getLocalRecords = async () => {
    if (options.records) {
      return options.records;
    }
    if (demoAnalysis) {
      return FIXTURE_RAW_RECORDS;
    }

    recordsPromise ??= loadLocalCsvRecords(options.csvUrl ?? LOCAL_CSV_DATASET_PATH);
    return recordsPromise;
  };

  return {
    isFixture: true,
    getState: () => state,
    getTheme: async () => ({
      theme: 'LIGHT',
      chartBgColor: '#ffffff',
      labelColorTokenList: ['#111827', '#6b7280'],
      themePalette: ['#2563eb', '#16a34a', '#dc2626'],
    }),
    onThemeChange: () => () => undefined,
    getConfig: async () => config,
    saveConfig: async (nextConfig) => {
      config = nextConfig;
      saveFixtureConfig(nextConfig);
      return true;
    },
    onConfigChange: () => () => undefined,
    getTableList: async () => [
      {
        tableId: DEFAULT_CONFIG.source.tableId,
        tableName: '酒店评论',
      },
    ],
    getFieldMetaList: async () => fixtureCategories,
    getTableDataRange: async () => [
      { type: SourceType.ALL },
      {
        type: SourceType.VIEW,
        viewId: DEFAULT_CONFIG.source.viewId,
        viewName: '表格',
      },
    ],
    getCategories: async () => fixtureCategories,
    readRecordsPage: async (_tableId, params) => {
      const allRecords = await getLocalRecords();
      const offset = typeof params.pageToken === 'number' ? params.pageToken : 0;
      const records = allRecords.slice(offset, offset + params.pageSize);
      const nextOffset = offset + params.pageSize;
      return {
        records,
        hasMore: nextOffset < allRecords.length,
        pageToken: nextOffset < allRecords.length ? nextOffset : undefined,
      };
    },
    readRecordsByIds: async (_tableId, recordIds) => {
      const allRecords = await getLocalRecords();
      return allRecords.filter((record) => recordIds.includes(record.recordId));
    },
    canEditBase: async () => true,
    addTable: async (name) => ({ tableId: `fixture-${name}` }),
    addRecords: async (_tableId, records) => records.map((_, index) => `fixture-write-${index}`),
    setRendered: async () => true,
    getInstanceId: async () => 'fixture-instance',
  };
}

function createFixtureConfig(includeAnalysisCache: boolean): RuntimeConfig {
  const customConfig: PluginConfig = includeAnalysisCache
    ? {
        ...DEFAULT_CONFIG,
        analysisCache: {
          result: FIXTURE_ANALYSIS_RESULT,
          scopeSnapshot: {
            filters: DEFAULT_CONFIG.filters,
            fields: DEFAULT_CONFIG.source.fields,
            model: DEFAULT_CONFIG.ai.model,
            totalReviews: FIXTURE_ANALYSIS_RESULT.overview.totalReviews,
            firstRecordId: 'rec27ww4KBxDj2',
            lastRecordId: 'recFixtureRisk02',
          },
          sourceSnapshot: DEFAULT_CONFIG.source,
          model: DEFAULT_CONFIG.ai.model,
          generatedAt: FIXTURE_ANALYSIS_RESULT.generatedAt,
        },
      }
    : DEFAULT_CONFIG;

  return {
    dataConditions: [
      {
        tableId: DEFAULT_CONFIG.source.tableId,
        dataRange: {
          type: SourceType.VIEW,
          viewId: DEFAULT_CONFIG.source.viewId,
          viewName: '表格',
        },
        series: 'COUNTA',
      },
    ],
    customConfig,
  };
}

async function loadLocalCsvRecords(csvUrl: string): Promise<RawSdkRecord[]> {
  if (typeof fetch === 'undefined') {
    throw new Error(`本地 CSV 数据源加载失败：当前环境无法请求 ${csvUrl}`);
  }

  let response: Response;
  try {
    response = await fetch(csvUrl, { cache: 'no-store' });
  } catch (error) {
    throw new Error(`本地 CSV 数据源加载失败：${csvUrl} 请求失败，${getErrorMessage(error)}`);
  }

  if (!response.ok) {
    throw new Error(`本地 CSV 数据源加载失败：${csvUrl} 返回 ${response.status} ${response.statusText}`);
  }

  try {
    return csvTextToRawReviewRecords(await response.text());
  } catch (error) {
    throw new Error(`本地 CSV 数据源解析失败：${getErrorMessage(error)}`);
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadFixtureConfig(): RuntimeConfig | null {
  if (typeof localStorage === 'undefined') {
    return null;
  }

  try {
    const rawConfig = localStorage.getItem(FIXTURE_CONFIG_STORAGE_KEY);
    if (!rawConfig) {
      return null;
    }
    const config = JSON.parse(rawConfig) as RuntimeConfig;
    const sanitizedConfig = removeLegacyFixtureAnalysisCache(config);
    if (sanitizedConfig !== config) {
      saveFixtureConfig(sanitizedConfig);
    }
    return sanitizedConfig;
  } catch {
    return null;
  }
}

function removeLegacyFixtureAnalysisCache(config: RuntimeConfig): RuntimeConfig {
  const customConfig = config.customConfig;
  if (!customConfig) {
    return config;
  }

  const cachedResult = customConfig?.analysisCache?.result;
  if (cachedResult?.analysisId !== 'analysis-fixture-20260603' || cachedResult.model !== 'fixture-ai') {
    return config;
  }

  const { analysisCache: _legacyAnalysisCache, ...nextCustomConfig } = customConfig;
  return {
    ...config,
    customConfig: nextCustomConfig,
  };
}

function saveFixtureConfig(config: RuntimeConfig): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  try {
    localStorage.setItem(FIXTURE_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Local fixture persistence is best-effort only.
  }
}

export function createLarkRuntime(): DashboardRuntime {
  return {
    isFixture: false,
    getState: () => dashboard.state as DashboardStateName,
    getTheme: async () => (await dashboard.getTheme()) as RuntimeTheme,
    onThemeChange: (callback) => dashboard.onThemeChange((event) => callback(event.data as RuntimeTheme)),
    getConfig: async () => {
      if (dashboard.state === DashboardState.Create) {
        return {
          dataConditions: [],
          customConfig: DEFAULT_CONFIG,
        };
      }
      return (await dashboard.getConfig()) as RuntimeConfig;
    },
    saveConfig: (config) => dashboard.saveConfig(config as never),
    onConfigChange: (callback) => dashboard.onConfigChange((event) => callback(event.data as RuntimeConfig)),
    getTableList: async () => {
      const tables = await bitable.base.getTableList();
      return Promise.all(
        tables.map(async (table) => ({
          tableId: table.id,
          tableName: await table.getName(),
        })),
      );
    },
    getFieldMetaList: async (tableId) => {
      const table = await bitable.base.getTableById(tableId);
      const fields = await table.getFieldMetaList();
      return fields.map((field) => ({
        fieldId: field.id,
        fieldName: field.name,
        fieldType: field.type,
      }));
    },
    getTableDataRange: (tableId) => dashboard.getTableDataRange(tableId),
    getCategories: (tableId) => dashboard.getCategories(tableId),
    readRecordsPage: async (tableId, params) => {
      const table = await bitable.base.getTableById(tableId);
      const page = await table.getRecordsByPage({
        viewId: params.viewId,
        pageSize: params.pageSize,
        pageToken: params.pageToken as number | undefined,
      });
      return {
        records: page.records as RawSdkRecord[],
        hasMore: page.hasMore,
        pageToken: page.pageToken,
      };
    },
    readRecordsByIds: async (tableId, recordIds) => {
      const table = await bitable.base.getTableById(tableId);
      return (await table.getRecordsByIds(recordIds)) as RawSdkRecord[];
    },
    canEditBase: () =>
      bitable.base.getPermission({
        entity: PermissionEntity.Base,
        type: OperationType.Editable,
      }),
    addTable: (name, fields) => bitable.base.addTable({ name, fields: fields as never }),
    addRecords: async (tableId, records) => {
      const table = await bitable.base.getTableById(tableId);
      return table.addRecords(records as never);
    },
    setRendered: () => dashboard.setRendered(),
    getInstanceId: () => bridge.getInstanceId(),
  };
}

export function createRuntime(): DashboardRuntime {
  return isLikelyInLarkHost() ? createLarkRuntime() : createFixtureRuntime({ state: getFixtureStateFromUrl() });
}

export const runtime = createRuntime();

function isLikelyInLarkHost(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function getFixtureStateFromUrl(): DashboardStateName {
  if (typeof window === 'undefined') {
    return 'View';
  }

  const state = new URLSearchParams(window.location.search).get('state');
  return state === 'Create' || state === 'Config' || state === 'FullScreen' || state === 'View' ? state : 'View';
}

function getFixtureDemoFromUrl(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const demo = new URLSearchParams(window.location.search).get('demo');
  return demo === '1' || demo === 'true';
}

const fixtureCategories: RuntimeCategory[] = [
  { fieldId: DEFAULT_CONFIG.source.fields.reviewId, fieldName: '评论ID', fieldType: FieldType.Number },
  { fieldId: DEFAULT_CONFIG.source.fields.content, fieldName: '评论内容', fieldType: FieldType.Text },
  { fieldId: DEFAULT_CONFIG.source.fields.hotelName, fieldName: '酒店名称', fieldType: FieldType.Text },
  { fieldId: DEFAULT_CONFIG.source.fields.score, fieldName: '评分', fieldType: FieldType.Number },
  { fieldId: DEFAULT_CONFIG.source.fields.reviewDate, fieldName: '评论日期', fieldType: FieldType.Text },
  { fieldId: DEFAULT_CONFIG.source.fields.checkInMonth, fieldName: '入住日期', fieldType: FieldType.SingleSelect },
  { fieldId: DEFAULT_CONFIG.source.fields.replyContent, fieldName: '酒店回复内容', fieldType: FieldType.Text },
  { fieldId: DEFAULT_CONFIG.source.fields.roomType, fieldName: '房型', fieldType: FieldType.Text },
];
