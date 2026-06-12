import type { FieldMapping } from '../types/config';
import type { ReviewRecord } from '../types/analysis';

export type RawSdkRecord = {
  recordId: string;
  fields: Record<string, unknown>;
};

export type RecordsPage = {
  records: RawSdkRecord[];
  hasMore: boolean;
  pageToken?: unknown;
};

export type RecordsPageReader = (params: {
  tableId: string;
  viewId?: string;
  pageSize: number;
  pageToken?: unknown;
}) => Promise<RecordsPage>;

export type ReadReviewRecordsParams = {
  tableId: string;
  viewId?: string;
  fields: FieldMapping;
  pageSize?: number;
};

export async function readReviewRecords(
  reader: RecordsPageReader,
  params: ReadReviewRecordsParams,
): Promise<ReviewRecord[]> {
  const records: ReviewRecord[] = [];
  let pageToken: unknown;

  do {
    const page = await reader({
      tableId: params.tableId,
      viewId: params.viewId,
      pageSize: params.pageSize ?? 200,
      pageToken,
    });

    for (const rawRecord of page.records) {
      const record = normalizeReviewRecord(rawRecord, params.fields);
      if (record.content.trim()) {
        records.push(record);
      }
    }

    pageToken = page.pageToken;
    if (!page.hasMore) {
      break;
    }
  } while (pageToken !== undefined && pageToken !== null);

  return records;
}

export function normalizeReviewRecord(record: RawSdkRecord, fields: FieldMapping): ReviewRecord {
  const replyContent = cellToText(record.fields[fields.replyContent]);

  return {
    recordId: record.recordId,
    reviewId: cellToText(record.fields[fields.reviewId]) ?? record.recordId,
    hotelName: cellToText(record.fields[fields.hotelName]) ?? '',
    score: cellToNumber(record.fields[fields.score]),
    reviewDate: cellToText(record.fields[fields.reviewDate]),
    checkInMonth: cellToFirstText(record.fields[fields.checkInMonth]),
    roomType: cellToText(record.fields[fields.roomType]),
    hasReply: Boolean(replyContent?.trim()),
    replyContent,
    content: cellToText(record.fields[fields.content]) ?? '',
  };
}

export function cellToText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .map((item) => cellToText(item))
      .filter((item): item is string => item !== null)
      .join('');
    return text || null;
  }

  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    if (typeof objectValue.text === 'string') {
      return objectValue.text;
    }
    if (typeof objectValue.name === 'string') {
      return objectValue.name;
    }
  }

  return null;
}

function cellToFirstText(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = cellToText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }

  return cellToText(value);
}

function cellToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const text = cellToText(value);
  if (!text) {
    return null;
  }

  const numberValue = Number(text);
  return Number.isFinite(numberValue) ? numberValue : null;
}
