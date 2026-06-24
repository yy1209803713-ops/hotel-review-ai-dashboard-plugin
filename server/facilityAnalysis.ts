import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from './backendAnalysis';

export type FacilityBaseRecord = {
  recordId: string;
  fields: Record<string, unknown>;
};

export type FacilityFieldMapping = {
  sourceRowId: string;
  collectionDate: string;
  collectedAt: string;
  hotelId: string;
  hotelName: string;
  detailUrl: string;
  facilityJson: string;
  policyJson: string;
  facilityText: string;
  policyText: string;
  policyFields: string[];
  booleanFields: string[];
};

export type FacilityItem = {
  key: string;
  title: string;
  category?: string;
  detail?: string;
  canonical: JsonValue;
};

type BreakfastSemanticFields = Partial<Record<
  '早餐菜品' | '早餐形式' | '早餐价格' | '早餐营业时间' | '儿童早餐政策',
  string
>>;

const BREAKFAST_SEMANTIC_FIELD_NAMES = new Set<keyof BreakfastSemanticFields>([
  '早餐菜品',
  '早餐形式',
  '早餐价格',
  '早餐营业时间',
  '儿童早餐政策',
]);

export type FacilityRecord = {
  recordId: string;
  sourceRowId: string;
  collectionDate: string;
  collectedAt: string;
  hotelId: string;
  hotelName: string;
  detailUrl?: string;
  policyFields: Record<string, string>;
  booleanFields: Record<string, string>;
  facilityItems: FacilityItem[];
  rawFacilityJson?: JsonValue;
  rawPolicyJson?: JsonValue;
  contentHash: string;
};

export type FacilityChangeKind =
  | 'field_changed'
  | 'field_added'
  | 'field_removed'
  | 'facility_added'
  | 'facility_removed'
  | 'facility_changed';

export type FacilityChange = {
  kind: FacilityChangeKind;
  field: string;
  before?: string;
  after?: string;
  description: string;
};

export type FacilityHotelDiffStatus = 'new' | 'unchanged' | 'changed';

export type FacilityHotelDiff = {
  hotelId: string;
  hotelName: string;
  status: FacilityHotelDiffStatus;
  currentRecordId: string;
  previousRecordId?: string;
  currentCollectedAt: string;
  previousCollectedAt?: string;
  daysSincePrevious?: number;
  changes: FacilityChange[];
  aiSummary?: string;
};

export type FacilityAnalysisResult = {
  analysisId: string;
  generatedAt: string;
  collectionDate: string;
  summary: {
    collectionDate: string;
    currentHotelCount: number;
    unchangedHotelCount: number;
    changedHotelCount: number;
    newHotelCount: number;
  };
  dailySummary: string;
  hotelDiffs: FacilityHotelDiff[];
};

export type FacilityChangeSummaryInput = {
  collectionDate: string;
  hotelDiffs: FacilityHotelDiff[];
};

export type FacilityChangeSummary = {
  dailySummary: string;
  hotelSummaries: Record<string, string>;
};

export type FacilityChangeSummarizer = (input: FacilityChangeSummaryInput) => Promise<FacilityChangeSummary>;

export const DEFAULT_FACILITY_FIELD_MAPPING: FacilityFieldMapping = {
  sourceRowId: 'id',
  collectionDate: '采集日期',
  collectedAt: '采集时间',
  hotelId: '酒店ID',
  hotelName: '酒店名称',
  detailUrl: '详情页URL',
  facilityJson: '酒店设施JSON',
  policyJson: '酒店政策JSON',
  facilityText: '酒店设施',
  policyText: '酒店政策',
  policyFields: [
    '入住时间',
    '退房时间',
    '入住方式',
    '证件要求',
    '前台营业时间',
    '年龄限制',
    '可接待人群',
    '宠物政策',
    '服务型动物政策',
    '早餐菜品',
    '早餐形式',
    '早餐价格',
    '早餐营业时间',
    '押金政策',
    '押金金额',
    '押金支付方式',
    '押金退还',
    '支付方式',
    '儿童入住政策',
    '加床婴儿床政策',
    '儿童早餐政策',
    '额外说明',
  ],
  booleanFields: [
    '有免费WIFI',
    '有停车场',
    '有充电车位',
    '有接送服务',
    '有行李寄存',
    '有快速入住退房',
    '有24小时前台',
    '有餐厅',
    '有早餐服务',
    '有健身室',
    '有泳池',
    '有洗衣房',
    '有会议厅',
    '有商务中心',
    '有儿童设施',
    '有无障碍设施',
    '有公共区域监控',
    '有灭火器',
    '有烟雾报警器',
  ],
};

