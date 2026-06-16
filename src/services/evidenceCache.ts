import { FieldType } from '@lark-base-open/js-sdk';
import type { DashboardRuntime, RuntimeCategory } from '../runtime/sdk';
import type { ReviewRecord, TopicEvidenceItem } from '../types/analysis';
import { cellToText, type RawSdkRecord } from './baseRecords';

export const EVIDENCE_CACHE_TABLE_NAME = 'AI评论证据缓存';
export const EVIDENCE_CACHE_EXTRACTOR_VERSION = 'evidence-v1.2';

export type EvidenceCacheHit = {
  cacheRecordId: string;
  record: ReviewRecord;
  evidenceItems: TopicEvidenceItem[];
};

export type EvidenceCacheReadResult = {
  tableId?: string;
  hits: EvidenceCacheHit[];
  misses: ReviewRecord[];
  diagnostics: EvidenceCacheDiagnostics;
};

export type EvidenceCacheDiagnostics = {
  cacheTableFound: boolean;
  cacheTableId?: string;
  requestedRecords: number;
  cacheRowsRead: number;
  hitRecords: number;
  missRecords: number;
  missReasonCounts: Record<string, number>;
  sampleMisses: Array<{ recordId: string; reviewId: string; reason: string }>;
};

export async function readEvidenceCache(
  runtime: DashboardRuntime,
  params: {
    tableId: string;
    model: string;
    records: ReviewRecord[];
  },
): Promise<EvidenceCacheReadResult> {
  const cacheTable = await findEvidenceCacheTable(runtime);
  const diagnostics: EvidenceCacheDiagnostics = {
    cacheTableFound: Boolean(cacheTable),
    cacheTableId: cacheTable?.tableId,
    requestedRecords: params.records.length,
    cacheRowsRead: 0,
    hitRecords: 0,
    missRecords: params.records.length,
    missReasonCounts: cacheTable ? {} : { cache_table_missing: params.records.length },
    sampleMisses: cacheTable
      ? []
      : params.records.slice(0, 5).map((record) => ({
          recordId: record.recordId,
          reviewId: record.reviewId,
          reason: 'cache_table_missing',
        })),
  };

  if (!cacheTable || !params.records.length) {
    return { tableId: cacheTable?.tableId, hits: [], misses: params.records, diagnostics };
  }

  const fieldMap = await getFieldIdMap(runtime, cacheTable.tableId);
  const cacheRows = await readAllRows(runtime, cacheTable.tableId);
  diagnostics.cacheRowsRead = cacheRows.length;
  const recordsById = new Map(params.records.map((record) => [record.recordId, record]));
  const hashes = new Map(await Promise.all(params.records.map(async (record) => [record.recordId, await hashContent(record.content)] as const)));
  const hitsByRecordId = new Map<string, EvidenceCacheHit>();
  const missReasonByRecordId = new Map<string, string>();

  for (const row of cacheRows) {
    const recordId = getCell(row, fieldMap, '评论 recordId');
    const record = recordId ? recordsById.get(recordId) : undefined;
    if (!record) {
      continue;
    }
    if (getCell(row, fieldMap, '数据表 ID') !== params.tableId) {
      continue;
    }
    if (getCell(row, fieldMap, '模型') !== params.model) {
      if (recordId) {
        missReasonByRecordId.set(recordId, 'model_mismatch');
      }
      continue;
    }
    if (getCell(row, fieldMap, '抽取规则版本') !== EVIDENCE_CACHE_EXTRACTOR_VERSION) {
      if (recordId) {
        missReasonByRecordId.set(recordId, 'extractor_version_mismatch');
      }
      continue;
    }
    if (getCell(row, fieldMap, '评论内容 hash') !== hashes.get(record.recordId)) {
      missReasonByRecordId.set(record.recordId, 'content_hash_mismatch');
      continue;
    }

    const evidenceItems = parseEvidenceItems(getCell(row, fieldMap, '证据 JSON'));
    if (!evidenceItems) {
      missReasonByRecordId.set(record.recordId, 'evidence_json_invalid');
      continue;
    }
    hitsByRecordId.set(record.recordId, {
      cacheRecordId: row.recordId,
      record,
      evidenceItems,
    });
  }

  return {
    tableId: cacheTable.tableId,
    hits: params.records.flatMap((record) => {
      const hit = hitsByRecordId.get(record.recordId);
      return hit ? [hit] : [];
    }),
    misses: params.records.filter((record) => !hitsByRecordId.has(record.recordId)),
    diagnostics: finalizeDiagnostics(diagnostics, params.records, hitsByRecordId, missReasonByRecordId),
  };
}

