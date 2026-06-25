import dayjs, { type Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { FilterState, PeriodType } from '../types/config';
import type { ReviewRecord } from '../types/analysis';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export const TIME_ZONE = 'Asia/Shanghai';

export type ReviewDateRangeBoundary = 'start' | 'end';

const STRICT_DATE_ONLY_FORMAT = 'YYYY-MM-DD';
const STRICT_DATE_TIME_FORMAT = 'YYYY-MM-DD HH:mm:ss';
const STRICT_REVIEW_RANGE_PATTERN = /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/;

const DATE_FORMATS = [
  'YYYY-MM-DD HH:mm:ss',
  'YYYY/MM/DD HH:mm:ss',
  'YYYY-MM-DD HH:mm',
  'YYYY/MM/DD HH:mm',
  'YYYY-M-D HH:mm:ss',
  'YYYY/M/D HH:mm:ss',
  'YYYY-M-D HH:mm',
  'YYYY/M/D HH:mm',
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYY-M-D',
  'YYYY/M/D',
];

export function parseReviewDate(value: string | null | undefined): Dayjs | null {
  const text = value?.trim();
  if (!text) {
    return null;
  }

  for (const format of DATE_FORMATS) {
    const parsed = safeParseTz(text, format);
    if (parsed.isValid()) {
      return parsed;
    }
  }

  const fallback = safeParseTz(text);
  return fallback.isValid() ? fallback : null;
}

export function isReviewDateRangeBoundaryString(value: string): boolean {
  return parseReviewDateRangeBoundary(value, 'start') !== null;
}

export function parseReviewDateRangeBoundary(
  value: string | null | undefined,
  boundary: ReviewDateRangeBoundary,
): Dayjs | null {
  const text = value?.trim();
  if (!text || !STRICT_REVIEW_RANGE_PATTERN.test(text)) {
    return null;
  }

  const parsed = parseStrictReviewRangeBoundary(text);
  if (!parsed) {
    return null;
  }

  if (isStrictDateOnly(text)) {
    return boundary === 'start' ? parsed.startOf('day') : parsed.endOf('day');
  }

  return parsed;
}

export function formatReviewDateRangeBoundary(
  value: string | null | undefined,
  boundary: ReviewDateRangeBoundary,
): string | undefined {
  return parseReviewDateRangeBoundary(value, boundary)?.format(STRICT_DATE_TIME_FORMAT);
}

function safeParseTz(text: string, format?: string): Dayjs {
  try {
    return format ? dayjs.tz(text, format, TIME_ZONE) : dayjs.tz(text, TIME_ZONE);
  } catch {
    return dayjs(Number.NaN);
  }
}

function parseStrictReviewRangeBoundary(text: string): Dayjs | null {
  const format = isStrictDateOnly(text) ? STRICT_DATE_ONLY_FORMAT : STRICT_DATE_TIME_FORMAT;
  const strictParsed = dayjs(text, format, true);
  if (!strictParsed.isValid() || strictParsed.format(format) !== text) {
    return null;
  }
  const parsed = safeParseTz(text, format);
  return parsed.isValid() ? parsed : null;
}

function isStrictDateOnly(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text);
}

export function getPeriodRange(
  periodType: Exclude<PeriodType, 'custom'>,
  now: string | Date | Dayjs = new Date(),
): { startDate: string; endDate: string } {
  const current = dayjs.tz(now, TIME_ZONE);

  if (periodType === 'today') {
    const date = current.format('YYYY-MM-DD');
    return { startDate: date, endDate: date };
  }

  if (periodType === 'week') {
    const start = current.startOf('day').subtract(7, 'day');
    return {
      startDate: start.format('YYYY-MM-DD'),
      endDate: current.format('YYYY-MM-DD'),
    };
  }

  return {
    startDate: current.startOf('day').subtract(1, 'month').format('YYYY-MM-DD'),
    endDate: current.format('YYYY-MM-DD'),
  };
}

export function filterReviews(records: ReviewRecord[], filters: FilterState): ReviewRecord[] {
  const range =
    filters.periodType === 'custom'
      ? { startDate: filters.startDate, endDate: filters.endDate }
      : getPeriodRange(filters.periodType);
  const start = range.startDate ? parseReviewDateRangeBoundary(range.startDate, 'start') : null;
  const end = range.endDate ? parseReviewDateRangeBoundary(range.endDate, 'end') : null;
  const keyword = filters.keyword.trim().toLocaleLowerCase();

  return records.filter((record) => {
    if (!record.content.trim()) {
      return false;
    }

    if (filters.hotelName !== 'all' && record.hotelName !== filters.hotelName) {
      return false;
    }

    if (filters.checkInMonth !== 'all' && record.checkInMonth !== filters.checkInMonth) {
      return false;
    }

    if (filters.minScore !== null && (record.score === null || record.score < filters.minScore)) {
      return false;
    }

    if (filters.maxScore !== null && (record.score === null || record.score > filters.maxScore)) {
      return false;
    }

    if (filters.replyStatus === 'replied' && !record.hasReply) {
      return false;
    }

    if (filters.replyStatus === 'unreplied' && record.hasReply) {
      return false;
    }

    const reviewDate = parseReviewDate(record.reviewDate);
    if ((start || end) && !reviewDate) {
      return false;
    }

    if (start && reviewDate && reviewDate.isBefore(start)) {
      return false;
    }

    if (end && reviewDate && reviewDate.isAfter(end)) {
      return false;
    }

    if (keyword && !record.content.toLocaleLowerCase().includes(keyword)) {
      return false;
    }

    return true;
  });
}
