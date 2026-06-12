import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, REQUIRED_FIELD_KEYS, TOPIC_CATEGORIES } from './defaults';

describe('DEFAULT_CONFIG', () => {
  it('uses the verified hotel review Base table, view, and field mapping', () => {
    expect(DEFAULT_CONFIG.source.tableId).toBe('tbl37qjFGwC2XccK');
    expect(DEFAULT_CONFIG.source.viewId).toBe('vew4P7LY9a');
    expect(DEFAULT_CONFIG.source.fields).toMatchObject({
      reviewId: 'fldVtWzH6z',
      content: 'fld5T66ajC',
      hotelName: 'fld2vyUWnW',
      score: 'fld5x0xdlt',
      reviewDate: 'fld75mtSQz',
      checkInMonth: 'fld4GSbB7A',
      replyContent: 'fld5lYCMLN',
      roomType: 'fld1eRxoQS',
    });
  });

  it('contains every required field mapping key', () => {
    expect(Object.keys(DEFAULT_CONFIG.source.fields).sort()).toEqual([...REQUIRED_FIELD_KEYS].sort());
  });

  it('uses DashScope qwen-plus as the default AI endpoint and model', () => {
    expect(DEFAULT_CONFIG.ai.apiBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(DEFAULT_CONFIG.ai.model).toBe('qwen-plus');
    expect(DEFAULT_CONFIG.ai.apiKey).toMatch(/^sk-/);
  });

  it('keeps the first version category taxonomy fixed', () => {
    expect(TOPIC_CATEGORIES).toEqual([
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
    ]);
  });
});
