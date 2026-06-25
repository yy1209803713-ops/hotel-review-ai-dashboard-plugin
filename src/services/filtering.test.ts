import { describe, expect, it } from 'vitest';
import type { FilterState } from '../types/config';
import type { ReviewRecord } from '../types/analysis';
import { filterReviews, getPeriodRange, parseReviewDate } from './filtering';

const baseFilters: FilterState = {
  hotelName: 'all',
  periodType: 'month',
  startDate: '',
  endDate: '',
  checkInMonth: 'all',
  minScore: null,
  maxScore: null,
  replyStatus: 'all',
  keyword: '',
};

const records: ReviewRecord[] = [
  {
    recordId: 'rec1',
    reviewId: '1966964079',
    hotelName: '昆明中维翠湖宾馆',
    score: 4.7,
    reviewDate: '2026-05-31 11:52:33',
    checkInMonth: '2026-05-01 00:00:00',
    roomType: '商务城景大床房',
    hasReply: false,
    replyContent: '',
    content: '地理位置无与伦比，服务超一流，但设施有时间痕迹。',
  },
  {
    recordId: 'rec2',
    reviewId: '1968962901',
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-01 17:13:56',
    checkInMonth: '2026-05-01 00:00:00',
    roomType: '商务城景双床房',
    hasReply: true,
    replyContent: '感谢您的认可',
    content: '房间干净舒适，紧邻翠湖，出行方便。',
  },
  {
    recordId: 'rec3',
    reviewId: '1969000000',
    hotelName: '其他酒店',
    score: 3.2,
    reviewDate: '2026-06-02 08:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '标准间',
    hasReply: false,
    replyContent: null,
    content: '卫生一般，枕头不舒服。',
  },
];

describe('parseReviewDate', () => {
  it('parses text timestamps as Asia/Shanghai dates', () => {
    expect(parseReviewDate('2026-05-31 11:52:33')?.format('YYYY-MM-DD HH:mm:ss')).toBe(
      '2026-05-31 11:52:33',
    );
  });

  it('parses compact timestamps without leading zeros or seconds', () => {
    expect(parseReviewDate('2026/6/12 16:01')?.format('YYYY-MM-DD HH:mm:ss')).toBe(
      '2026-06-12 16:01:00',
    );
    expect(parseReviewDate('2026/6/11 7:07')?.format('YYYY-MM-DD HH:mm:ss')).toBe(
      '2026-06-11 07:07:00',
    );
  });

  it('returns null for empty or invalid values', () => {
    expect(parseReviewDate('')).toBeNull();
    expect(parseReviewDate('not a date')).toBeNull();
  });
});

describe('getPeriodRange', () => {
  it('calculates the trailing week ending today in Asia/Shanghai', () => {
    expect(getPeriodRange('week', '2026-06-03T10:00:00+08:00')).toEqual({
      startDate: '2026-05-27',
      endDate: '2026-06-03',
    });
  });

  it('calculates the trailing month ending today in Asia/Shanghai', () => {
    expect(getPeriodRange('month', '2026-06-03T10:00:00+08:00')).toEqual({
      startDate: '2026-05-03',
      endDate: '2026-06-03',
    });
  });
});

describe('filterReviews', () => {
  it('applies hotel, period, check-in month, score, reply status, and keyword filters together', () => {
    const filtered = filterReviews(records, {
      ...baseFilters,
      hotelName: '昆明中维翠湖宾馆',
      periodType: 'custom',
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      checkInMonth: '2026-05-01 00:00:00',
      minScore: 4.8,
      maxScore: 5,
      replyStatus: 'replied',
      keyword: '翠湖',
    });

    expect(filtered.map((record) => record.recordId)).toEqual(['rec2']);
  });

  it('keeps high-score mixed comments when they match negative keywords', () => {
    const filtered = filterReviews(records, {
      ...baseFilters,
      periodType: 'custom',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      keyword: '设施',
    });

    expect(filtered.map((record) => record.recordId)).toEqual(['rec1']);
  });

  it('uses second-precision custom date-time boundaries when provided', () => {
    const timedRecords: ReviewRecord[] = [
      { ...records[0], recordId: 'before', reviewDate: '2026-05-01 09:59:59' },
      { ...records[0], recordId: 'start', reviewDate: '2026-05-01 10:00:00' },
      { ...records[0], recordId: 'middle', reviewDate: '2026-05-01 10:30:00' },
      { ...records[0], recordId: 'end', reviewDate: '2026-05-01 11:00:00' },
      { ...records[0], recordId: 'after', reviewDate: '2026-05-01 11:00:01' },
    ];

    const filtered = filterReviews(timedRecords, {
      ...baseFilters,
      periodType: 'custom',
      startDate: '2026-05-01 10:00:00',
      endDate: '2026-05-01 11:00:00',
    });

    expect(filtered.map((record) => record.recordId)).toEqual(['start', 'middle', 'end']);
  });
});
