import { describe, expect, it } from 'vitest';
import type { FieldMapping, FilterState } from '../types/config';
import type { ReviewRecord } from '../types/analysis';
import { buildScopeSnapshot, calculateOverview, isCacheStale } from './stats';

const records: ReviewRecord[] = [
  {
    recordId: 'rec1',
    reviewId: '1',
    hotelName: 'A',
    score: 4.5,
    reviewDate: '2026-06-01 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: null,
    hasReply: true,
    replyContent: '谢谢',
    content: '位置好',
  },
  {
    recordId: 'rec2',
    reviewId: '2',
    hotelName: 'A',
    score: 5,
    reviewDate: '2026-06-02 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: null,
    hasReply: false,
    replyContent: '',
    content: '服务好',
  },
  {
    recordId: 'rec3',
    reviewId: '3',
    hotelName: 'A',
    score: null,
    reviewDate: '2026-06-03 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: null,
    hasReply: false,
    replyContent: null,
    content: '设施一般',
  },
];

const filters: FilterState = {
  hotelName: 'A',
  periodType: 'month',
  startDate: '',
  endDate: '',
  checkInMonth: 'all',
  minScore: null,
  maxScore: null,
  replyStatus: 'all',
  keyword: '',
};

const fields: FieldMapping = {
  reviewId: 'reviewId',
  content: 'content',
  hotelName: 'hotelName',
  score: 'score',
  reviewDate: 'reviewDate',
  checkInMonth: 'checkInMonth',
  replyContent: 'replyContent',
  roomType: 'roomType',
};

describe('calculateOverview', () => {
  it('calculates total reviews, average score, and reply rate', () => {
    expect(calculateOverview(records)).toMatchObject({
      totalReviews: 3,
      averageScore: 4.75,
      replyRate: 1 / 3,
    });
  });
});

describe('scope snapshots', () => {
  it('captures filters, field mapping, model, count, and record edge IDs', () => {
    expect(buildScopeSnapshot(records, filters, fields, 'gpt-4o-mini')).toEqual({
      filters,
      fields,
      model: 'gpt-4o-mini',
      analysisCopyVersion: 'v1.2-conversational-copy',
      totalReviews: 3,
      firstRecordId: 'rec1',
      lastRecordId: 'rec3',
    });
  });

  it('detects stale cache when filters change', () => {
    const cached = buildScopeSnapshot(records, filters, fields, 'gpt-4o-mini');
    const current = buildScopeSnapshot(
      records,
      { ...filters, keyword: '早餐' },
      fields,
      'gpt-4o-mini',
    );

    expect(isCacheStale(cached, current)).toBe(true);
  });
});
