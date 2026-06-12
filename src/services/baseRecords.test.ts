import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { normalizeReviewRecord, readReviewRecords, type RecordsPageReader } from './baseRecords';

describe('normalizeReviewRecord', () => {
  it('normalizes SDK cell values into ReviewRecord shape', () => {
    const record = normalizeReviewRecord(
      {
        recordId: 'rec27ww4KBxDj2',
        fields: {
          fldVtWzH6z: 1966964079,
          fld2vyUWnW: [{ type: 'text', text: '昆明中维翠湖宾馆' }],
          fld5x0xdlt: 4.7,
          fld75mtSQz: [{ type: 'text', text: '2026-05-31 11:52:33' }],
          fld4GSbB7A: { id: 'opt1', text: '2026-05-01 00:00:00' },
          fld5lYCMLN: null,
          fld1eRxoQS: '商务城景大床房',
          fld5T66ajC: [
            { type: 'text', text: '地理位置无与伦比，' },
            { type: 'text', text: '服务超一流。' },
          ],
        },
      },
      DEFAULT_CONFIG.source.fields,
    );

    expect(record).toEqual({
      recordId: 'rec27ww4KBxDj2',
      reviewId: '1966964079',
      hotelName: '昆明中维翠湖宾馆',
      score: 4.7,
      reviewDate: '2026-05-31 11:52:33',
      checkInMonth: '2026-05-01 00:00:00',
      roomType: '商务城景大床房',
      hasReply: false,
      replyContent: null,
      content: '地理位置无与伦比，服务超一流。',
    });
  });
});

describe('readReviewRecords', () => {
  it('paginates records and drops empty comments', async () => {
    const pages = [
      {
        records: [
          {
            recordId: 'rec1',
            fields: {
              fldVtWzH6z: 1,
              fld2vyUWnW: 'A',
              fld5x0xdlt: 5,
              fld75mtSQz: '2026-06-01 10:00:00',
              fld4GSbB7A: ['2026-06-01 00:00:00'],
              fld5lYCMLN: '谢谢',
              fld1eRxoQS: '大床房',
              fld5T66ajC: '位置很好',
            },
          },
        ],
        hasMore: true,
        pageToken: 2,
      },
      {
        records: [
          {
            recordId: 'rec2',
            fields: {
              fldVtWzH6z: 2,
              fld2vyUWnW: 'A',
              fld5x0xdlt: 4,
              fld75mtSQz: '2026-06-02 10:00:00',
              fld4GSbB7A: ['2026-06-01 00:00:00'],
              fld5lYCMLN: '',
              fld1eRxoQS: '双床房',
              fld5T66ajC: '',
            },
          },
        ],
        hasMore: false,
      },
    ];
    const calls: unknown[] = [];
    const reader: RecordsPageReader = async (params) => {
      calls.push(params);
      return pages.shift()!;
    };

    const records = await readReviewRecords(reader, {
      tableId: DEFAULT_CONFIG.source.tableId,
      viewId: DEFAULT_CONFIG.source.viewId,
      fields: DEFAULT_CONFIG.source.fields,
    });

    expect(records.map((record) => record.recordId)).toEqual(['rec1']);
    expect(calls).toHaveLength(2);
  });
});
