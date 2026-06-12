import { DEFAULT_CONFIG } from '../constants/defaults';
import type { RawSdkRecord } from '../services/baseRecords';

const fields = DEFAULT_CONFIG.source.fields;

export const FIXTURE_RAW_RECORDS: RawSdkRecord[] = [
  {
    recordId: 'rec27ww4KBxDj2',
    fields: {
      [fields.reviewId]: 1966964079,
      [fields.hotelName]: '昆明中维翠湖宾馆',
      [fields.score]: 4.7,
      [fields.reviewDate]: '2026-05-31 11:52:33',
      [fields.checkInMonth]: ['2026-05-01 00:00:00'],
      [fields.replyContent]: '',
      [fields.roomType]: '商务城景大床房',
      [fields.content]:
        '地理位置无与伦比，历史文化底蕴丰厚，服务超一流。设施维护不错，但时间痕迹偶尔会冒出来。',
    },
  },
  {
    recordId: 'rec27ww4KBxDCf',
    fields: {
      [fields.reviewId]: 1967821995,
      [fields.hotelName]: '昆明中维翠湖宾馆',
      [fields.score]: 5,
      [fields.reviewDate]: '2026-05-31 20:08:38',
      [fields.checkInMonth]: ['2026-05-01 00:00:00'],
      [fields.replyContent]: '感谢您对翠湖宾馆的认可，期待再次光临。',
      [fields.roomType]: '商务城景双床房',
      [fields.content]: '前台小王没有一点懈怠，很满意。过条小马路就是翠湖公园了，位置没得说。',
    },
  },
  {
    recordId: 'rec27ww4KBxE2y',
    fields: {
      [fields.reviewId]: 1967948211,
      [fields.hotelName]: '昆明中维翠湖宾馆',
      [fields.score]: 5,
      [fields.reviewDate]: '2026-05-31 22:59:41',
      [fields.checkInMonth]: ['2026-05-01 00:00:00'],
      [fields.replyContent]: '',
      [fields.roomType]: '商务城景大床房',
      [fields.content]:
        '老牌子五星酒店，设施有点老但感觉很舒服。离翠湖踏脚就到，早餐米线非常好吃，银耳汤很好喝。',
    },
  },
  {
    recordId: 'recFixtureRisk01',
    fields: {
      [fields.reviewId]: 1969000001,
      [fields.hotelName]: '昆明中维翠湖宾馆',
      [fields.score]: 3.2,
      [fields.reviewDate]: '2026-06-02 08:20:00',
      [fields.checkInMonth]: ['2026-06-01 00:00:00'],
      [fields.replyContent]: '',
      [fields.roomType]: '豪华大床房',
      [fields.content]: '位置不错，但莲蓬老化，洗漱不方便，枕头也不舒服。',
    },
  },
  {
    recordId: 'recFixtureRisk02',
    fields: {
      [fields.reviewId]: 1969000002,
      [fields.hotelName]: '昆明中维翠湖宾馆',
      [fields.score]: 4.8,
      [fields.reviewDate]: '2026-06-03 09:05:00',
      [fields.checkInMonth]: ['2026-06-01 00:00:00'],
      [fields.replyContent]: '',
      [fields.roomType]: '商务城景双床房',
      [fields.content]: '整体满意，服务热情，出行方便。不过毛巾感觉潮，第二天没有及时更换。',
    },
  },
];