export async function analyzeFacilityChanges(
  records: FacilityRecord[],
  options: {
    generatedAt?: string;
    summarizeChanges?: FacilityChangeSummarizer;
  } = {},
): Promise<FacilityAnalysisResult> {
  const currentRecords = findLatestCollectionRecords(records);
  if (!currentRecords.length) {
    throw new Error('facility records are empty');
  }

  const collectionDate = currentRecords[0].collectionDate;
  const hotelDiffs = currentRecords
    .map((current) => compareWithPreviousSnapshot(current, records))
    .sort((left, right) => left.hotelId.localeCompare(right.hotelId));
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const summary = {
    collectionDate,
    currentHotelCount: hotelDiffs.length,
    unchangedHotelCount: hotelDiffs.filter((diff) => diff.status === 'unchanged').length,
    changedHotelCount: hotelDiffs.filter((diff) => diff.status === 'changed').length,
    newHotelCount: hotelDiffs.filter((diff) => diff.status === 'new').length,
  };
  const summarizerResult = await (options.summarizeChanges ?? defaultSummarizeChanges)({
    collectionDate,
    hotelDiffs,
  });
  const withAiSummary = hotelDiffs.map((diff) => ({
    ...diff,
    aiSummary: summarizerResult.hotelSummaries[diff.hotelId] ?? defaultHotelSummary(diff),
  }));

  return {
    analysisId: `facility-analysis-${sha256(`${generatedAt}:${collectionDate}:${canonicalJson(summary)}`).slice(0, 16)}`,
    generatedAt,
    collectionDate,
    summary,
    dailySummary: formatDailySummary(summary),
    hotelDiffs: withAiSummary,
  };
}

export function createFacilityRecordFromBaseRecord(
  record: FacilityBaseRecord,
  mapping: FacilityFieldMapping = DEFAULT_FACILITY_FIELD_MAPPING,
): FacilityRecord {
  const fields = record.fields;
  const sourceRowId = fieldText(fields, mapping.sourceRowId) ?? record.recordId;
  const collectionDate = requiredText(fields, mapping.collectionDate, record.recordId);
  const collectedAt = parseCollectedAt(requiredText(fields, mapping.collectedAt, record.recordId));
  const hotelId = requiredText(fields, mapping.hotelId, record.recordId);
  const hotelName = requiredText(fields, mapping.hotelName, record.recordId);
  const rawFacilityJson = parseOptionalJson(fieldText(fields, mapping.facilityJson), mapping.facilityJson, record.recordId);
  const rawPolicyJson = parseOptionalJson(fieldText(fields, mapping.policyJson), mapping.policyJson, record.recordId);
  const policyFields = normalizeBreakfastSemanticFields(
    pickMappedTextFields(fields, mapping.policyFields),
    fields,
    rawPolicyJson,
  );
  const booleanFields = pickMappedTextFields(fields, mapping.booleanFields);
  const facilityItems = extractFacilityItems(rawFacilityJson);
  const contentHash = sha256(
    canonicalJson({
      hotelId,
      hotelName,
      policyFields,
      booleanFields,
      facilityItems: facilityItems.map((item) => ({ key: item.key, canonical: item.canonical })),
      rawPolicyJson,
    }),
  );

  return {
    recordId: record.recordId,
    sourceRowId,
    collectionDate,
    collectedAt,
    hotelId,
    hotelName,
    detailUrl: fieldText(fields, mapping.detailUrl) ?? undefined,
    policyFields,
    booleanFields,
    facilityItems,
    rawFacilityJson,
    rawPolicyJson,
    contentHash,
  };
}

function findLatestCollectionRecords(records: FacilityRecord[]): FacilityRecord[] {
  const latestDate = records.reduce<string | undefined>((latest, record) => {
    if (!latest || record.collectionDate > latest) {
      return record.collectionDate;
    }
    return latest;
  }, undefined);
  if (!latestDate) {
    return [];
  }
  const latestByHotel = new Map<string, FacilityRecord>();
  for (const record of records.filter((item) => item.collectionDate === latestDate)) {
    const previous = latestByHotel.get(record.hotelId);
    if (!previous || compareRecordTime(record, previous) > 0) {
      latestByHotel.set(record.hotelId, record);
    }
  }
  return [...latestByHotel.values()].sort(compareRecordTime);
}

function compareWithPreviousSnapshot(current: FacilityRecord, allRecords: FacilityRecord[]): FacilityHotelDiff {
  const previous = allRecords
    .filter((record) => record.hotelId === current.hotelId && compareRecordTime(record, current) < 0)
    .sort((left, right) => compareRecordTime(right, left))[0];
  if (!previous) {
    return {
      hotelId: current.hotelId,
      hotelName: current.hotelName,
      status: 'new',
      currentRecordId: current.recordId,
      currentCollectedAt: current.collectedAt,
      changes: [],
    };
  }

  const changes = diffFacilitySnapshots(previous, current);
  return {
    hotelId: current.hotelId,
    hotelName: current.hotelName,
    status: changes.length ? 'changed' : 'unchanged',
    currentRecordId: current.recordId,
    previousRecordId: previous.recordId,
    currentCollectedAt: current.collectedAt,
    previousCollectedAt: previous.collectedAt,
    daysSincePrevious: diffDays(previous.collectedAt, current.collectedAt),
    changes,
  };
}

