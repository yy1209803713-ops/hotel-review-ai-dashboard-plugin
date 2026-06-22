import {
  BackendAnalysisError,
  type AnalysisResult,
  type BaseSummaryExportInput,
  type BaseSummaryExporter,
  type ExportBaseSummaryResponse,
} from './backendAnalysis';
import { createLarkOpenApiRuntime, type LarkOpenApiRuntime } from './larkOpenApiRuntime';

export type FeishuBaseSummaryExporterFactoryOptions = {
  env?: FeishuBaseRuntimeEnv;
  createRuntime?: typeof createLarkOpenApiRuntime;
};

export type FeishuBaseRuntimeEnv = {
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
};

const SUMMARY_TABLE_NAME = 'AI分析摘要';
const TOPIC_TABLE_NAME = 'AI主题摘要';

const TEXT_FIELD_TYPE = 1;
const NUMBER_FIELD_TYPE = 2;

export function createFeishuBaseSummaryExporterFactory(options: FeishuBaseSummaryExporterFactoryOptions = {}): BaseSummaryExporter {
  return new FeishuBaseSummaryExporter(options.env ?? process.env, options.createRuntime ?? createLarkOpenApiRuntime);
}

class FeishuBaseSummaryExporter implements BaseSummaryExporter {
  private readonly runtimes = new Map<string, LarkOpenApiRuntime>();

  constructor(
    private readonly env: FeishuBaseRuntimeEnv,
    private readonly createRuntime: typeof createLarkOpenApiRuntime,
  ) {}

  async exportBaseSummary(input: BaseSummaryExportInput): Promise<ExportBaseSummaryResponse> {
    const { result, config } = input;
    if (config.source.kind !== 'feishu_base') {
      throw new BackendAnalysisError(400, 'export_summary', 'base summary export only supports feishu_base source');
    }
    if (!isNonEmptyString(config.baseToken)) {
      throw new BackendAnalysisError(500, 'export_summary', 'baseToken is required for base summary export');
    }
    if (!isNonEmptyString(this.env.LARK_APP_ID)) {
      throw new BackendAnalysisError(500, 'export_summary', 'LARK_APP_ID is required for base summary export');
    }
    if (!isNonEmptyString(this.env.LARK_APP_SECRET)) {
      throw new BackendAnalysisError(500, 'export_summary', 'LARK_APP_SECRET is required for base summary export');
    }

    const runtime = this.getRuntime(config.baseToken);
    const payload = buildBaseSummaryExportPayload(result);
    const summaryTable = await ensureTable(runtime, SUMMARY_TABLE_NAME, summaryFields);
    const topicTable = await ensureTable(runtime, TOPIC_TABLE_NAME, topicFields);
    const summaryRecordIds = await runtime.addRecords(summaryTable.tableId, [{ fields: payload.summaryRow }]);
    const topicRecordIds = payload.topicRows.length
      ? await runtime.addRecords(
          topicTable.tableId,
          payload.topicRows.map((fields) => ({ fields })),
        )
      : [];

    return {
      resultId: result.resultId,
      summaryTableId: summaryTable.tableId,
      topicTableId: topicTable.tableId,
      summaryRecordIds,
      topicRecordIds,
      exportedAt: payload.exportedAt,
    };
  }

  private getRuntime(baseToken: string): LarkOpenApiRuntime {
    const cacheKey = `${this.env.LARK_APP_ID}:${baseToken}`;
    let runtime = this.runtimes.get(cacheKey);
    if (!runtime) {
      runtime = this.createRuntime({
        baseToken,
        appId: this.env.LARK_APP_ID!,
        appSecret: this.env.LARK_APP_SECRET!,
      });
      this.runtimes.set(cacheKey, runtime);
    }
    return runtime;
  }
}

export function buildBaseSummaryExportPayload(result: AnalysisResult): {
  exportedAt: string;
  summaryRow: Record<string, unknown>;
  topicRows: Array<Record<string, unknown>>;
} {
  const { summary, overview, scope, positiveTopics, negativeTopics } = readExportableSummary(result);
  const generatedAt = stringOrFallback(summary.generatedAt, result.createdAt);
  const exportedAt = new Date().toISOString();

  const summaryRow = {
    '结果 ID': result.resultId,
    '任务 ID': result.jobId,
    酒店: stringOrFallback(scope.hotelName, '全部'),
    周期类型: stringOrFallback(scope.periodType, ''),
    开始日期: stringOrFallback(scope.startDate, ''),
    结束日期: stringOrFallback(scope.endDate, ''),
    总评论数: numberOrZero(overview.totalReviews),
    好评数: numberOrZero(overview.positiveReviews),
    '差评/风险数': numberOrZero(overview.negativeOrRiskReviews),
    平均评分: optionalNumber(overview.averageScore),
    回复率: optionalNumber(overview.replyRate),
    生成时间: generatedAt,
    模型: stringOrFallback(summary.model, ''),
    好评主题数: positiveTopics.length,
    差评主题数: negativeTopics.length,
  };

  const topicRows = [
    ...buildTopicRows('好评', positiveTopics, result.resultId, overview.totalReviews),
    ...buildTopicRows('差评', negativeTopics, result.resultId, overview.totalReviews),
  ];

  return { exportedAt, summaryRow, topicRows };
}

