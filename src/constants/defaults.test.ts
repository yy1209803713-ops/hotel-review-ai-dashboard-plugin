import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, REQUIRED_FIELD_KEYS, TOPIC_CATEGORIES } from './defaults';

describe('DEFAULT_CONFIG', () => {
  it('starts with an empty source config for real dashboard setup', () => {
    expect(DEFAULT_CONFIG.source.tableId).toBe('');
    expect(DEFAULT_CONFIG.source.viewId).toBe('');
    expect(Object.values(DEFAULT_CONFIG.source.fields)).toEqual(['', '', '', '', '', '', '', '']);
  });

  it('contains every required field mapping key', () => {
    expect(Object.keys(DEFAULT_CONFIG.source.fields).sort()).toEqual([...REQUIRED_FIELD_KEYS].sort());
  });

  it('does not ship a hardcoded API key', () => {
    expect(DEFAULT_CONFIG.ai.apiBaseUrl).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(DEFAULT_CONFIG.ai.model).toBe('qwen-plus');
    expect(DEFAULT_CONFIG.ai.apiKey).toBe('');
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
