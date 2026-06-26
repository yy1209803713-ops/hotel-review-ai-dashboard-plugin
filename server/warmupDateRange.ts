import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import { TIME_ZONE } from '../src/services/filtering';
import type { WarmupDateRangeShortcut, WarmupRequest } from './warmupTypes';

dayjs.extend(utc);
dayjs.extend(timezone);

export type WarmupDateRangeInput = Pick<WarmupRequest, 'dateRange' | 'startDate' | 'endDate'>;

export function normalizeWarmupDateRange<T extends WarmupDateRangeInput>(
  request: T,
  now: string | Date = new Date(),
): T {
  const explicitStartDate = request.startDate?.trim();
  const explicitEndDate = request.endDate?.trim();
  if (explicitStartDate || explicitEndDate || request.dateRange !== 'today') {
    return {
      ...request,
      startDate: explicitStartDate || undefined,
      endDate: explicitEndDate || undefined,
    };
  }

  const current = dayjs(now).tz(TIME_ZONE);
  return {
    ...request,
    startDate: current.startOf('day').format('YYYY-MM-DD HH:mm:ss'),
    endDate: current.endOf('day').format('YYYY-MM-DD HH:mm:ss'),
  };
}

export function isWarmupDateRangeShortcut(value: unknown): value is WarmupDateRangeShortcut {
  return value === undefined || value === 'today';
}
