import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import { csvTextToRawReviewRecords, parseCsvRows } from './csvRecords';

const fields = DEFAULT_CONFIG.source.fields;

describe('parseCsvRows', () => {
  it('parses quoted multiline cells and escaped quotes', () => {
    const rows = parseCsvRows('评论ID,评论内容\r\n196,"第一行\n第二行 ""很好"""\r\n');

    expect(rows).toEqual([
      ['评论ID', '评论内容'],
      ['196', '第一行\n第二行 "很好"'],
    ]);
  });
});

describe('csvTextToRawReviewRecords', () => {
  it('maps CSV headers to dashboard field ids', () => {
    const records = csvTextToRawReviewRecords(
      [
        '评论ID,酒店名称,评分,评论日期,入住日期,酒店回复内容,房型,评论内容',
        '1968962901,昆明中维翠湖宾馆,5.0,2026-06-01 17:13:56,2026-05-20 00:00:00,,商务城景双床房,"入住满意\n紧邻翠湖"',
      ].join('\n'),
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      recordId: 'csv-1968962901',
      fields: {
        [fields.reviewId]: '1968962901',
        [fields.hotelName]: '昆明中维翠湖宾馆',
        [fields.score]: 5,
        [fields.reviewDate]: '2026-06-01 17:13:56',
        [fields.checkInMonth]: ['2026-05-01 00:00:00'],
        [fields.replyContent]: '',
        [fields.roomType]: '商务城景双床房',
        [fields.content]: '入住满意\n紧邻翠湖',
      },
    });
  });

  it('reports missing required columns instead of returning partial records', () => {
    expect(() => csvTextToRawReviewRecords('评论ID,评论内容\n1,很好')).toThrow('CSV 缺少必要列：酒店名称');
  });
});
