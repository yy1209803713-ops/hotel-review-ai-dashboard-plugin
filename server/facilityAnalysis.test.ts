import { describe, expect, it, vi } from 'vitest';
import {
  analyzeFacilityChanges,
  createFacilityRecordFromBaseRecord,
  DEFAULT_FACILITY_FIELD_MAPPING,
  type FacilityBaseRecord,
} from './facilityAnalysis';

describe('analyzeFacilityChanges', () => {
  it('treats breakfast JSON shape shifts as unchanged when the semantic meal values are the same', async () => {
    const summarize = vi.fn(async ({ hotelDiffs }) => ({
      dailySummary: `本次分析${hotelDiffs.length}家酒店：${hotelDiffs.filter((diff) => diff.status === 'unchanged').length}家设施政策无变动，${hotelDiffs.filter((diff) => diff.status === 'changed').length}家有变动，${hotelDiffs.filter((diff) => diff.status === 'new').length}家为新采集。`,
      hotelSummaries: Object.fromEntries(
        hotelDiffs.map((diff) => [
          diff.hotelId,
          diff.status === 'changed'
            ? diff.changes.map((change) => change.description).join('；')
            : diff.status === 'new'
              ? `${diff.hotelName}为新采集，无历史数据。`
              : `${diff.hotelName}设施政策无变动。`,
        ]),
      ),
    }));

    const result = await analyzeFacilityChanges(
      [
        facilityRecord('hotel-a-old', {
          id: 'a-old',
          collectedAt: '2026-06-17 11:41:50',
          hotelId: 'A',
          hotelName: 'A酒店',
          breakfastPrice: '88',
          breakfastTime: '每天07:30-10:00开放',
          breakfastForm: '自助餐，¥88每份',
          breakfastMenu: '西式、中式',
          childBreakfastPolicy: [
            childBreakfastLine('1.2米以下', '免费'),
            childBreakfastLine('1.2–1.4米以下', '¥46/人'),
            childBreakfastLine('1.4米及以上', '¥88/人'),
          ].join('\n'),
          policyJson: withBreakfastPolicyJson([
            { description: '餐食菜品：西式、中式' },
            { description: '餐食形式：', extentions: [{ value: '自助餐，¥88每份' }] },
            { description: '营业时间：每天07:30-10:00开放' },
          ]),
        }),
        facilityRecord('hotel-a-current', {
          id: 'a-current',
          collectedAt: '2026-06-18 17:24:56',
          hotelId: 'A',
          hotelName: 'A酒店',
          policyJson: withBreakfastPolicyJson([
            { description: '类型：自助餐' },
            { description: '菜品：西式、中式' },
            { description: '营业时间：周一至周日07:30-10:00开放' },
            {
              tab: {
                headers: ['儿童身高', '费用'],
                tableItems: [
                  breakfastTabRow(['1.2米以下儿童', '免费']),
                  breakfastTabRow(['1.2–1.4米以下儿童', '¥46/人']),
                  breakfastTabRow(['1.4米及以上儿童', '¥88/人']),
                  breakfastTabRow(['成人', '¥88/人']),
                ],
              },
            },
          ]),
        }),
        facilityRecord('hotel-b-old', {
          id: 'b-old',
          collectedAt: '2026-06-17 11:09:05',
          hotelId: 'B',
          hotelName: 'B酒店',
          breakfastPrice: '36',
          breakfastTime: '每天07:30-10:00开放',
          breakfastForm: '自助餐，¥36每份',
          breakfastMenu: '中式',
          childBreakfastPolicy: [childBreakfastLine('1-12岁', '免费'), childBreakfastLine('13-17岁', '¥36/人')].join('\n'),
          policyJson: withBreakfastPolicyJson([
            { description: '餐食菜品：中式' },
            { description: '餐食形式：', extentions: [{ value: '自助餐，¥36每份' }] },
            { description: '营业时间：每天07:30-10:00开放' },
          ]),
        }),
        facilityRecord('hotel-b-current', {
          id: 'b-current',
          collectedAt: '2026-06-18 16:55:02',
          hotelId: 'B',
          hotelName: 'B酒店',
          policyJson: withBreakfastPolicyJson([
            { description: '类型：自助餐' },
            { description: '菜品：中式、当地风味' },
            { description: '营业时间：周一至周日07:30-10:00开放' },
            {
              tab: {
                headers: ['年龄', '费用'],
                tableItems: [
                  breakfastTabRow(['1-12岁儿童', '免费']),
                  breakfastTabRow(['13-17岁儿童', '¥36/人']),
                  breakfastTabRow(['成人', '¥36/人']),
                ],
              },
            },
          ]),
        }),
      ],
      {
        generatedAt: '2026-06-18T17:00:00.000+08:00',
        summarizeChanges: summarize,
      },
    );

    expect(result.summary).toMatchObject({
      collectionDate: '2026-06-18',
      currentHotelCount: 2,
      unchangedHotelCount: 1,
      changedHotelCount: 1,
      newHotelCount: 0,
    });
    expect(result.dailySummary).toBe('本次分析2家酒店：1家设施政策无变动，1家有变动，0家为新采集。');
    expect(result.hotelDiffs.map((diff) => [diff.hotelId, diff.status])).toEqual([
      ['A', 'unchanged'],
      ['B', 'changed'],
    ]);
    expect(result.hotelDiffs.find((diff) => diff.hotelId === 'A')).toMatchObject({
      changes: [],
    });
    expect(result.hotelDiffs.find((diff) => diff.hotelId === 'B')).toMatchObject({
      status: 'changed',
      changes: [
        expect.objectContaining({
          field: '早餐菜品',
          before: '中式',
          after: '中式、当地风味',
        }),
      ],
    });
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('treats reordered multi-segment breakfast schedules as unchanged', async () => {
    const result = await analyzeFacilityChanges(
      [
        facilityRecord('schedule-old', {
          id: 'schedule-old',
          collectedAt: '2026-06-17 11:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          breakfastTime: '周一至周五07:00-10:30开放 周六、周日07:00-11:00开放',
        }),
        facilityRecord('schedule-current', {
          id: 'schedule-current',
          collectedAt: '2026-06-18 11:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          breakfastTime: '周六至周日07:00-11:00开放 周一至周五07:00-10:30开放',
        }),
      ],
      {
        generatedAt: '2026-06-18T11:05:00.000+08:00',
        summarizeChanges: async ({ hotelDiffs }) => ({
          dailySummary: '',
          hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, defaultTestSummary(diff.status)])),
        }),
      },
    );

    expect(result.hotelDiffs[0]).toMatchObject({
      status: 'unchanged',
      changes: [],
    });
  });

  it('ignores facility metadata changes when the visible business value is unchanged', async () => {
    const result = await analyzeFacilityChanges(
      [
        facilityRecord('facility-old', {
          id: 'facility-old',
          collectedAt: '2026-06-17 11:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          facilityJson: withFacilityList([{ code: 401, title: '室外泳池', showTitle: '免费', showStyle: 'plain' }]),
        }),
        facilityRecord('facility-current', {
          id: 'facility-current',
          collectedAt: '2026-06-18 11:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          facilityJson: withFacilityList([{ code: 401, title: '室外泳池', showTitle: '免费', showStyle: 'badge' }]),
        }),
      ],
      {
        generatedAt: '2026-06-18T11:05:00.000+08:00',
        summarizeChanges: async ({ hotelDiffs }) => ({
          dailySummary: '',
          hotelSummaries: Object.fromEntries(hotelDiffs.map((diff) => [diff.hotelId, defaultTestSummary(diff.status)])),
        }),
      },
    );

    expect(result.hotelDiffs[0]).toMatchObject({
      status: 'unchanged',
      changes: [],
    });
  });

  it('compares the latest collection with each hotel previous snapshot and ignores JSON order changes', async () => {
    const summarize = vi.fn(async ({ hotelDiffs }) => ({
      dailySummary: '模型误写：本次分析999家酒店。',
      hotelSummaries: Object.fromEntries(
        hotelDiffs.map((diff) => [
          diff.hotelId,
          diff.status === 'new'
            ? `${diff.hotelName}为新采集，无历史数据。`
            : diff.changes.map((change) => change.description).join('；'),
        ]),
      ),
    }));

    const result = await analyzeFacilityChanges(
      [
        facilityRecord('rec-a-old', {
          id: 'old-a',
          collectedAt: '2026-06-13 12:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          breakfastPrice: '58',
          facilityJson: withFacilityList([
            { code: 100, title: '无线WIFI免费' },
            { code: 101, title: '行李寄存' },
          ]),
        }),
        facilityRecord('rec-a-current', {
          id: 'current-a',
          collectedAt: '2026-06-23 12:00:00',
          hotelId: 'A',
          hotelName: 'A酒店',
          breakfastPrice: '68',
          facilityJson: withFacilityList([
            { code: 101, title: '行李寄存' },
            { code: 100, title: '无线WIFI免费' },
          ]),
        }),
        facilityRecord('rec-b-old', {
          id: 'old-b',
          collectedAt: '2026-06-22 12:00:00',
          hotelId: 'B',
          hotelName: 'B酒店',
          facilityJson: withFacilityList([{ code: 100, title: '无线WIFI免费' }]),
        }),
        facilityRecord('rec-b-current', {
          id: 'current-b',
          collectedAt: '2026-06-23 12:00:00',
          hotelId: 'B',
          hotelName: 'B酒店',
          facilityJson: withFacilityList([
            { code: 100, title: '无线WIFI免费' },
            { code: 201, title: '代客泊车服务' },
          ]),
        }),
        facilityRecord('rec-c-current', {
          id: 'current-c',
          collectedAt: '2026-06-23 12:00:00',
          hotelId: 'C',
          hotelName: 'C酒店',
          facilityJson: withFacilityList([{ code: 300, title: '餐厅' }]),
        }),
        facilityRecord('rec-d-old', {
          id: 'old-d',
          collectedAt: '2026-06-21 12:00:00',
          hotelId: 'D',
          hotelName: 'D酒店',
          facilityJson: withFacilityList([
            { code: 401, title: '健身室', info: [{ title: '营业时间', text: ['08:00-22:00'] }] },
            { code: 402, title: '会议厅', showTitle: '收费' },
          ]),
        }),
        facilityRecord('rec-d-current', {
          id: 'current-d',
          collectedAt: '2026-06-23 12:00:00',
          hotelId: 'D',
          hotelName: 'D酒店',
          facilityJson: withFacilityList([
            { code: 402, title: '会议厅', showTitle: '收费' },
            { code: 401, title: '健身室', info: [{ text: ['08:00-22:00'], title: '营业时间' }] },
          ]),
        }),
      ],
      {
        generatedAt: '2026-06-23T12:05:00.000+08:00',
        summarizeChanges: summarize,
      },
    );

    expect(result.summary).toMatchObject({
      collectionDate: '2026-06-23',
      currentHotelCount: 4,
      unchangedHotelCount: 1,
      changedHotelCount: 2,
      newHotelCount: 1,
    });
    expect(result.dailySummary).toBe('本次分析4家酒店：1家设施政策无变动，2家有变动，1家为新采集。');
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.hotelDiffs.map((diff) => [diff.hotelId, diff.status])).toEqual([
      ['A', 'changed'],
      ['B', 'changed'],
      ['C', 'new'],
      ['D', 'unchanged'],
    ]);
    expect(result.hotelDiffs.find((diff) => diff.hotelId === 'A')).toMatchObject({
      previousCollectedAt: '2026-06-13T12:00:00.000',
      currentCollectedAt: '2026-06-23T12:00:00.000',
      changes: [
        expect.objectContaining({
          kind: 'field_changed',
          field: '早餐价格',
          before: '58',
          after: '68',
          description: '早餐价格由58调整为68',
        }),
      ],
    });
    expect(result.hotelDiffs.find((diff) => diff.hotelId === 'B')?.changes).toEqual([
      expect.objectContaining({
        kind: 'facility_added',
        field: '酒店设施',
        after: '代客泊车服务',
        description: '新增酒店设施：代客泊车服务',
      }),
    ]);
    const newHotelDiff = result.hotelDiffs.find((diff) => diff.hotelId === 'C');
    expect(newHotelDiff).toMatchObject({
      status: 'new',
      aiSummary: 'C酒店为新采集，无历史数据。',
    });
    expect(newHotelDiff).not.toHaveProperty('previousRecordId');
    expect(result.hotelDiffs.find((diff) => diff.hotelId === 'D')).toMatchObject({
      status: 'unchanged',
      changes: [],
    });
  });
});

