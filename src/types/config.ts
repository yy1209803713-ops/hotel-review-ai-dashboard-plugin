import type { IDataRange } from '@lark-base-open/js-sdk';
import type { AnalysisResult } from './analysis';

export type FieldMapping = {
  reviewId: string;
  content: string;
  hotelName: string;
  score: string;
  reviewDate: string;
  checkInMonth: string;
  replyContent: string;
  roomType: string;
};

export type PeriodType = 'today' | 'week' | 'month' | 'custom';

export type ReplyStatusFilter = 'all' | 'replied' | 'unreplied';

export type FilterState = {
  hotelName: string;
  periodType: PeriodType;
  startDate: string;
  endDate: string;
  checkInMonth: string;
  minScore: number | null;
  maxScore: number | null;
  replyStatus: ReplyStatusFilter;
  keyword: string;
};

export type AiConfig = {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxBatchSize: number;
  batchConcurrency?: number;
  requestTimeoutSeconds?: number;
  topN: number;
};

export type BackendConfig = {
  endpointUrl: string;
  baseToken: string;
  configId?: string;
  configVersion?: number;
};

export type WritebackConfig = {
  enabled: boolean;
  confirmed: boolean;
  batchTableId?: string;
  topicTableId?: string;
};

export type AnalysisCache = {
  result: AnalysisResult;
  scopeSnapshot: unknown;
  sourceSnapshot: unknown;
  model: string;
  generatedAt: string;
};

export type SourceConfig = {
  tableId: string;
  viewId?: string;
  dataRange?: IDataRange;
  fields: FieldMapping;
};

export type PluginConfig = {
  version: 1;
  source: SourceConfig;
  filters: FilterState;
  ai: AiConfig;
  backend: BackendConfig;
  warmup: {
    endpointUrl: string;
    secret: string;
  };
  writeback: WritebackConfig;
  analysisCache?: AnalysisCache;
};