function diffFacilitySnapshots(previous: FacilityRecord, current: FacilityRecord): FacilityChange[] {
  return [
    ...diffTextFields('酒店政策', previous.policyFields, current.policyFields),
    ...diffTextFields('设施标记', previous.booleanFields, current.booleanFields),
    ...diffFacilityItems(previous.facilityItems, current.facilityItems),
  ];
}

function diffTextFields(section: string, previous: Record<string, string>, current: Record<string, string>): FacilityChange[] {
  const fieldNames = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort((left, right) => left.localeCompare(right));
  const changes: FacilityChange[] = [];
  for (const field of fieldNames) {
    const before = previous[field];
    const after = current[field];
    if (before === after) {
      continue;
    }
    if (!before && after) {
      changes.push({
        kind: 'field_added',
        field,
        after,
        description: `${field}新增为${after}`,
      });
    } else if (before && !after) {
      changes.push({
        kind: 'field_removed',
        field,
        before,
        description: `${field}由${before}改为未展示`,
      });
    } else {
      changes.push({
        kind: 'field_changed',
        field,
        before,
        after,
        description: `${field}由${before}调整为${after}`,
      });
    }
  }
  return changes.map((change) => ({ ...change, field: section === '酒店政策' ? change.field : `${section}.${change.field}` }));
}

function diffFacilityItems(previousItems: FacilityItem[], currentItems: FacilityItem[]): FacilityChange[] {
  const previous = new Map(previousItems.map((item) => [item.key, item]));
  const current = new Map(currentItems.map((item) => [item.key, item]));
  const changes: FacilityChange[] = [];

  for (const [key, currentItem] of [...current.entries()].sort(compareEntryTitle)) {
    const previousItem = previous.get(key);
    if (!previousItem) {
      changes.push({
        kind: 'facility_added',
        field: '酒店设施',
        after: formatFacilityItem(currentItem),
        description: `新增酒店设施：${formatFacilityItem(currentItem)}`,
      });
      continue;
    }
    if (canonicalJson(previousItem.canonical) !== canonicalJson(currentItem.canonical)) {
      if (formatFacilityItem(previousItem) === formatFacilityItem(currentItem)) {
        continue;
      }
      changes.push({
        kind: 'facility_changed',
        field: '酒店设施',
        before: formatFacilityItem(previousItem),
        after: formatFacilityItem(currentItem),
        description: `酒店设施${currentItem.title}信息有调整`,
      });
    }
  }

  for (const [key, previousItem] of [...previous.entries()].sort(compareEntryTitle)) {
    if (current.has(key)) {
      continue;
    }
    changes.push({
      kind: 'facility_removed',
      field: '酒店设施',
      before: formatFacilityItem(previousItem),
      description: `取消酒店设施：${formatFacilityItem(previousItem)}`,
    });
  }

  return changes;
}

function extractFacilityItems(value: JsonValue | undefined): FacilityItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }
  const found: FacilityItem[] = [];
  walkFacilityJson(value, undefined, found);
  const byKey = new Map<string, FacilityItem>();
  for (const item of found) {
    const existing = byKey.get(item.key);
    if (!existing || canonicalJson(item.canonical).length > canonicalJson(existing.canonical).length) {
      byKey.set(item.key, item);
    }
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function walkFacilityJson(value: JsonValue, category: string | undefined, found: FacilityItem[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkFacilityJson(item, category, found);
    }
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const objectValue = value as Record<string, JsonValue>;
  const nextCategory = typeof objectValue.title === 'string' && isCategoryContainer(objectValue)
    ? objectValue.title
    : category;
  if (isFacilityObject(objectValue)) {
    const title = String(objectValue.title).trim();
    const code = typeof objectValue.code === 'number' || typeof objectValue.code === 'string'
      ? String(objectValue.code)
      : '';
    found.push({
      key: code ? `code:${code}` : `title:${normalizeTextKey(title)}`,
      title,
      category,
      detail: facilityDetail(objectValue),
      canonical: canonicalizeFacilityObject(objectValue),
    });
  }

  for (const item of Object.values(objectValue)) {
    walkFacilityJson(item, nextCategory, found);
  }
}

function isFacilityObject(value: Record<string, JsonValue>): boolean {
  return typeof value.title === 'string' && (
    'code' in value ||
    'showTitle' in value ||
    'facilityInfo' in value ||
    'facilityDesc' in value
  );
}

function isCategoryContainer(value: Record<string, JsonValue>): boolean {
  return Array.isArray(value.list) || Array.isArray(value.categoryList);
}

function canonicalizeFacilityObject(value: Record<string, JsonValue>): JsonValue {
  const allowedKeys = ['title', 'facilityDesc', 'showTitle', 'code', 'facilityInfo'];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => value[key] !== undefined && value[key] !== null && !isEmptyArray(value[key]))
      .map((key) => [key, canonicalizeFacilityValue(value[key])]),
  );
}

function canonicalizeFacilityValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(canonicalizeFacilityValue).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry) => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeFacilityValue(item as JsonValue)]),
    );
  }
  return value;
}

function facilityDetail(value: Record<string, JsonValue>): string | undefined {
  const showTitle = typeof value.showTitle === 'string' ? value.showTitle.trim() : '';
  if (showTitle) {
    return showTitle;
  }
  if (!Array.isArray(value.facilityInfo)) {
    return undefined;
  }
  const details = value.facilityInfo
    .filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const title = typeof item.title === 'string' ? item.title : '';
      const text = Array.isArray(item.text) ? item.text.filter((textItem): textItem is string => typeof textItem === 'string').join('、') : '';
      return [title, text].filter(Boolean).join(': ');
    })
    .filter(Boolean);
  return details.length ? details.join('；') : undefined;
}

function formatFacilityItem(item: FacilityItem): string {
  return item.detail ? `${item.title}（${item.detail}）` : item.title;
}

function defaultSummarizeChanges(input: FacilityChangeSummaryInput): Promise<FacilityChangeSummary> {
  const changed = input.hotelDiffs.filter((diff) => diff.status === 'changed');
  const unchanged = input.hotelDiffs.filter((diff) => diff.status === 'unchanged');
  const newlyCollected = input.hotelDiffs.filter((diff) => diff.status === 'new');
  return Promise.resolve({
    dailySummary: `本次分析${input.hotelDiffs.length}家酒店：${unchanged.length}家设施政策无变动，${changed.length}家有变动，${newlyCollected.length}家为新采集。`,
    hotelSummaries: Object.fromEntries(input.hotelDiffs.map((diff) => [diff.hotelId, defaultHotelSummary(diff)])),
  });
}

function formatDailySummary(summary: FacilityAnalysisResult['summary']): string {
  return `本次分析${summary.currentHotelCount}家酒店：${summary.unchangedHotelCount}家设施政策无变动，${summary.changedHotelCount}家有变动，${summary.newHotelCount}家为新采集。`;
}

function defaultHotelSummary(diff: FacilityHotelDiff): string {
  if (diff.status === 'new') {
    return `${diff.hotelName}为新采集，无历史数据。`;
  }
  if (diff.status === 'unchanged') {
    return `${diff.hotelName}设施政策无变动。`;
  }
  return `${diff.hotelName}${diff.changes.map((change) => change.description).join('；')}。`;
}

function pickMappedTextFields(fields: Record<string, unknown>, fieldNames: string[]): Record<string, string> {
  return Object.fromEntries(
    fieldNames.flatMap((fieldName) => {
      const text = fieldText(fields, fieldName);
      return text ? [[fieldName, text]] : [];
    }),
  );
}

function normalizeBreakfastSemanticFields(
  policyFields: Record<string, string>,
  fields: Record<string, unknown>,
  rawPolicyJson: JsonValue | undefined,
): Record<string, string> {
  const nonBreakfastPolicyFields = Object.fromEntries(
    Object.entries(policyFields).filter(([fieldName]) => !BREAKFAST_SEMANTIC_FIELD_NAMES.has(fieldName as keyof BreakfastSemanticFields)),
  );
  return {
    ...nonBreakfastPolicyFields,
    ...extractBreakfastSemanticFields(fields, rawPolicyJson),
  };
}

function extractBreakfastSemanticFields(
  fields: Record<string, unknown>,
  rawPolicyJson: JsonValue | undefined,
): BreakfastSemanticFields {
  const semantic: BreakfastSemanticFields = {};
  const jsonSemantic = extractBreakfastSemanticFromPolicyJson(rawPolicyJson);
  const fallbackSemantic = extractBreakfastSemanticFromFields(fields);
  const merged: BreakfastSemanticFields = {
    ...fallbackSemantic,
    ...jsonSemantic,
  };
  for (const [key, value] of Object.entries(merged) as Array<[keyof BreakfastSemanticFields, string | undefined]>) {
    if (value) {
      semantic[key] = value;
    }
  }
  return semantic;
}

