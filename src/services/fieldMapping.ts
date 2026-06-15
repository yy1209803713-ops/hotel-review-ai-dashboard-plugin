import { REQUIRED_FIELD_KEYS } from '../constants/defaults';
import type { FieldMapping } from '../types/config';
import type { RuntimeCategory } from '../runtime/sdk';

const FIELD_ALIASES: Record<keyof FieldMapping, string[]> = {
  reviewId: ['评论id', '评论ID', '评论 ID', 'reviewId', 'review_id', 'id'],
  content: ['评论内容', '内容', 'comment', 'content', 'review'],
  hotelName: ['酒店名称', '酒店', 'hotelName', 'hotel_name', 'hotel'],
  score: ['评分', 'score', 'rating'],
  reviewDate: ['评论日期', '评论时间', 'reviewDate', 'review_date', 'commentDate'],
  checkInMonth: ['入住日期', '入住月份', 'checkInMonth', 'check_in_month', 'checkInDate'],
  replyContent: ['酒店回复内容', '回复内容', 'replyContent', 'reply'],
  roomType: ['房型', 'roomType', 'room_type'],
};

export function suggestFieldMapping(fields: RuntimeCategory[]): FieldMapping {
  const normalizedFields = new Map(fields.map((field) => [normalizeFieldName(field.fieldName), field.fieldId]));
  return Object.fromEntries(
    REQUIRED_FIELD_KEYS.map((key) => {
      const match = FIELD_ALIASES[key].map(normalizeFieldName).find((alias) => normalizedFields.has(alias));
      return [key, match ? normalizedFields.get(match) ?? '' : ''];
    }),
  ) as FieldMapping;
}

export function getMissingRequiredFields(fields: FieldMapping): Array<keyof FieldMapping> {
  return REQUIRED_FIELD_KEYS.filter((key) => !fields[key]?.trim());
}

function normalizeFieldName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '');
}
