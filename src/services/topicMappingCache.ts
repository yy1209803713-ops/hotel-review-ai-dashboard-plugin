import { FieldType } from '@lark-base-open/js-sdk';
import type { DashboardRuntime, RuntimeCategory } from '../runtime/sdk';
import type { TopicMergeCandidate, TopicMergeGroup, TopicSentiment } from '../types/analysis';
import { cellToText, type RawSdkRecord } from './baseRecords';

export const TOPIC_MAPPING_CACHE_TABLE_NAME = 'AI评论主题映射缓存';
export const TOPIC_MAPPING_CACHE_VERSION = 'topic-mapping-v1.0';

export type TopicMapping = {
  sourceLabel: string;
  sentiment: TopicSentiment;
  mergeKey: string;
  category: string;
  displayTopic: string;
  summary: string;
  acceptedQuotes?: string[];
  action?: string;
};

export type TopicMappingCacheHit = {
  cacheRecordId: string;
  candidate: TopicMergeCandidate;
  mapping: TopicMapping;
};

export type TopicMappingCacheReadResult = {
  tableId?: string;
  hits: TopicMappingCacheHit[];
  misses: TopicMergeCandidate[];
  diagnostics: TopicMappingCacheDiagnostics;
};

export type TopicMappingCacheDiagnostics = {
  cacheTableFound: boolean;
  cacheTableId?: string;
  requestedCandidates: number;
  cacheRowsRead: number;
  hitCandidates: number;
  missCandidates: number;
  missReasonCounts: Record<string, number>;
  sampleMisses: Array<{ sentiment: TopicSentiment; sourceLabel: string; reason: string }>;
};

export async function readTopicMappingCache(
  runtime: DashboardRuntime,
  params: {
    tableId: string;
    model: string;
    candidates: TopicMergeCandidate[];
  },
): Promise<TopicMappingCacheReadResult> {
  const cacheTable = await findTopicMappingCacheTable(runtime);
  const diagnostics: TopicMappingCacheDiagnostics = {
    cacheTableFound: Boolean(cacheTable),
    cacheTableId: cacheTable?.tableId,
    requestedCandidates: params.candidates.length,
    cacheRowsRead: 0,
    hitCandidates: 0,
    missCandidates: params.candidates.length,
    missReasonCounts: cacheTable ? {} : { cache_table_missing: params.candidates.length },
    sampleMisses: cacheTable
      ? []
      : params.candidates.slice(0, 5).map((candidate) => ({
          sentiment: candidate.sentiment,
          sourceLabel: candidate.sourceLabel,
          reason: 'cache_table_missing',
        })),
  };

  if (!cacheTable || !params.candidates.length) {
    return { tableId: cacheTable?.tableId, hits: [], misses: params.candidates, diagnostics };
  }

  const fieldMap = await getFieldIdMap(runtime, cacheTable.tableId);
  const cacheRows = await readAllRows(runtime, cacheTable.tableId);
  diagnostics.cacheRowsRead = cacheRows.length;
  const candidatesByKey = new Map(params.candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const hitsByKey = new Map<string, TopicMappingCacheHit>();
  const missReasonByKey = new Map<string, string>();

  for (const row of cacheRows) {
    if (getCell(row, fieldMap, '数据表 ID') !== params.tableId) {
      continue;
    }
    const sentiment = getCell(row, fieldMap, '候选 sentiment');
    const normalizedLabel = getCell(row, fieldMap, '候选标签归一化 key');
    if (sentiment !== 'positive' && sentiment !== 'negative') {
      continue;
    }
    const key = mappingKey(sentiment, normalizedLabel ?? '');
    const candidate = candidatesByKey.get(key);
    if (!candidate) {
      continue;
    }
    if (getCell(row, fieldMap, '模型') !== params.model) {
      missReasonByKey.set(key, 'model_mismatch');
      continue;
    }
    if (getCell(row, fieldMap, '主题映射规则版本') !== TOPIC_MAPPING_CACHE_VERSION) {
      missReasonByKey.set(key, 'mapping_version_mismatch');
      continue;
    }

    const mapping = parseTopicMapping(getCell(row, fieldMap, '映射 JSON'));
    if (!mapping || mapping.sentiment !== candidate.sentiment) {
      missReasonByKey.set(key, 'mapping_json_invalid');
      continue;
    }
    hitsByKey.set(key, {
      cacheRecordId: row.recordId,
      candidate,
      mapping: {
        ...mapping,
        sourceLabel: candidate.sourceLabel,
        acceptedQuotes: mapping.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
      },
    });
  }

  return {
    tableId: cacheTable.tableId,
    hits: params.candidates.flatMap((candidate) => {
      const hit = hitsByKey.get(candidateKey(candidate));
      return hit ? [hit] : [];
    }),
    misses: params.candidates.filter((candidate) => !hitsByKey.has(candidateKey(candidate))),
    diagnostics: finalizeDiagnostics(diagnostics, params.candidates, hitsByKey, missReasonByKey),
  };
}

export async function saveTopicMappingCacheEntries(
  runtime: DashboardRuntime,
  params: {
    tableId: string;
    model: string;
    candidates: TopicMergeCandidate[];
    groups: TopicMergeGroup[];
    now?: string;
  },
): Promise<void> {
  if (!params.candidates.length || !params.groups.length) {
    return;
  }

  const cacheTable = await ensureTopicMappingCacheTable(runtime);
  const fieldMap = await getFieldIdMap(runtime, cacheTable.tableId);
  const now = params.now ?? new Date().toISOString();
  const mappings = buildMappingsFromGroups(params.candidates, params.groups);
  const rows = params.candidates.flatMap((candidate) => {
    const mapping = mappings.get(candidateKey(candidate));
    if (!mapping) {
      return [];
    }
    return [
      {
        fields: mapFields(fieldMap, {
          '数据表 ID': params.tableId,
          '候选 sentiment': candidate.sentiment,
          '候选标签归一化 key': normalizeTopic(candidate.sourceLabel),
          候选标签: candidate.sourceLabel,
          模型: params.model,
          主题映射规则版本: TOPIC_MAPPING_CACHE_VERSION,
          '映射 JSON': JSON.stringify(mapping),
          更新时间: now,
          最近使用时间: now,
        }),
      },
    ];
  });

  await addRecordsInChunks(runtime, cacheTable.tableId, rows);
}

export async function touchTopicMappingCacheEntries(
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
    // 最近使用时间只服务缓存清理，不影响主分析流程。
  }
}

