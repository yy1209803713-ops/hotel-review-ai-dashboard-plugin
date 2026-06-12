import { DEFAULT_CONFIG } from '../constants/defaults';
import type { RawSdkRecord } from './baseRecords';

export const LOCAL_CSV_DATASET_PATH = '/hotel_xx_comments_25_merged_with_names.csv';

const CSV_HEADER_TO_FIELD = {
  reviewId: '评论ID',
  content: '评论内容',
  hotelName: '酒店名称',
  score: '评分',
  reviewDate: '评论日期',
  checkInMonth: '入住日期',
  replyContent: '酒店回复内容',
  roomType: '房型',
} as const;

export function csvTextToRawReviewRecords(text: string): RawSdkRecord[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) {
    throw new Error('CSV 内容为空或缺少数据行');
  }

  const headerIndex = buildHeaderIndex(rows[0]);
  const fields = DEFAULT_CONFIG.source.fields;

  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell.trim()))
    .map((row, rowIndex) => {
      const reviewId = getRequiredCell(row, headerIndex, CSV_HEADER_TO_FIELD.reviewId).trim();
      const checkInMonth = normalizeMonthValue(getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.checkInMonth));
      const score = cellToFiniteNumber(getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.score));

      return {
        recordId: `csv-${reviewId || rowIndex + 1}`,
        fields: {
          [fields.reviewId]: reviewId,
          [fields.hotelName]: getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.hotelName),
          [fields.score]: score,
          [fields.reviewDate]: getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.reviewDate),
          [fields.checkInMonth]: checkInMonth ? [checkInMonth] : [],
          [fields.replyContent]: getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.replyContent),
          [fields.roomType]: getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.roomType),
          [fields.content]: getOptionalCell(row, headerIndex, CSV_HEADER_TO_FIELD.content),
        },
      };
    });
}

export function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  const finishCell = () => {
    row.push(cell);
    cell = '';
  };

  const finishRow = () => {
    finishCell();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell === '') {
      quoted = true;
      continue;
    }

    if (char === ',') {
      finishCell();
      continue;
    }

    if (char === '\n') {
      finishRow();
      continue;
    }

    if (char === '\r') {
      if (input[index + 1] === '\n') {
        index += 1;
      }
      finishRow();
      continue;
    }

    cell += char;
  }

  if (quoted) {
    throw new Error('CSV 解析失败：存在未闭合的引号');
  }

  if (cell || row.length) {
    finishRow();
  }

  return rows;
}

function buildHeaderIndex(headers: string[]): Map<string, number> {
  const headerIndex = new Map(headers.map((header, index) => [header.trim(), index]));

  for (const header of Object.values(CSV_HEADER_TO_FIELD)) {
    if (!headerIndex.has(header)) {
      throw new Error(`CSV 缺少必要列：${header}`);
    }
  }

  return headerIndex;
}

function getRequiredCell(row: string[], headerIndex: Map<string, number>, header: string): string {
  const value = getOptionalCell(row, headerIndex, header);
  if (!value.trim()) {
    throw new Error(`CSV 数据行缺少必要值：${header}`);
  }
  return value;
}

function getOptionalCell(row: string[], headerIndex: Map<string, number>, header: string): string {
  const index = headerIndex.get(header);
  return index === undefined ? '' : row[index] ?? '';
}

function cellToFiniteNumber(value: string): number | string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const numberValue = Number(trimmed);
  return Number.isFinite(numberValue) ? numberValue : trimmed;
}

function normalizeMonthValue(value: string): string {
  const trimmed = value.trim();
  const match = /^(\d{4})[-/](\d{1,2})/.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  const [, year, month] = match;
  return `${year}-${month.padStart(2, '0')}-01 00:00:00`;
}