function extractBreakfastSemanticFromFields(fields: Record<string, unknown>): BreakfastSemanticFields {
  const breakfast: BreakfastSemanticFields = {};
  const typeAndPrice = parseBreakfastTypeAndPrice(fieldText(fields, '早餐形式'));
  const menu = normalizeBreakfastMenu(fieldText(fields, '早餐菜品'));
  const price = normalizeBreakfastPriceFromFee(fieldText(fields, '早餐价格')) ?? typeAndPrice.price;
  const time = normalizeBreakfastTime(fieldText(fields, '早餐营业时间'));
  const childPolicy = normalizeBreakfastChildPolicy(fieldText(fields, '儿童早餐政策'));
  if (menu) {
    breakfast['早餐菜品'] = menu;
  }
  if (typeAndPrice.type) {
    breakfast['早餐形式'] = typeAndPrice.type;
  }
  if (price) {
    breakfast['早餐价格'] = price;
  }
  if (time) {
    breakfast['早餐营业时间'] = time;
  }
  if (childPolicy) {
    breakfast['儿童早餐政策'] = childPolicy;
  }
  return breakfast;
}

function extractBreakfastSemanticFromPolicyJson(rawPolicyJson: JsonValue | undefined): BreakfastSemanticFields {
  const breakfastBlock = findBreakfastPolicyBlock(rawPolicyJson);
  if (!breakfastBlock) {
    return {};
  }

  const semantic: BreakfastSemanticFields = {};
  const content = Array.isArray(breakfastBlock.content) ? breakfastBlock.content : [];
  const priceCandidates: string[] = [];
  const childPolicies: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const breakfastItem = item as Record<string, JsonValue>;
    const description = typeof breakfastItem.description === 'string' ? breakfastItem.description.trim() : '';
    if (description) {
      const { kind, value } = parseBreakfastDescription(description);
      if (kind === 'menu') {
        const menu = normalizeBreakfastMenu(value);
        if (menu) {
          semantic['早餐菜品'] = menu;
        }
      } else if (kind === 'type') {
        const parsed = parseBreakfastTypeAndPrice(value);
        if (parsed.type) {
          semantic['早餐形式'] = parsed.type;
        }
        if (parsed.price) {
          priceCandidates.push(parsed.price);
        }
      } else if (kind === 'time') {
        const time = normalizeBreakfastTime(value);
        if (time) {
          semantic['早餐营业时间'] = time;
        }
      }
    }

    const extText = extractBreakfastExtensionText(breakfastItem);
    if (extText) {
      const parsed = parseBreakfastTypeAndPrice(extText);
      if (parsed.type && !semantic['早餐形式']) {
        semantic['早餐形式'] = parsed.type;
      }
      if (parsed.price) {
        priceCandidates.push(parsed.price);
      }
    }

    const tabPolicy = extractBreakfastChildPolicyFromTab(breakfastItem);
    if (tabPolicy) {
      childPolicies.push(tabPolicy);
    }
  }

  const tabPrice = extractBreakfastPriceFromPolicyJson(breakfastBlock);
  if (tabPrice) {
    priceCandidates.push(tabPrice);
  }

  const price = normalizeBreakfastPriceFromFee(priceCandidates[0]);
  if (price) {
    semantic['早餐价格'] = price;
  }
  if (childPolicies.length) {
    semantic['儿童早餐政策'] = childPolicies.sort().join('；');
  }
  return semantic;
}

function findBreakfastPolicyBlock(rawPolicyJson: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (!rawPolicyJson || typeof rawPolicyJson !== 'object' || Array.isArray(rawPolicyJson)) {
    return undefined;
  }
  const policyInfo = (rawPolicyJson as Record<string, JsonValue>).hotelPolicyInfo;
  if (!policyInfo || typeof policyInfo !== 'object' || Array.isArray(policyInfo)) {
    return undefined;
  }
  const breakfast = (policyInfo as Record<string, JsonValue>).breakfast;
  if (!breakfast || typeof breakfast !== 'object' || Array.isArray(breakfast)) {
    return undefined;
  }
  return breakfast as Record<string, JsonValue>;
}

function parseBreakfastDescription(description: string): { kind?: 'menu' | 'type' | 'time'; value: string } {
  const [head, tail = ''] = description.split('：', 2);
  const value = tail.trim();
  const normalizedHead = head.trim();
  if (normalizedHead === '餐食菜品' || normalizedHead === '菜品') {
    return { kind: 'menu', value };
  }
  if (normalizedHead === '餐食形式' || normalizedHead === '类型' || normalizedHead === '形式') {
    return { kind: 'type', value };
  }
  if (normalizedHead === '营业时间') {
    return { kind: 'time', value };
  }
  return { value };
}

