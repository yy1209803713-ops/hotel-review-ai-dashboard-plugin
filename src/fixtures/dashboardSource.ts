import { SourceType } from '@lark-base-open/js-sdk';
import type { PluginConfig } from '../types/config';

export const FIXTURE_SOURCE_CONFIG: PluginConfig['source'] = {
  tableId: 'tbl37qjFGwC2XccK',
  viewId: 'vew4P7LY9a',
  dataRange: {
    type: SourceType.VIEW,
    viewId: 'vew4P7LY9a',
    viewName: '表格',
  },
  fields: {
    reviewId: 'fldVtWzH6z',
    content: 'fld5T66ajC',
    hotelName: 'fld2vyUWnW',
    score: 'fld5x0xdlt',
    reviewDate: 'fld75mtSQz',
    checkInMonth: 'fld4GSbB7A',
    replyContent: 'fld5lYCMLN',
    roomType: 'fld1eRxoQS',
  },
};
