import { z } from 'zod';
import { BackendAnalysisError } from './backendAnalysis';
import { readAiRuntimeConfig, type AiRuntimeEnv } from './aiAnalysisRunner';
import type { FacilityChangeSummary, FacilityChangeSummarizer, FacilityHotelDiff } from './facilityAnalysis';
import { normalizeChatCompletionsUrl } from '../src/services/aiClient';

export type FacilityAiSummarizerOptions = {
  env?: AiRuntimeEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const facilityAiSummarySchema = z.object({
  dailySummary: z.string().min(1),
  hotelSummaries: z.array(z.object({
    hotelId: z.string().min(1),
    summary: z.string().min(1),
  })),
});

export function createFacilityAiSummarizer(options: FacilityAiSummarizerOptions = {}): FacilityChangeSummarizer {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  return async (input) => {
    const config = readAiRuntimeConfig(env);
    const timeoutMs = options.timeoutMs ?? (config.requestTimeoutSeconds ?? 600) * 1000;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(normalizeChatCompletionsUrl(config.apiBaseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                '你是酒店设施和政策变动分析助手。只输出严格 JSON，不要输出 Markdown。输入中的 changes 是程序已经确定的结构化差分，你不能臆造未出现的变动；要把字段变更说成一眼能看懂的人话，优先提炼结论，例如“早餐菜品新增当地风味”“早餐价格上调10元”“新增代客泊车服务”，不要机械复述完整 before/after 列表。新采集酒店必须明确写“新采集，无历史数据”。',
            },
            {
              role: 'user',
              content: buildPrompt(input),
            },
          ],
        }),
      });
      if (!response.ok) {
        throw new BackendAnalysisError(502, 'extract_evidence', `AI API 请求失败：${response.status} ${await safeResponseText(response)}`);
      }

      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new BackendAnalysisError(502, 'extract_evidence', '模型没有返回设施变动 JSON 内容');
      }
      const parsed = facilityAiSummarySchema.safeParse(parseJsonObject(content));
      if (!parsed.success) {
        throw new BackendAnalysisError(502, 'extract_evidence', parsed.error.message);
      }
      return {
        dailySummary: parsed.data.dailySummary,
        hotelSummaries: Object.fromEntries(parsed.data.hotelSummaries.map((item) => [item.hotelId, item.summary])),
      } satisfies FacilityChangeSummary;
    } catch (cause) {
      if (cause instanceof BackendAnalysisError) {
        throw cause;
      }
      if (cause instanceof DOMException && cause.name === 'AbortError') {
        throw new BackendAnalysisError(502, 'extract_evidence', `设施变动 AI 总结超时（${Math.ceil(timeoutMs / 1000)}秒未返回）`);
      }
      throw new BackendAnalysisError(502, 'extract_evidence', cause instanceof Error ? cause.message : String(cause));
    } finally {
      globalThis.clearTimeout(timeout);
    }
  };
}

function buildPrompt(input: { collectionDate: string; hotelDiffs: FacilityHotelDiff[] }): string {
  return JSON.stringify({
    task: '根据结构化 diff 生成当天酒店设施政策变动分析。',
    collectionDate: input.collectionDate,
    rules: [
      'dailySummary 要用“本次分析”表述，包含本次分析酒店总数、无变动数量、有变动数量、新采集数量。',
      '每个 changed 酒店要说清楚具体变化，不能只写“早餐政策变了”或“设施变了”。',
      'changed 酒店的 summary 要像业务备注，不要像 diff 日志；能判断新增/取消/价格涨跌时，直接说新增了什么、取消了什么、涨跌多少。',
      '涉及数字价格时，比较 before/after，能计算差额就写上调或下调多少元。',
      'new 酒店写“新采集，无历史数据”。',
      'unchanged 酒店可以简写“设施政策无变动”。',
    ],
    jsonContract: {
      dailySummary: 'string',
      hotelSummaries: [{ hotelId: 'string', summary: 'string' }],
    },
    hotelDiffs: input.hotelDiffs.map((diff) => ({
      hotelId: diff.hotelId,
      hotelName: diff.hotelName,
      status: diff.status,
      currentCollectedAt: diff.currentCollectedAt,
      previousCollectedAt: diff.previousCollectedAt,
      daysSincePrevious: diff.daysSincePrevious,
      changes: diff.changes.map((change) => ({
        kind: change.kind,
        field: change.field,
        before: change.before,
        after: change.after,
        description: change.description,
      })),
    })),
  });
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(trimmed);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 300);
  } catch {
    return '';
  }
}
