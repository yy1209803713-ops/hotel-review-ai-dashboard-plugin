import { z } from 'zod';
import type { AiConfig } from '../types/config';
import type {
  BatchAiResult,
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeResult,
} from '../types/analysis';
import { debugLog } from './debug';

export type AiClientErrorCode =
  | 'missing_base_url'
  | 'invalid_base_url'
  | 'missing_key'
  | 'timeout'
  | 'http_error'
  | 'network_error'
  | 'invalid_json'
  | 'schema_invalid';

export class AiClientError extends Error {
  constructor(
    public readonly code: AiClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiClientError';
  }
}

const modelEvidenceItemSchema = z.object({
  recordId: z.string(),
  quote: z.string(),
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  aspectLabel: z.string(),
  reason: z.string().optional(),
});

type ModelEvidenceItem = z.infer<typeof modelEvidenceItemSchema>;

const batchAiResultSchema = z.object({
  evidenceItems: z.array(modelEvidenceItemSchema),
}).transform((result) => ({
  evidenceItems: result.evidenceItems.flatMap(normalizeModelEvidenceItem),
}));

const topicMergeResultSchema = z.object({
  groups: z.array(
    z.object({
      mergeKey: z.string(),
      sentiment: z.enum(['positive', 'negative']),
      category: z.string(),
      displayTopic: z.string(),
      summary: z.string(),
      action: z.string().optional(),
      members: z.array(
        z.object({
          sourceLabel: z.string(),
          acceptedQuotes: z.array(z.string()).default([]),
        }),
      ),
    }),
  ),
});

const CONNECTION_TEST_TIMEOUT_MS = 20000;
const ANALYSIS_TIMEOUT_MS = 180000;

export function normalizeChatCompletionsUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new AiClientError('missing_base_url', 'API Base URL 缺失');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new AiClientError('invalid_base_url', 'API Base URL 必须是 http(s):// 开头的完整地址');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new AiClientError('invalid_base_url', 'API Base URL 必须是 http(s):// 开头的完整地址');
  }

  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export function hasAiCredentials(config: AiConfig): boolean {
  return Boolean(config.apiBaseUrl.trim() && config.apiKey.trim() && config.model.trim());
}

export function formatAiClientError(error: unknown): string {
  if (error instanceof AiClientError) {
    return error.message;
  }
  if (error instanceof TypeError) {
    return 'AI API 网络请求失败，可能是 URL 不正确、服务不可达或浏览器 CORS 限制';
  }
  return error instanceof Error ? error.message : 'AI API 请求失败';
}

