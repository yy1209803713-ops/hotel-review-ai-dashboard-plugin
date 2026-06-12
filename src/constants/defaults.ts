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
    tableId: 'tbl37qjFGwC2XccK',
    viewId: 'vew4P7LY9a',
    fields: {
      reviewId: 'fldVtWzH6z',
      content: 'fld5T66ajC',
      hotelName: 'fld2vyUWnW',
      score: 'fld5x0xdlt',
      reviewDate: 'fld75mtSQz',
      checkInMonth: 'fld4GSbB7A',
      replyContent: 'fld5lYCMLN',
      roomType: 'fld1eRxoQS',
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
    apiKey: 'sk-4190dd08fdf0420786ee73334c187811',
    model: 'qwen-plus',
    temperature: 0.2,
    maxBatchSize: 10,
    batchConcurrency: 3,
    topN: 10,
  },
  writeback: {
    enabled: true,
    confirmed: false,
  },
};