export async function saveEvidenceCacheEntries(
  runtime: DashboardRuntime,
  params: {
    tableId: string;
    model: string;
    records: ReviewRecord[];
    evidenceItems: TopicEvidenceItem[];
    now?: string;
  },
): Promise<void> {
  if (!params.records.length) {
    return;
  }

  const cacheTable = await ensureEvidenceCacheTable(runtime);
  const fieldMap = await getFieldIdMap(runtime, cacheTable.tableId);
  const now = params.now ?? new Date().toISOString();
  const evidenceByRecordId = groupEvidenceByRecord(params.evidenceItems);
  const rows = await Promise.all(
    params.records.map(async (record) => ({
      fields: mapFields(fieldMap, {
        '数据表 ID': params.tableId,
        '评论 recordId': record.recordId,
        '评论内容 hash': await hashContent(record.content),
        模型: params.model,
        抽取规则版本: EVIDENCE_CACHE_EXTRACTOR_VERSION,
        '证据 JSON': JSON.stringify(evidenceByRecordId.get(record.recordId) ?? []),
        更新时间: now,
        最近使用时间: now,
      }),
    })),
  );

  await addRecordsInChunks(runtime, cacheTable.tableId, rows);
}

export async function touchEvidenceCacheEntries(
  runtime: DashboardRuntime,
  params: {
    cacheTableId: string;
    cacheRecordIds: string[];
    now?: string;
  },
): Promise<void> {
  if (!params.cacheRecordIds.length) {
    return;
  }

  try {
    const fieldMap = await getFieldIdMap(runtime, params.cacheTableId);
    const now = params.now ?? new Date().toISOString();
    await setRecordsInChunks(
      runtime,
      params.cacheTableId,
      params.cacheRecordIds.map((recordId) => ({
        recordId,
        fields: mapFields(fieldMap, {
          最近使用时间: now,
        }),
      })),
    );
  } catch {
    // 最近使用时间只服务缓存清理，不能拖慢或阻断主分析流程。
  }
}

async function findEvidenceCacheTable(runtime: DashboardRuntime): Promise<{ tableId: string } | undefined> {
  const table = (await runtime.getTableList()).find((table) => table.tableName === EVIDENCE_CACHE_TABLE_NAME);
  return table ? { tableId: table.tableId } : undefined;
}

async function ensureEvidenceCacheTable(runtime: DashboardRuntime): Promise<{ tableId: string }> {
  const existing = await findEvidenceCacheTable(runtime);
  if (existing) {
    return existing;
  }
  return runtime.addTable(EVIDENCE_CACHE_TABLE_NAME, evidenceCacheFields);
}

async function getFieldIdMap(runtime: DashboardRuntime, tableId: string): Promise<Map<string, string>> {
  const fields = (await runtime.getFieldMetaList(tableId)) as RuntimeCategory[];
  return new Map(fields.map((field) => [field.fieldName, field.fieldId]));
}

async function readAllRows(runtime: DashboardRuntime, tableId: string): Promise<RawSdkRecord[]> {
  const records: RawSdkRecord[] = [];
  let pageToken: unknown;

  do {
    const page = await runtime.readRecordsPage(tableId, {
      pageSize: 200,
      pageToken,
    });
    records.push(...page.records);
    pageToken = page.pageToken;
    if (!page.hasMore) {
      break;
    }
  } while (pageToken !== undefined && pageToken !== null);

  return records;
}