describe('createFacilityRecordFromBaseRecord', () => {
  it('maps Feishu Base fields by the existing runtime field payload', () => {
    const raw: FacilityBaseRecord = {
      recordId: 'rec-1',
      fields: {
        id: '2026062300001',
        采集日期: '2026-06-23',
        采集时间: '2026-06-23 12:00:00',
        酒店ID: 4016733,
        酒店名称: '昆明索菲特大酒店',
        早餐价格: '198',
        酒店设施JSON: withFacilityList([{ code: 201, title: '代客泊车服务' }]),
      },
    };

    expect(createFacilityRecordFromBaseRecord(raw, DEFAULT_FACILITY_FIELD_MAPPING)).toMatchObject({
      recordId: 'rec-1',
      sourceRowId: '2026062300001',
      hotelId: '4016733',
      hotelName: '昆明索菲特大酒店',
      collectionDate: '2026-06-23',
      collectedAt: '2026-06-23T12:00:00.000',
      policyFields: {
        早餐价格: '198',
      },
      facilityItems: [
        expect.objectContaining({
          key: 'code:201',
          title: '代客泊车服务',
        }),
      ],
    });
  });

  it('ignores invalid optional raw JSON fields and keeps structured fields usable', () => {
    const raw: FacilityBaseRecord = {
      recordId: 'rec-invalid-json',
      fields: {
        id: '2026062300002',
        采集日期: '2026-06-23',
        采集时间: '2026-06-23 12:00:00',
        酒店ID: 102536202,
        酒店名称: '昆明翠湖丽瑞德酒店',
        早餐菜品: '中式、西式',
        酒店政策JSON: '"icon":"broken"',
      },
    };

    expect(createFacilityRecordFromBaseRecord(raw, DEFAULT_FACILITY_FIELD_MAPPING)).toMatchObject({
      recordId: 'rec-invalid-json',
      hotelId: '102536202',
      policyFields: {
        早餐菜品: '中式、西式',
      },
      rawPolicyJson: undefined,
    });
  });
});

