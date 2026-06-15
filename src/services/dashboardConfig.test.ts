import { SourceType } from '@lark-base-open/js-sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import type { PluginConfig } from '../types/config';
import { buildDataConditions, getPrimaryDataCondition, mergeConfigWithDataCondition } from './dashboardConfig';

describe('dashboardConfig', () => {
  it('builds a minimal COUNTA data condition from plugin source config', () => {
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      source: {
        tableId: 'tbl1',
        viewId: 'vew1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        fields: { ...DEFAULT_CONFIG.source.fields, reviewId: 'fld_review_id' },
      },
    };

    expect(buildDataConditions(config)).toEqual([
      {
        tableId: 'tbl1',
        dataRange: { type: SourceType.VIEW, viewId: 'vew1', viewName: '表格' },
        groups: [{ fieldId: 'fld_review_id' }],
        series: 'COUNTA',
      },
    ]);
  });

  it('merges saved dataConditions back into source config', () => {
    const config = mergeConfigWithDataCondition(DEFAULT_CONFIG, {
      tableId: 'tbl1',
      dataRange: { type: SourceType.ALL },
      series: 'COUNTA',
    });

    expect(config.source.tableId).toBe('tbl1');
    expect(config.source.dataRange).toEqual({ type: SourceType.ALL });
  });

  it('returns null for missing saved data conditions', () => {
    expect(getPrimaryDataCondition({ dataConditions: [] })).toBeNull();
  });
});