function extractBreakfastExtensionText(item: Record<string, JsonValue>): string | undefined {
  const extensions = Array.isArray(item.extentions)
    ? item.extentions
    : Array.isArray(item.extensions)
      ? item.extensions
      : [];
  for (const extension of extensions) {
    if (!extension || typeof extension !== 'object' || Array.isArray(extension)) {
      continue;
    }
    const value = (extension as Record<string, JsonValue>).value;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractBreakfastChildPolicyFromTab(item: Record<string, JsonValue>): string | undefined {
  const tab = item.tab;
  if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
    return undefined;
  }
  const tableItems = Array.isArray((tab as Record<string, JsonValue>).tableItems)
    ? ((tab as Record<string, JsonValue>).tableItems as JsonValue[])
    : [];
  const rows: string[] = [];
  for (const tableItem of tableItems) {
    if (!tableItem || typeof tableItem !== 'object' || Array.isArray(tableItem)) {
      continue;
    }
    const details = Array.isArray((tableItem as Record<string, JsonValue>).tableDetails)
      ? ((tableItem as Record<string, JsonValue>).tableDetails as JsonValue[])
      : [];
    const cells = details
      .filter((detail): detail is Record<string, JsonValue> => Boolean(detail) && typeof detail === 'object' && !Array.isArray(detail))
      .map((detail) => (typeof detail.content === 'string' ? detail.content.trim() : ''))
      .filter(Boolean);
    if (cells.length < 2) {
      continue;
    }
    const label = cells[0];
    const fee = cells[1];
    if (/成人/.test(label)) {
      continue;
    }
    const canonical = canonicalizeChildPolicyEntry(label, fee);
    if (canonical) {
      rows.push(canonical);
    }
  }
  if (!rows.length) {
    return undefined;
  }
  return rows.sort((left, right) => left.localeCompare(right)).join('；');
}

function extractBreakfastPriceFromPolicyJson(breakfastBlock: Record<string, JsonValue>): string | undefined {
  const content = Array.isArray(breakfastBlock.content) ? breakfastBlock.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const breakfastItem = item as Record<string, JsonValue>;
    const extText = extractBreakfastExtensionText(breakfastItem);
    const price = normalizeBreakfastPrice(extText);
    if (price) {
      return price;
    }
    const description = typeof breakfastItem.description === 'string' ? breakfastItem.description : '';
    const parsed = parseBreakfastTypeAndPrice(description);
    if (parsed.price) {
      return parsed.price;
    }
  }
  const tabPrice = extractBreakfastPriceFromTab(breakfastBlock);
  return tabPrice;
}

function extractBreakfastPriceFromTab(breakfastBlock: Record<string, JsonValue>): string | undefined {
  const content = Array.isArray(breakfastBlock.content) ? breakfastBlock.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const breakfastItem = item as Record<string, JsonValue>;
    const tab = breakfastItem.tab;
    if (!tab || typeof tab !== 'object' || Array.isArray(tab)) {
      continue;
    }
    const tableItems = Array.isArray((tab as Record<string, JsonValue>).tableItems)
      ? ((tab as Record<string, JsonValue>).tableItems as JsonValue[])
      : [];
    for (const tableItem of tableItems) {
      if (!tableItem || typeof tableItem !== 'object' || Array.isArray(tableItem)) {
        continue;
      }
      const details = Array.isArray((tableItem as Record<string, JsonValue>).tableDetails)
        ? ((tableItem as Record<string, JsonValue>).tableDetails as JsonValue[])
        : [];
      const cells = details
        .filter((detail): detail is Record<string, JsonValue> => Boolean(detail) && typeof detail === 'object' && !Array.isArray(detail))
        .map((detail) => (typeof detail.content === 'string' ? detail.content.trim() : ''))
        .filter(Boolean);
      if (cells.length < 2) {
        continue;
      }
      if (/成人/.test(cells[0])) {
        const price = normalizeBreakfastPriceFromFee(cells[1]);
        if (price) {
          return price;
        }
      }
    }
  }
  return undefined;
}

function parseBreakfastTypeAndPrice(value: string | undefined): { type?: string; price?: string } {
  const text = normalizeWhitespace(value);
  if (!text) {
    return {};
  }
  const price = normalizeBreakfastPrice(text);
  const type = normalizeBreakfastType(text);
  return {
    type,
    price,
  };
}

function normalizeBreakfastMenu(value: string | undefined): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) {
    return undefined;
  }
  const cleaned = text.replace(/^餐食菜品[:：]/, '').replace(/^菜品[:：]/, '');
  const items = cleaned
    .split(/[、,，/；;]+/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);
  const unique = [...new Set(items)].sort((left, right) => left.localeCompare(right));
  return unique.length ? unique.join('、') : undefined;
}