export async function testAiConnection(params: {
  config: AiConfig;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ url: string; model: string }> {
  const { config, timeoutMs = CONNECTION_TEST_TIMEOUT_MS } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!config.model.trim()) {
    throw new AiClientError('missing_key', 'Model 缺失');
  }
  if (!config.apiKey.trim()) {
    throw new AiClientError('missing_key', 'API Key 缺失');
  }

  const url = normalizeChatCompletionsUrl(config.apiBaseUrl);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        max_tokens: 20,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '只返回 JSON。',
          },
          {
            role: 'user',
            content: '返回 {"ok":true}',
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await safeReadResponseText(response);
      throw new AiClientError('http_error', `AI API 请求失败：${response.status}${detail ? ` ${detail}` : ''}`);
    }

    const payload = (await readJsonResponse(response)) as { choices?: Array<{ message?: { content?: string } }> };
    if (!payload.choices?.[0]?.message?.content) {
      throw new AiClientError('invalid_json', 'AI API 已响应，但返回结构不是 Chat Completions 格式');
    }

    return { url, model: config.model };
  } catch (error) {
    if (error instanceof AiClientError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiClientError('timeout', 'AI API 请求超时');
    }
    if (error instanceof TypeError) {
      throw new AiClientError('network_error', `AI API 网络请求失败：${error.message || 'Failed to fetch'}`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function analyzeBatch(params: {
  config: AiConfig;
  records: ReviewRecord[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<BatchAiResult> {
  const { config, records, timeoutMs = ANALYSIS_TIMEOUT_MS } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!config.apiKey.trim()) {
    throw new AiClientError('missing_key', 'API Key 缺失');
  }

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
              '你是通用评论证据抽取助手。只输出一个严格 JSON 对象，不要输出 Markdown。不要输出主题排行榜，不要直接输出主题下的评论列表。只从用户给出的 content 字段抽取原文连续证据片段；不能使用未提供的字段或推断出的文本。高分评论里的负面细节也要作为 negative 证据抽取。sentiment 禁止返回 neutral：明确好评用 positive，轻微不足、风险、抱怨或体验扣分点用 negative；无明确正负倾向的客观描述不要生成 evidenceItem。',
          },
          {
            role: 'user',
            content: buildBatchPrompt(records),
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await safeReadResponseText(response);
      throw new AiClientError('http_error', `AI API 请求失败：${response.status}${detail ? ` ${detail}` : ''}`);
    }

    const payload = (await readJsonResponse(response)) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiClientError('invalid_json', '模型没有返回 JSON 内容');
    }

    const json = parseJsonObject(content);
    const parsed = batchAiResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new AiClientError('schema_invalid', formatSchemaError(parsed.error));
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof AiClientError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiClientError('timeout', `AI API 请求超时（${Math.ceil(timeoutMs / 1000)}秒未返回）`);
    }
    if (error instanceof TypeError) {
      throw new AiClientError('network_error', `AI API 网络请求失败：${error.message || 'Failed to fetch'}`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function mergeEvidenceTopics(params: {
  config: AiConfig;
  candidates: TopicMergeCandidate[];
  topN: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TopicMergeResult> {
  const { config, candidates, timeoutMs = ANALYSIS_TIMEOUT_MS } = params;
  const fetchImpl = params.fetchImpl ?? fetch;

  if (!config.apiKey.trim()) {
    throw new AiClientError('missing_key', 'API Key 缺失');
  }

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
              '你是通用评论主题归并助手。只输出一个严格 JSON 对象，不要输出 Markdown。输入里的 quotes 已经过程序校验为评论原文片段；你的任务是把同义或近义的 sourceLabel 归入 topicGroups，并明确区分 category、mergeKey、displayTopic。sentiment 只能是 positive 或 negative，其他一律不允许；禁止返回 mixed、neutral、both、ambivalent。混合证据按主导方向归类，混合评论必须拆成 positive group 或 negative group。acceptedQuotes 只能保留与该 topicGroup 语义匹配的原文片段，不匹配的 quote 不要放入 acceptedQuotes。',
          },
          {
            role: 'user',
            content: buildTopicMergePrompt(candidates, params.topN),
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await safeReadResponseText(response);
      throw new AiClientError('http_error', `AI API 请求失败：${response.status}${detail ? ` ${detail}` : ''}`);
    }

    const payload = (await readJsonResponse(response)) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new AiClientError('invalid_json', '模型没有返回 JSON 内容');
    }
    debugLog('ai.merge.raw-content', content);

    const json = parseJsonObject(content);
    debugLog('ai.merge.parsed-json', json);
    const parsed = topicMergeResultSchema.safeParse(json);
    if (!parsed.success) {
      throw new AiClientError('schema_invalid', formatSchemaError(parsed.error));
    }
    debugLog('ai.merge.parsed-groups', parsed.data);

    return parsed.data;
  } catch (error) {
    if (error instanceof AiClientError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiClientError('timeout', `AI API 请求超时（${Math.ceil(timeoutMs / 1000)}秒未返回）`);
    }
    if (error instanceof TypeError) {
      throw new AiClientError('network_error', `AI API 网络请求失败：${error.message || 'Failed to fetch'}`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim().slice(0, 300);
  } catch {
    return '';
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();
  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/html') || /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) {
    throw new AiClientError(
      'invalid_json',
      'AI API 返回了 HTML 页面，请检查 API Base URL 是否是 OpenAI-compatible 服务地址，并确认代理转发到 /chat/completions',
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AiClientError('invalid_json', 'AI API 返回内容不是合法 JSON');
  }
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        throw new AiClientError('invalid_json', '模型返回内容不是合法 JSON');
      }
    }
    throw new AiClientError('invalid_json', '模型返回内容不是合法 JSON');
  }
}

function buildBatchPrompt(records: ReviewRecord[]): string {
  return JSON.stringify({
    task:
      '从这批评论中抽取可验证的原文证据片段。每条评论可以抽取多个 evidenceItems；同一条评论如果同时有好评点和负面点，必须分别抽取 positive 和 negative。必须返回严格 JSON，字段和类型必须完全符合 jsonContract。',
    rules: [
      'quote 必须是 content 字段里的原文连续片段，不能改写、总结或使用酒店/商家回复。',
      'aspectLabel 是这个 quote 表达的具体方面，尽量短而稳定，但不要输出最终 Top 主题。',
      '如果一条评论没有清晰观点、无明确正负倾向或没有可引用的原文片段，就不要为它生成 evidenceItem。',
      '不要因为评分高而忽略负面细节；不要因为评分低而忽略正面细节。',
      'sentiment 只能是 positive 或 negative，禁止返回 neutral；“不算太亮”“有点旧”“稍微慢”这类轻微不足也归为 negative。',
    ],
    jsonContract: {
      evidenceItems: [
        {
          recordId: 'string，关联评论 recordId',
          quote: 'string，content 中的原文连续片段',
          sentiment: 'positive 或 negative',
          aspectLabel: 'string，证据对应的方面标签',
          reason: 'string，可选，为什么这个 quote 属于该方面',
        },
      ],
    },
    records: records.map((record) => ({
      recordId: record.recordId,
      reviewId: record.reviewId,
      score: record.score,
      date: record.reviewDate,
      content: record.content,
    })),
  });
}

function buildTopicMergePrompt(candidates: TopicMergeCandidate[], topN: number): string {
  return JSON.stringify({
    task:
      '对已验证的评论证据做全局主题归并。请输出 topicGroups，而不是逐个 sourceLabel 的扁平映射。每个 group 表示一个最终 Top 主题，并通过 members 说明哪些 sourceLabel 和 quote 归入该主题。',
    rules: [
      '这是通用评论分析，不要假设一定是酒店、电商或餐饮；根据输入 quote 自身判断。',
      'sentiment 只能是 positive 或 negative，其他一律不允许；禁止返回 mixed、neutral、both、ambivalent。',
      '混合证据按主导方向归类；混合评论必须拆成 positive group 或 negative group，不允许输出 mixed group。',
      'category 是上位类目，只回答属于哪类，例如：服务、卫生、位置、设施、餐饮、房型、价格/性价比、交通、回复/售后、其他。',
      'mergeKey 是内部归并键，只用于把相近 sourceLabel 合到同一组，例如：服务态度、房间卫生、出行位置；mergeKey 不直接展示给用户。',
      `displayTopic 是 Top ${topN} 排行展示标题，必须是自然短句，像人在复盘评论时会说的话。`,
      'displayTopic 不要写成单个类目词，不要照抄 category；要根据 acceptedQuotes 和子项含义归纳，正向、负向和改进建议都要自然具体。',
      'displayTopic 不要使用四字成语、四字口号或生硬标签；优先写成 6-14 个中文字左右的自然短句。',
      'acceptedQuotes 只能从对应 candidate.quotes 中选择，不能改写或新增。',
      '每个输入 candidate 的 sourceLabel 都应出现在一个 group.members 里；如果没有任何 quote 匹配该主题，acceptedQuotes 返回空数组。',
      'summary 要用证据片段解释这个主题，action 要写成能落地的改进建议，避免“持续优化”“提升体验”这类空泛表达。',
    ],
    fieldExamples: [
      {
        category: '服务',
        mergeKey: '服务态度',
        displayTopic: '服务热情，沟通顺畅',
      },
      {
        category: '卫生',
        mergeKey: '房间卫生',
        displayTopic: '卫生做得很好，打扫得很及时',
      },
      {
        category: '位置',
        mergeKey: '出行位置',
        displayTopic: '地理位置好，出行方便',
      },
    ],
    wordingExamples: {
      positive: [
        '地理位置好，出行方便',
        '卫生做得很好，打扫得很及时',
        '服务热情，沟通顺畅',
        '房间住着舒服',
      ],
      negative: ['房间有噪音，影响休息', '价格偏高，和预期不太匹配', '入住办理有点慢'],
      avoid: ['黄金地段', '洁净如初', '宾至如归', '设施完善'],
    },
    jsonContract: {
      groups: [
        {
          mergeKey: 'string，内部归并键，不直接展示',
          sentiment: 'positive 或 negative，其他一律不允许',
          category: 'string，上位类目，例如 服务/卫生/位置',
          displayTopic: 'string，最终榜单展示标题，不能是单个类目词',
          summary: 'string，主题总结',
          action: 'string，可选，negative 主题的建议动作',
          members: [
            {
              sourceLabel: 'string，必须等于输入 candidate.sourceLabel',
              acceptedQuotes: ['string，只能来自对应 candidate.quotes，且必须语义匹配该 topicGroup'],
            },
          ],
        },
      ],
    },
    candidates,
  });
}

function normalizeModelEvidenceItem(item: ModelEvidenceItem): TopicEvidenceItem[] {
  const quote = item.quote.trim();
  const aspectLabel = item.aspectLabel.trim();
  const reason = item.reason?.trim() || undefined;

  if (item.sentiment === 'positive' || item.sentiment === 'negative') {
    return [
      {
        recordId: item.recordId,
        quote,
        sentiment: item.sentiment,
        aspectLabel,
        reason,
      },
    ];
  }

  if (!hasMildNegativeCue({ quote, aspectLabel, reason })) {
    return [];
  }

  return [
    {
      recordId: item.recordId,
      quote,
      sentiment: 'negative',
      aspectLabel,
      reason,
    },
  ];
}

function hasMildNegativeCue(item: { quote: string; aspectLabel: string; reason?: string }): boolean {
  const text = `${item.quote} ${item.aspectLabel} ${item.reason ?? ''}`.toLocaleLowerCase();
  return MILD_NEGATIVE_CUE_PATTERNS.some((pattern) => pattern.test(text));
}

const MILD_NEGATIVE_CUE_PATTERNS = [
  /不算太/,
  /不太/,
  /不够/,
  /不足/,
  /欠佳/,
  /一般/,
  /有点/,
  /稍微/,
  /稍有/,
  /略/,
  /偏[贵高低小暗硬软冷热远旧]/,
  /太(贵|吵|小|暗|亮|冷|热|硬|软|慢|远|旧)/,
  /比较(旧|吵|贵|小|暗|冷|热|慢|远)/,
  /缺少/,
  /异味/,
  /噪音/,
  /老化/,
  /拥挤/,
  /排队/,
  /潮/,
  /脏/,
  /乱/,
  /差/,
  /失望/,
  /投诉/,
  /麻烦/,
  /不方便/,
  /不舒服/,
  /不满意/,
  /不推荐/,
  /不值得/,
  /not (?:bright|good|clean|comfortable|convenient) enough/,
  /too (?:dark|bright|old|small|slow|expensive|noisy|cold|hot)/,
  /\b(?:dim|noisy|smell|dirty|old|slow|expensive|problem|bad)\b/,
] as const;

function formatSchemaError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '(root)';
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      return `缺少字段 ${path}`;
    }
    if (issue.code === 'invalid_type') {
      return `字段 ${path} 类型错误：期望 ${issue.expected}，实际 ${issue.received}`;
    }
    return `${path}: ${issue.message}`;
  });
  return `模型返回 JSON 不符合结构要求：${issues.join('；')}`;
}
