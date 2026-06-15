import { describe, expect, it } from 'vitest';
import { buildHostDataSignal, parseHostVisibleReviewIds } from './hostDataScope';

describe('hostDataScope', () => {
  it('extracts review IDs from Dashboard grouped data', () => {
    const data = [
      [
        { value: '评论ID', text: '评论ID', groupKey: null },
        { value: '记录数', text: '记录数', groupKey: null },
      ],
      [
        { value: '1001', text: '1001', groupKey: '1001' },
        { value: 1, text: '1', groupKey: null },
      ],
      [
        { value: '1002', text: '1002', groupKey: '1002' },
        { value: 1, text: '1', groupKey: null },
      ],
    ];

    expect(parseHostVisibleReviewIds(data)).toEqual(new Set(['1001', '1002']));
    expect(buildHostDataSignal(data)).toBe('host-visible-review-ids:1001|1002');
  });

  it('falls back to first-cell text and value when group key is empty', () => {
    const data = [
      [{ value: '评论ID', text: '评论ID', groupKey: null }],
      [{ value: '1001', text: '1001', groupKey: null }],
      [{ value: 1002, text: null, groupKey: null }],
    ];

    expect(parseHostVisibleReviewIds(data)).toEqual(new Set(['1001', '1002']));
    expect(buildHostDataSignal(data)).toBe('host-visible-review-ids:1001|1002');
  });

  it('returns null when Dashboard data is not grouped by review ID', () => {
    const data = [
      [{ value: '记录数', text: '记录数', groupKey: null }],
      [{ value: 6070, text: '6070', groupKey: null }],
    ];

    expect(parseHostVisibleReviewIds(data)).toBeNull();
    expect(buildHostDataSignal(data)).toBe('host-data-unsupported');
  });
});