function normalizeBreakfastType(value: string | undefined): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) {
    return undefined;
  }
  const cleaned = text
    .replace(/^餐食形式[:：]/, '')
    .replace(/^类型[:：]/, '')
    .replace(/^形式[:：]/, '')
    .replace(/^餐食菜品[:：]/, '')
    .replace(/，?¥\s*\d+(?:\.\d+)?(?:\/人|每份)?/g, '')
    .replace(/¥\s*\d+(?:\.\d+)?(?:\/人|每份)?/g, '')
    .replace(/[，,]\s*$/, '')
    .trim();
  return cleaned || undefined;
}

function normalizeBreakfastPrice(value: string | undefined): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) {
    return undefined;
  }
  if (!/[¥￥元]/.test(text)) {
    return undefined;
  }
  const match = text.match(/[¥￥]\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*元/);
  const price = match?.[1] ?? match?.[2];
  return price || undefined;
}

function normalizeBreakfastPriceFromFee(value: string | undefined): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) {
    return undefined;
  }
  const explicit = normalizeBreakfastPrice(text);
  if (explicit) {
    return explicit;
  }
  if (!/(?:免费|同成人|\d)/.test(text)) {
    return undefined;
  }
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(?:\/人|每份|元)?$/);
  return match ? match[1] : undefined;
}

function normalizeBreakfastTime(value: string | undefined): string | undefined {
  const text = normalizeWhitespace(value);
  if (!text) {
    return undefined;
  }
  const normalized = text
    .replace(/开放/g, '')
    .replace(/周一到周日/g, '周一至周日')
    .replace(/每天/g, '周一至周日')
    .replace(/周六、周日/g, '周六至周日')
    .replace(/周六、周天/g, '周六至周日')
    .replace(/周日、周六/g, '周六至周日')
    .replace(/周一至周五/g, '周一至周五')
    .replace(/周一、周二、周三、周四、周五/g, '周一至周五')
    .replace(/[\n\r]/g, '；')
    .replace(/[，,]/g, '；')
    .replace(/\s+(?=周[一二三四五六日天]|周末|\d{2}:\d{2})/g, '；')
    .replace(/\s+/g, '');
  const segments = normalized.split('；').map((segment) => segment.trim()).filter(Boolean);
  const parsed = segments.map((segment) => {
    const match = segment.match(/^(周[一二三四五六日天]+(?:至周[一二三四五六日天]+)?|周末|周六至周日|周一至周五|周一至周日)(\d{2}:\d{2}-\d{2}:\d{2})$/);
    if (match) {
      return { day: normalizeBreakfastScheduleDay(match[1]), time: match[2] };
    }
    const loose = segment.match(/^(周[一二三四五六日天]+(?:至周[一二三四五六日天]+)?|周末|周六至周日|周一至周五|周一至周日)?(\d{2}:\d{2}-\d{2}:\d{2})$/);
    if (loose) {
      return { day: normalizeBreakfastScheduleDay(loose[1] || '周一至周日'), time: loose[2] };
    }
    return undefined;
  }).filter((item): item is { day: string; time: string } => Boolean(item));
  if (!parsed.length) {
    return text;
  }
  const unique = [...new Map(parsed.map((item) => [`${item.day}@${item.time}`, item])).values()];
  unique.sort((left, right) => breakfastScheduleSortKey(left.day) - breakfastScheduleSortKey(right.day) || left.time.localeCompare(right.time));
  return unique.map((item) => `${item.day}${item.time}`).join('；');
}

function normalizeBreakfastScheduleDay(day: string | undefined): string {
  const text = normalizeWhitespace(day);
  if (!text || text === '每天' || text === '周一至周日' || text === '周一到周日') {
    return '周一至周日';
  }
  if (text === '周末' || text === '周六、周日' || text === '周六至周日') {
    return '周六至周日';
  }
  return text.replace(/到/g, '至').replace(/、/g, '至');
}

function breakfastScheduleSortKey(day: string): number {
  if (day === '周一至周日') {
    return 0;
  }
  if (day === '周一至周五') {
    return 1;
  }
  if (day === '周六至周日') {
    return 2;
  }
  return 3;
}

function normalizeBreakfastChildPolicy(value: string | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return undefined;
  }
  const lines = text.split(/[\n\r；;]+/).map((line) => line.trim()).filter(Boolean);
  const rows = lines
    .map((line) => parseChildPolicyLine(line))
    .filter((item): item is { label: string; fee: string } => Boolean(item));
  const canonical = rows
    .map((row) => canonicalizeChildPolicyEntry(row.label, row.fee))
    .filter(Boolean) as string[];
  return canonical.length ? [...new Set(canonical)].sort((left, right) => left.localeCompare(right)).join('；') : undefined;
}

