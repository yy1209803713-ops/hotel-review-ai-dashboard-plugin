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

  it('returns null for empty or invalid values', () => {
    expect(parseReviewDate('')).toBeNull();
    expect(parseReviewDate('not a date')).toBeNull();
  });
});

describe('getPeriodRange', () => {
  it('uses Monday as the first day of week', () => {
    expect(getPeriodRange('week', '2026-06-03T10:00:00+08:00')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-07',
    });
  });

  it('calculates month boundaries in Asia/Shanghai', () => {
    expect(getPeriodRange('month', '2026-06-03T10:00:00+08:00')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
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
});