function buildTopicRows(
  direction: '好评' | '差评',
  topics: Array<Record<string, unknown>>,
  resultId: string,
  totalReviewsValue: unknown,
): Array<Record<string, unknown>> {
  const totalReviews = numberOrZero(totalReviewsValue);
  return topics.map((topic, index) => ({
    '结果 ID': resultId,
    方向: direction,
    排名: index + 1,
    主题: stringOrFallback(topic.displayTopic ?? topic.topic, ''),
    类别: stringOrFallback(topic.category, ''),
    命中评论数: numberOrZero(topic.count),
    占比: totalReviews ? roundToFourDecimals(numberOrZero(topic.count) / totalReviews) : 0,
    总结: stringOrFallback(topic.summary, ''),
    建议动作: stringOrFallback(topic.action, ''),
    '代表证据片段': buildEvidenceSnippet(topic),
  }));
}

function readExportableSummary(result: AnalysisResult): {
  summary: Record<string, unknown>;
  overview: Record<string, unknown>;
  scope: Record<string, unknown>;
  positiveTopics: Array<Record<string, unknown>>;
  negativeTopics: Array<Record<string, unknown>>;
} {
  const summary = asRecord(result.summary);
  const overview = asRecord(summary.overview);
  const scope = asRecord(summary.scope);
  const positiveTopics = asArray(summary.positiveTopics).map(asRecord);
  const negativeTopics = asArray(summary.negativeTopics).map(asRecord);
  if (
    !isNonEmptyString(summary.analysisId) ||
    !isNonEmptyString(summary.generatedAt) ||
    !isNonEmptyString(summary.model) ||
    typeof overview.totalReviews !== 'number' ||
    !Array.isArray(summary.positiveTopics) ||
    !Array.isArray(summary.negativeTopics)
  ) {
    throw new BackendAnalysisError(500, 'export_summary', 'analysis result summary is not exportable');
  }
  return { summary, overview, scope, positiveTopics, negativeTopics };
}

function buildEvidenceSnippet(topic: Record<string, unknown>): string {
  const snippets = new Set<string>();
  for (const phrase of asArray(topic.evidencePhrases)) {
    const text = stringOrFallback(phrase, '').trim();
    if (text) {
      snippets.add(text);
    }
    if (snippets.size >= 3) {
      break;
    }
  }
  if (snippets.size < 3) {
    for (const item of asArray(topic.evidenceItems).map(asRecord)) {
      const text = stringOrFallback(item.quote, '').trim();
      if (text) {
        snippets.add(text);
      }
      if (snippets.size >= 3) {
        break;
      }
    }
  }
  return Array.from(snippets).join('\n');
}

async function ensureTable(
  runtime: LarkOpenApiRuntime,
  tableName: string,
  fields: Array<{ name: string; type: number }>,
): Promise<{ tableId: string }> {
  const existing = (await runtime.getTableList()).find((table) => table.tableName === tableName);
  if (existing) {
    return { tableId: existing.tableId };
  }
  return runtime.addTable(tableName, fields);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundToFourDecimals(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

const summaryFields = [
  { name: '结果 ID', type: TEXT_FIELD_TYPE },
  { name: '任务 ID', type: TEXT_FIELD_TYPE },
  { name: '酒店', type: TEXT_FIELD_TYPE },
  { name: '周期类型', type: TEXT_FIELD_TYPE },
  { name: '开始日期', type: TEXT_FIELD_TYPE },
  { name: '结束日期', type: TEXT_FIELD_TYPE },
  { name: '总评论数', type: NUMBER_FIELD_TYPE },
  { name: '好评数', type: NUMBER_FIELD_TYPE },
  { name: '差评/风险数', type: NUMBER_FIELD_TYPE },
  { name: '平均评分', type: NUMBER_FIELD_TYPE },
  { name: '回复率', type: NUMBER_FIELD_TYPE },
  { name: '生成时间', type: TEXT_FIELD_TYPE },
  { name: '模型', type: TEXT_FIELD_TYPE },
  { name: '好评主题数', type: NUMBER_FIELD_TYPE },
  { name: '差评主题数', type: NUMBER_FIELD_TYPE },
];

const topicFields = [
  { name: '结果 ID', type: TEXT_FIELD_TYPE },
  { name: '方向', type: TEXT_FIELD_TYPE },
  { name: '排名', type: NUMBER_FIELD_TYPE },
  { name: '主题', type: TEXT_FIELD_TYPE },
  { name: '类别', type: TEXT_FIELD_TYPE },
  { name: '命中评论数', type: NUMBER_FIELD_TYPE },
  { name: '占比', type: NUMBER_FIELD_TYPE },
  { name: '总结', type: TEXT_FIELD_TYPE },
  { name: '建议动作', type: TEXT_FIELD_TYPE },
  { name: '代表证据片段', type: TEXT_FIELD_TYPE },
];
