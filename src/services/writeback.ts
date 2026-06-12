import { FieldType } from '@lark-base-open/js-sdk';
import type { DashboardRuntime, RuntimeCategory } from '../runtime/sdk';
import type { AnalysisResult, TopicSummary } from '../types/analysis';
import type { WritebackConfig } from '../types/config';

export type WritebackResult =
  | { status: 'skipped'; reason: 'disabled' | 'unconfirmed' | 'permission_denied' }
  | { status: 'written'; batchTableId: string; topicTableId: string };

const BATCH_TABLE_NAME = 'AI分析批次';
const TOPIC_TABLE_NAME = 'AI主题汇总';

export async function writeAnalysisResult(
  runtime: DashboardRuntime,
  result: AnalysisResult,
  config: WritebackConfig,
): Promise<WritebackResult> {
  if (!config.enabled) {
    return { status: 'skipped', reason: 'disabled' };
  }

  if (!config.confirmed) {
    return { status: 'skipped', reason: 'unconfirmed' };
  }

  const canEdit = await runtime.canEditBase();
  if (!canEdit) {
    return { status: 'skipped', reason: 'permission_denied' };
  }

  const batchTableId = config.batchTableId ?? (await ensureTable(runtime, BATCH_TABLE_NAME, batchFields)).tableId;
  const topicTableId = config.topicTableId ?? (await ensureTable(runtime, TOPIC_TABLE_NAME, topicFields)).tableId;
  const [batchFieldMap, topicFieldMap] = await Promise.all([
    getFieldIdMap(runtime, batchTableId),
    getFieldIdMap(runtime, topicTableId),
  ]);

  await runtime.addRecords(batchTableId, [
    {
      fields: mapFields(batchFieldMap, {
        '分析批次 ID': result.analysisId,
        酒店: result.scope.hotelName,
        周期类型: result.scope.periodType,
        开始日期: result.scope.startDate,
        结束日期: result.scope.endDate,
        总评论数: result.overview.totalReviews,
        好评数: result.overview.positiveReviews,
        '差评/风险数': result.overview.negativeOrRiskReviews,
        平均评分: result.overview.averageScore,
        回复率: result.overview.replyRate,
        生成时间: result.generatedAt,
        模型: result.model,
        '完整结果 JSON': JSON.stringify(result),
      }),
    },
  ]);

  await runtime.addRecords(topicTableId, [
    ...topicRows(result.positiveTopics, '好评', result, topicFieldMap),
    ...topicRows(result.negativeTopics, '差评', result, topicFieldMap),
  ]);

  return { status: 'written', batchTableId, topicTableId };
}

async function ensureTable(
  runtime: DashboardRuntime,
  tableName: string,
  fields: Array<{ name: string; type: FieldType }>,
): Promise<{ tableId: string }> {
  const existing = (await runtime.getTableList()).find((table) => table.tableName === tableName);
  if (existing) {
    return { tableId: existing.tableId };
  }
  return runtime.addTable(tableName, fields);
}

async function getFieldIdMap(runtime: DashboardRuntime, tableId: string): Promise<Map<string, string>> {
  const fields = (await runtime.getFieldMetaList(tableId)) as RuntimeCategory[];
  return new Map(fields.map((field) => [field.fieldName, field.fieldId]));
}

function topicRows(
  topics: TopicSummary[],
  direction: '好评' | '差评',
  result: AnalysisResult,
  fieldMap: Map<string, string>,
): Array<{ fields: Record<string, unknown> }> {
  return topics.map((topic, index) => ({
    fields: mapFields(fieldMap, {
      '分析批次 ID': result.analysisId,
      方向: direction,
      排名: index + 1,
      主题: topic.displayTopic,
      类别: topic.category,
      命中评论数: topic.count,
      占比: result.overview.totalReviews ? topic.count / result.overview.totalReviews : 0,
      总结: topic.summary,
      建议动作: topic.action ?? '',
      '关联评论 record_id 列表 JSON': JSON.stringify(topic.commentRecordIds),
      '证据片段 JSON': JSON.stringify(topic.evidenceItems ?? []),
    }),
  }));
}

function mapFields(fieldMap: Map<string, string>, values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([fieldName, value]) => [fieldMap.get(fieldName), value] as const)
      .filter((entry): entry is [string, unknown] => Boolean(entry[0])),
  );
}

const batchFields = [
  { name: '分析批次 ID', type: FieldType.Text },
  { name: '酒店', type: FieldType.Text },
  { name: '周期类型', type: FieldType.Text },
  { name: '开始日期', type: FieldType.Text },
  { name: '结束日期', type: FieldType.Text },
  { name: '总评论数', type: FieldType.Number },
  { name: '好评数', type: FieldType.Number },
  { name: '差评/风险数', type: FieldType.Number },
  { name: '平均评分', type: FieldType.Number },
  { name: '回复率', type: FieldType.Number },
  { name: '生成时间', type: FieldType.Text },
  { name: '模型', type: FieldType.Text },
  { name: '完整结果 JSON', type: FieldType.Text },
];

const topicFields = [
  { name: '分析批次 ID', type: FieldType.Text },
  { name: '方向', type: FieldType.Text },
  { name: '排名', type: FieldType.Number },
  { name: '主题', type: FieldType.Text },
  { name: '类别', type: FieldType.Text },
  { name: '命中评论数', type: FieldType.Number },
  { name: '占比', type: FieldType.Number },
  { name: '总结', type: FieldType.Text },
  { name: '建议动作', type: FieldType.Text },
  { name: '关联评论 record_id 列表 JSON', type: FieldType.Text },
  { name: '证据片段 JSON', type: FieldType.Text },
];
