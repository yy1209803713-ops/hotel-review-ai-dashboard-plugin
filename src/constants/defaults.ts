import type { FieldMapping, PluginConfig } from '../types/config';

export const REQUIRED_FIELD_KEYS = [
  'reviewId',
  'content',
  'hotelName',
  'score',
  'reviewDate',
  'checkInMonth',
  'replyContent',
  'roomType',
] as const satisfies readonly (keyof FieldMapping)[];

export const FIELD_LABELS: Record<keyof FieldMapping, string> = {
  reviewId: '评论 ID',
  content: '评论内容',
  hotelName: '酒店名称',
  score: '评分',
  reviewDate: '评论日期',
  checkInMonth: '入住日期',
  replyContent: '回复内容',
  roomType: '房型',
};

export const TOPIC_CATEGORIES = [
  '位置',
  '服务',
  '卫生',
  '设施',
  '餐饮',
  '房型',
  '价格/性价比',
  '交通',
  '回复/售后',
  '其他',
] as const;

export const DEFAULT_CONFIG: PluginConfig = {
  version: 1,
  source: {
    tableId: '',
    viewId: '',
    fields: {
      reviewId: '',
      content: '',
      hotelName: '',
      score: '',
      reviewDate: '',
      checkInMonth: '',
      replyContent: '',
      roomType: '',
    },
  },
  filters: {
    hotelName: 'all',
    periodType: 'month',
    startDate: '',
    endDate: '',
    checkInMonth: 'all',
    minScore: null,
    maxScore: null,
    replyStatus: 'all',
    keyword: '',
  },
  ai: {
    apiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-plus',
    temperature: 0.2,
    maxBatchSize: 10,
    batchConcurrency: 3,
    requestTimeoutSeconds: 600,
    topN: 10,
  },
  warmup: {
    endpointUrl: '',
    secret: '',
  },
  writeback: {
    enabled: false,
    confirmed: false,
  },
};