function facilityRecord(
  recordId: string,
  input: {
    id: string;
    collectedAt: string;
    hotelId: string;
    hotelName: string;
    breakfastPrice?: string;
    breakfastTime?: string;
    breakfastForm?: string;
    breakfastMenu?: string;
    childBreakfastPolicy?: string;
    facilityJson?: string;
    policyJson?: string;
  },
) {
  return createFacilityRecordFromBaseRecord(
    {
      recordId,
      fields: {
        id: input.id,
        采集日期: input.collectedAt.slice(0, 10),
        采集时间: input.collectedAt,
        酒店ID: input.hotelId,
        酒店名称: input.hotelName,
        早餐价格: input.breakfastPrice ?? null,
        早餐营业时间: input.breakfastTime ?? null,
        早餐形式: input.breakfastForm ?? null,
        早餐菜品: input.breakfastMenu ?? null,
        儿童早餐政策: input.childBreakfastPolicy ?? null,
        酒店设施JSON: input.facilityJson ?? null,
        酒店政策JSON: input.policyJson ?? null,
      },
    },
    DEFAULT_FACILITY_FIELD_MAPPING,
  );
}

function withBreakfastPolicyJson(
  content: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({
    hotelPolicyInfo: {
      breakfast: {
        title: '早餐',
        icon: 'https://pages.c-ctrip.com/wireless-app/icons/icon-df-breakfast.png',
        boldIcon: 'info',
        content,
      },
    },
  });
}

function breakfastTabRow(values: [string, string]): { tableDetails: Array<{ content: string; highLight: string; bold: string }> } {
  return {
    tableDetails: values.map((value) => ({
      content: value,
      highLight: value === '免费' ? '免费' : '',
      bold: value,
    })),
  };
}

function childBreakfastLine(label: string, fee: string): string {
  return `年龄: ${label} | 费用: ${fee}`;
}

function withFacilityList(
  items: Array<{
    code?: number;
    title: string;
    showTitle?: string;
    showStyle?: string;
    info?: Array<{ title?: string; text?: string[] }>;
  }>,
): string {
  return JSON.stringify({
    hotelFacilityPop: {
      hotelPopularFacility: {
        title: '设施服务',
        list: items.map((item) => ({
          title: item.title,
          code: item.code,
          showTitle: item.showTitle ?? '',
          showStyle: item.showStyle ?? '',
          facilityInfo: item.info ?? [],
        })),
      },
    },
  });
}

function defaultTestSummary(status: string): string {
  return status === 'unchanged' ? '设施政策无变动。' : status === 'new' ? '新采集，无历史数据。' : '有变动。';
}