function buildMappingsFromGroups(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): Map<string, TopicMapping> {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const bySource = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const mappings = new Map<string, TopicMapping>();

  for (const group of groups) {
    for (const member of group.members) {
      const candidate =
        (member.candidateId ? byId.get(member.candidateId) : undefined) ??
        bySource.get(mappingKey(group.sentiment, member.sourceLabel));
      if (!candidate) {
        continue;
      }
      mappings.set(candidateKey(candidate), {
        sourceLabel: candidate.sourceLabel,
        sentiment: candidate.sentiment,
        mergeKey: group.mergeKey.trim() || candidate.sourceLabel,
        category: group.category.trim() || candidate.sourceLabel,
        displayTopic: group.displayTopic.trim() || candidate.sourceLabel,
        summary: group.summary.trim() || `${group.displayTopic || group.mergeKey || candidate.sourceLabel}相关评论证据。`,
        acceptedQuotes: member.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
        action: group.action?.trim() || undefined,
      });
    }
  }

  return mappings;
}

async function findTopicMappingCacheTable(runtime: DashboardRuntime): Promise<{ tableId: string } | undefined> {
  const table = (await runtime.getTableList()).find((table) => table.tableName === TOPIC_MAPPING_CACHE_TABLE_NAME);
  return table ? { tableId: table.tableId } : undefined;
}

async function ensureTopicMappingCacheTable(runtime: DashboardRuntime): Promise<{ tableId: string }> {
  const existing = await findTopicMappingCacheTable(runtime);
  if (existing) {
    return existing;
  }
  return runtime.addTable(TOPIC_MAPPING_CACHE_TABLE_NAME, topicMappingCacheFields);
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

function parseTopicMapping(rawJson: string | null): TopicMapping | null {
  if (!rawJson) {
    return null;
  }
  try {
    const value = JSON.parse(rawJson) as Partial<TopicMapping>;
    if (
      typeof value.sourceLabel !== 'string' ||
      (value.sentiment !== 'positive' && value.sentiment !== 'negative') ||
      typeof value.mergeKey !== 'string' ||
      typeof value.category !== 'string' ||
      typeof value.displayTopic !== 'string' ||
      typeof value.summary !== 'string'
    ) {
      return null;
    }
    return {
      sourceLabel: value.sourceLabel,
      sentiment: value.sentiment,
      mergeKey: value.mergeKey,
      category: value.category,
      displayTopic: value.displayTopic,
      summary: value.summary,
      acceptedQuotes: Array.isArray(value.acceptedQuotes)
        ? value.acceptedQuotes.filter((quote): quote is string => typeof quote === 'string')
        : undefined,
      action: typeof value.action === 'string' ? value.action : undefined,
    };
  } catch {
    return null;
  }
}

function finalizeDiagnostics(
  diagnostics: TopicMappingCacheDiagnostics,
  candidates: TopicMergeCandidate[],
  hitsByKey: Map<string, TopicMappingCacheHit>,
  missReasonByKey: Map<string, string>,
): TopicMappingCacheDiagnostics {
  const missReasonCounts: Record<string, number> = { ...diagnostics.missReasonCounts };
  const sampleMisses = diagnostics.sampleMisses.slice();

  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (hitsByKey.has(key)) {
      continue;
    }
    const reason = missReasonByKey.get(key) ?? 'cache_no_matching_row';
    missReasonCounts[reason] = (missReasonCounts[reason] ?? 0) + 1;
    if (sampleMisses.length < 5) {
      sampleMisses.push({
        sentiment: candidate.sentiment,
        sourceLabel: candidate.sourceLabel,
        reason,
      });
    }
  }

  return {
    ...diagnostics,
    hitCandidates: hitsByKey.size,
    missCandidates: candidates.length - hitsByKey.size,
    missReasonCounts,
    sampleMisses,
  };
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

function candidateKey(candidate: TopicMergeCandidate): string {
  return mappingKey(candidate.sentiment, candidate.sourceLabel);
}

function mappingKey(sentiment: TopicSentiment, sourceLabel: string): string {
  return `${sentiment}|${normalizeTopic(sourceLabel)}`;
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}

const topicMappingCacheFields = [
  { name: '数据表 ID', type: FieldType.Text },
  { name: '候选 sentiment', type: FieldType.Text },
  { name: '候选标签归一化 key', type: FieldType.Text },
  { name: '候选标签', type: FieldType.Text },
  { name: '模型', type: FieldType.Text },
  { name: '主题映射规则版本', type: FieldType.Text },
  { name: '映射 JSON', type: FieldType.Text },
  { name: '更新时间', type: FieldType.Text },
  { name: '最近使用时间', type: FieldType.Text },
];