function parseChildPolicyLine(line: string): { label: string; fee: string } | undefined {
  const parts = line.split('|').map((part) => part.trim()).filter(Boolean);
  let label = '';
  let fee = '';
  for (const part of parts) {
    if (!label && /(?:年龄|儿童身高|身高|成人)/.test(part)) {
      const match = part.match(/^(?:年龄|儿童身高|身高)?[:：]?\s*(.+)$/);
      label = match ? match[1].trim() : part.trim();
      continue;
    }
    if (!fee && /(?:费用|价格|收费|同成人|免费|¥)/.test(part)) {
      const match = part.match(/^(?:费用|价格|收费)?[:：]?\s*(.+)$/);
      fee = match ? match[1].trim() : part.trim();
    }
  }
  if (!label && parts[0]) {
    label = parts[0];
  }
  if (!fee && parts[1]) {
    fee = parts[1];
  }
  if (!label || !fee) {
    return undefined;
  }
  return { label, fee };
}

function canonicalizeChildPolicyEntry(label: string, fee: string): string | undefined {
  const canonicalLabel = canonicalizeChildPolicyLabel(label);
  const canonicalFee = normalizeChildPolicyFee(fee);
  if (!canonicalLabel || !canonicalFee) {
    return undefined;
  }
  return `${canonicalLabel} | 费用: ${canonicalFee}`;
}

function canonicalizeChildPolicyLabel(label: string): string | undefined {
  const text = normalizeWhitespace(label);
  if (!text) {
    return undefined;
  }
  const cleaned = text
    .replace(/^(?:儿童身高|身高|年龄|年龄限制)\s*[:：]?\s*/, '')
    .replace(/\s*儿童$/, '')
    .replace(/^儿童\s*/, '')
    .replace(/[\u2013\u2014\u2212－]/g, '-')
    .replace(/\s+/g, '');
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.includes('米')) {
    return `儿童身高: ${cleaned}`;
  }
  if (cleaned.includes('岁') || cleaned.includes('成人')) {
    return cleaned === '成人' ? '年龄: 成人' : `年龄: ${cleaned}`;
  }
  return cleaned;
}

function normalizeChildPolicyFee(fee: string): string | undefined {
  const text = normalizeWhitespace(fee);
  if (!text) {
    return undefined;
  }
  if (text.includes('免费')) {
    return '免费';
  }
  if (text.includes('同成人')) {
    return '同成人';
  }
  const match = text.match(/¥\s*([0-9]+(?:\.[0-9]+)?)/);
  if (match) {
    const unit = text.includes('/人') ? '/人' : text.includes('/晚') ? '/晚' : text.includes('每份') ? '每份' : '';
    return `¥${match[1]}${unit}`;
  }
  return text;
}

function normalizeWhitespace(value: string | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.replace(/\s+/g, ' ') : undefined;
}

function requiredText(fields: Record<string, unknown>, fieldName: string, recordId: string): string {
  const text = fieldText(fields, fieldName);
  if (!text) {
    throw new Error(`field ${fieldName} is required in facility record ${recordId}`);
  }
  return text;
}

function fieldText(fields: Record<string, unknown>, fieldName: string): string | undefined {
  return cellToText(fields[fieldName])?.trim() || undefined;
}

function cellToText(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const text = value.map(cellToText).filter((item): item is string => Boolean(item)).join('');
    return text || undefined;
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
  return undefined;
}

function parseCollectedAt(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (match) {
    return `${match[1]}T${match[2]}.000`;
  }
  const dateOnly = trimmed.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[1]}T00:00:00.000`;
  }
  throw new Error(`invalid collectedAt: ${value}`);
}

function parseOptionalJson(value: string | undefined, fieldName: string, recordId: string): JsonValue | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as JsonValue;
  } catch (cause) {
    console.warn('__HOTEL_REVIEW_AI_FACILITY_INVALID_OPTIONAL_JSON__', JSON.stringify({
      recordId,
      fieldName,
      message: cause instanceof Error ? cause.message : String(cause),
    }));
    return undefined;
  }
}

function compareRecordTime(left: FacilityRecord, right: FacilityRecord): number {
  const timeDiff = left.collectedAt.localeCompare(right.collectedAt);
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return left.recordId.localeCompare(right.recordId);
}

function compareEntryTitle(left: [string, FacilityItem], right: [string, FacilityItem]): number {
  return left[1].title.localeCompare(right[1].title) || left[0].localeCompare(right[0]);
}

function diffDays(previous: string, current: string): number {
  const previousTime = Date.parse(previous);
  const currentTime = Date.parse(current);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return 0;
  }
  return Math.max(0, Math.round((currentTime - previousTime) / 86_400_000));
}

function normalizeTextKey(value: string): string {
  return value.trim().replace(/\s+/g, '').toLocaleLowerCase();
}

function isEmptyArray(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length === 0;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
