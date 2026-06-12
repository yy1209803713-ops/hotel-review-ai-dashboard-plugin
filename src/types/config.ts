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
  topN: number;
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

export type PluginConfig = {
  version: 1;
  source: {
    tableId: string;
    viewId?: string;
    dataRange?: unknown;
    fields: FieldMapping;
  };
  filters: FilterState;
  ai: AiConfig;
  writeback: WritebackConfig;
  analysisCache?: AnalysisCache;
};
import type { AnalysisResult } from './analysis';