function getCell(row: RawSdkRecord, fieldMap: Map<string, string>, fieldName: string): string | null {
  const fieldId = fieldMap.get(fieldName);
  return fieldId ? cellToText(row.fields[fieldId]) : null;
}

function parseEvidenceItems(rawJson: string | null): TopicEvidenceItem[] | null {
  if (!rawJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.flatMap((item): TopicEvidenceItem[] => {
      if (!item || typeof item !== 'object') {
        return [];
      }
      const value = item as Partial<TopicEvidenceItem>;
      if (
        typeof value.recordId !== 'string' ||
        typeof value.quote !== 'string' ||
        (value.sentiment !== 'positive' && value.sentiment !== 'negative') ||
        typeof value.aspectLabel !== 'string'
      ) {
        return [];
      }
      return [
        {
          recordId: value.recordId,
          quote: value.quote,
          sentiment: value.sentiment,
          aspectLabel: value.aspectLabel,
          reason: typeof value.reason === 'string' ? value.reason : undefined,
        },
      ];
    });
  } catch {
    return null;
  }
}

function finalizeDiagnostics(
  diagnostics: EvidenceCacheDiagnostics,
  records: ReviewRecord[],
  hitsByRecordId: Map<string, EvidenceCacheHit>,
  missReasonByRecordId: Map<string, string>,
): EvidenceCacheDiagnostics {
  const missReasonCounts: Record<string, number> = { ...diagnostics.missReasonCounts };
  const sampleMisses = diagnostics.sampleMisses.slice();

  for (const record of records) {
    if (hitsByRecordId.has(record.recordId)) {
      continue;
    }
    const reason = missReasonByRecordId.get(record.recordId) ?? 'cache_no_matching_row';
    missReasonCounts[reason] = (missReasonCounts[reason] ?? 0) + 1;
    if (sampleMisses.length < 5) {
      sampleMisses.push({
        recordId: record.recordId,
        reviewId: record.reviewId,
        reason,
      });
    }
  }

  return {
    ...diagnostics,
    hitRecords: hitsByRecordId.size,
    missRecords: records.length - hitsByRecordId.size,
    missReasonCounts,
    sampleMisses,
  };
}

function groupEvidenceByRecord(evidenceItems: TopicEvidenceItem[]): Map<string, TopicEvidenceItem[]> {
  const grouped = new Map<string, TopicEvidenceItem[]>();
  for (const item of evidenceItems) {
    grouped.set(item.recordId, [...(grouped.get(item.recordId) ?? []), item]);
  }
  return grouped;
}

function mapFields(fieldMap: Map<string, string>, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([fieldName, value]) => [fieldMap.get(fieldName), value] as const)
      .filter((entry): entry is [string, unknown] => Boolean(entry[0])),
  );
}

async function addRecordsInChunks(
  runtime: DashboardRuntime,
  tableId: string,
  rows: Array<{ fields: Record<string, unknown> }>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    await runtime.addRecords(tableId, rows.slice(index, index + 200));
  }
}

async function setRecordsInChunks(
  runtime: DashboardRuntime,
  tableId: string,
  rows: Array<{ recordId: string; fields: Record<string, unknown> }>,
): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    await runtime.setRecords(tableId, rows.slice(index, index + 200));
  }
}

async function hashContent(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const evidenceCacheFields = [
  { name: '数据表 ID', type: FieldType.Text },
  { name: '评论 recordId', type: FieldType.Text },
  { name: '评论内容 hash', type: FieldType.Text },
  { name: '模型', type: FieldType.Text },
  { name: '抽取规则版本', type: FieldType.Text },
  { name: '证据 JSON', type: FieldType.Text },
  { name: '更新时间', type: FieldType.Text },
  { name: '最近使用时间', type: FieldType.Text },
];
