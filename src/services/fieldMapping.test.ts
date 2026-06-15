import { describe, expect, it } from 'vitest';
import { REQUIRED_FIELD_KEYS } from '../constants/defaults';
import { getMissingRequiredFields, suggestFieldMapping } from './fieldMapping';

describe('suggestFieldMapping', () => {
  it('prefills common Chinese and English aliases', () => {
    const fields = [
      { fieldId: 'fld_id', fieldName: '评论ID', fieldType: 'number' },
      { fieldId: 'fld_content', fieldName: 'comment', fieldType: 'text' },
      { fieldId: 'fld_hotel', fieldName: '酒店', fieldType: 'text' },
      { fieldId: 'fld_score', fieldName: 'rating', fieldType: 'number' },
      { fieldId: 'fld_review_date', fieldName: '评论日期', fieldType: 'text' },
      { fieldId: 'fld_checkin', fieldName: '入住月份', fieldType: 'text' },
      { fieldId: 'fld_reply', fieldName: '回复内容', fieldType: 'text' },
      { fieldId: 'fld_room', fieldName: 'room_type', fieldType: 'text' },
    ];

    expect(suggestFieldMapping(fields)).toEqual({
      reviewId: 'fld_id',
      content: 'fld_content',
      hotelName: 'fld_hotel',
      score: 'fld_score',
      reviewDate: 'fld_review_date',
      checkInMonth: 'fld_checkin',
      replyContent: 'fld_reply',
      roomType: 'fld_room',
    });
  });

  it('reports missing required fields by key', () => {
    const missing = getMissingRequiredFields({
      reviewId: 'fld_id',
      content: '',
      hotelName: 'fld_hotel',
      score: '',
      reviewDate: 'fld_date',
      checkInMonth: 'fld_checkin',
      replyContent: 'fld_reply',
      roomType: 'fld_room',
    });

    expect(missing).toEqual(['content', 'score']);
    expect(REQUIRED_FIELD_KEYS).toContain('content');
  });
});
