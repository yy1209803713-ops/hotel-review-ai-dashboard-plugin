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

const DATE_FORMATS = ['YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm:ss', 'YYYY-MM-DD', 'YYYY/MM/DD'];

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

function safeParseTz(text: string, format?: string): Dayjs {
  try {
    return format ? dayjs.tz(text, format, TIME_ZONE) : dayjs.tz(text, TIME_ZONE);
  } catch {
    return dayjs(Number.NaN);
  }
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
    const mondayOffset = (current.day() + 6) % 7;
    const start = current.startOf('day').subtract(mondayOffset, 'day');
    return {
      startDate: start.format('YYYY-MM-DD'),
      endDate: start.add(6, 'day').format('YYYY-MM-DD'),
    };
  }

  return {
    startDate: current.startOf('month').format('YYYY-MM-DD'),
    endDate: current.endOf('month').format('YYYY-MM-DD'),
  };
}

export function filterReviews(records: ReviewRecord[], filters: FilterState): ReviewRecord[] {
  const range =
    filters.periodType === 'custom'
      ? { startDate: filters.startDate, endDate: filters.endDate }
      : getPeriodRange(filters.periodType);
  const start = range.startDate ? dayjs.tz(`${range.startDate} 00:00:00`, 'YYYY-MM-DD HH:mm:ss', TIME_ZONE) : null;
  const end = range.endDate ? dayjs.tz(`${range.endDate} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', TIME_ZONE) : null;
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
