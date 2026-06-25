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
  | 'truncated_json'
  | 'schema_invalid';

export type AiClientErrorDetails = {
  source?: 'api_response' | 'model_content';
  preview?: string;
  rawLength?: number;
  [key: string]: unknown;
};

export class AiClientError extends Error {
  constructor(
    public readonly code: AiClientErrorCode,
    message: string,
    public readonly details?: AiClientErrorDetails,
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
  evidenceItems: limitEvidenceItemsByRecord(deduplicateEvidenceItems(result.evidenceItems.flatMap(normalizeModelEvidenceItem))),
}));

const topicMappingItemSchema = z.object({
  candidateId: z.string().optional(),
  sourceLabel: z.string(),
  sentiment: z.enum(['positive', 'negative']),
  mergeKey: z.string(),
  category: z.string(),
  displayTopic: z.string(),
  summary: z.string(),
  acceptedQuotes: z.array(z.string()).optional(),
  action: z.string().optional(),
});

const compactTopicGroupSchema = z.object({
  groupId: z.string(),
  sentiment: z.enum(['positive', 'negative']),
  mergeKey: z.string(),
  category: z.string(),
  displayTopic: z.string(),
  summary: z.string(),
  action: z.string().optional(),
});

const compactTopicAssignmentSchema = z
  .object({
    candidateId: z.string().optional(),
    sourceLabel: z.string().optional(),
    sentiment: z.enum(['positive', 'negative']).optional(),
    groupId: z.string(),
    acceptedQuotes: z.array(z.string()).optional(),
  })
  .refine((assignment) => Boolean(assignment.candidateId || assignment.sourceLabel), {
    message: 'assignment 必须包含 candidateId 或 sourceLabel',
  });

const topicMergeGroupSchema = z.object({
  mergeKey: z.string(),
  sentiment: z.enum(['positive', 'negative']),
  category: z.string(),
  displayTopic: z.string(),
  summary: z.string(),
  action: z.string().optional(),
  members: z.array(
    z.object({
      candidateId: z.string().optional(),
      sourceLabel: z.string(),
      acceptedQuotes: z.array(z.string()).optional(),
    }),
  ),
});

const topicMergeResultSchema = z
  .object({
    groups: z.array(topicMergeGroupSchema).optional(),
    mappings: z.array(topicMappingItemSchema).optional(),
    topicGroups: z.array(compactTopicGroupSchema).optional(),
    assignments: z.array(compactTopicAssignmentSchema).optional(),
  })
  .refine((result) => Boolean(
    result.groups?.length ||
      result.mappings?.length ||
      (result.topicGroups?.length && result.assignments?.length),
  ), {
    message: '模型返回内容没有 groups、mappings 或 topicGroups+assignments',
  });

type TopicMappingItem = z.infer<typeof topicMappingItemSchema>;
type CompactTopicGroup = z.infer<typeof compactTopicGroupSchema>;
type CompactTopicAssignment = z.infer<typeof compactTopicAssignmentSchema>;

const CONNECTION_TEST_TIMEOUT_MS = 20000;
const ANALYSIS_TIMEOUT_MS = 180000;
const TOPIC_MERGE_PROMPT_QUOTE_LIMIT = 4;
const MAX_EVIDENCE_ITEMS_PER_RECORD = 4;

function mappingsToGroups(mappings: TopicMappingItem[], candidates: TopicMergeCandidate[]): TopicMergeResult {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateByKey = new Map(
    candidates.map((candidate) => [`${candidate.sentiment}|${normalizeTopic(candidate.sourceLabel)}`, candidate]),
  );
  const groupsByKey = new Map<string, TopicMergeResult['groups'][number]>();

  for (const mapping of mappings) {
    const candidate =
      (mapping.candidateId ? candidateById.get(mapping.candidateId) : undefined) ??
      candidateByKey.get(`${mapping.sentiment}|${normalizeTopic(mapping.sourceLabel)}`);
    if (!candidate) {
      continue;
    }
    const groupKey = `${mapping.sentiment}|${normalizeTopic(mapping.mergeKey || mapping.displayTopic)}`;
    const member = {
      candidateId: candidate.id,
      sourceLabel: candidate.sourceLabel,
      acceptedQuotes: mapping.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
    };
    const current = groupsByKey.get(groupKey);
    if (!current) {
      groupsByKey.set(groupKey, {
        mergeKey: mapping.mergeKey,
        sentiment: mapping.sentiment,
        category: mapping.category,
        displayTopic: mapping.displayTopic,
        summary: mapping.summary,
        action: mapping.action,
        members: [member],
      });
      continue;
    }

    current.members.push(member);
    if (mapping.summary.length > current.summary.length) {
      current.summary = mapping.summary;
    }
    current.action = current.action || mapping.action;
  }

  return { groups: [...groupsByKey.values()] };
}

function compactTopicMappingsToGroups(
  topicGroups: CompactTopicGroup[],
  assignments: CompactTopicAssignment[],
  candidates: TopicMergeCandidate[],
): TopicMergeResult {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateByKey = new Map(
    candidates.map((candidate) => [`${candidate.sentiment}|${normalizeTopic(candidate.sourceLabel)}`, candidate]),
  );
  const topicGroupById = new Map(topicGroups.map((group) => [group.groupId, group]));
  const groupsById = new Map<string, TopicMergeResult['groups'][number]>();

  for (const assignment of assignments) {
    const group = topicGroupById.get(assignment.groupId);
    if (!group) {
      continue;
    }
    const sentiment = assignment.sentiment ?? group.sentiment;
    const candidate =
      (assignment.candidateId ? candidateById.get(assignment.candidateId) : undefined) ??
      (assignment.sourceLabel ? candidateByKey.get(`${sentiment}|${normalizeTopic(assignment.sourceLabel)}`) : undefined);
    if (!candidate) {
      continue;
    }
    const member = {
      candidateId: candidate.id,
      sourceLabel: candidate.sourceLabel,
      acceptedQuotes: assignment.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
    };
    const current = groupsById.get(group.groupId);
    if (!current) {
      groupsById.set(group.groupId, {
        mergeKey: group.mergeKey,
        sentiment: group.sentiment,
        category: group.category,
        displayTopic: group.displayTopic,
        summary: group.summary,
        action: group.action,
        members: [member],
      });
      continue;
    }
    current.members.push(member);
  }

  return { groups: [...groupsById.values()] };
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}

function resolveAnalysisTimeoutMs(config: AiConfig, overrideTimeoutMs?: number): number {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return Math.floor(overrideTimeoutMs);
  }

  if (
    typeof config.requestTimeoutSeconds === 'number' &&
    Number.isFinite(config.requestTimeoutSeconds) &&
    config.requestTimeoutSeconds > 0
  ) {
    return Math.floor(config.requestTimeoutSeconds * 1000);
  }

  return ANALYSIS_TIMEOUT_MS;
}

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
  const { config, records } = params;
  const timeoutMs = resolveAnalysisTimeoutMs(config, params.timeoutMs);
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
    debugLog('ai.batch.raw-content', content);

    const json = parseJsonObject(content);
    debugLog('ai.batch.parsed-json', json);
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
  const { config, candidates } = params;
  const timeoutMs = resolveAnalysisTimeoutMs(config, params.timeoutMs);
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
              '你是通用评论主题映射助手。只输出一个严格 JSON 对象，不要输出 Markdown。输入里的 quotes 已经过程序校验为评论原文片段；你的任务是为每个 candidate 生成一条 mapping，程序会在本地按 mergeKey 合并成主题。sentiment 只能是 positive 或 negative，其他一律不允许；禁止返回 mixed、neutral、both、ambivalent。acceptedQuotes 是可选字段，只在需要剔除不匹配片段时返回；不返回 acceptedQuotes 表示该 candidate 的全部 quotes 都匹配该 mapping。',
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
    const result = parsed.data.topicGroups?.length && parsed.data.assignments?.length
      ? compactTopicMappingsToGroups(parsed.data.topicGroups, parsed.data.assignments, candidates)
      : parsed.data.mappings?.length
        ? mappingsToGroups(parsed.data.mappings, candidates)
        : { groups: parsed.data.groups ?? [] };
    debugLog('ai.merge.parsed-groups', result);

    return result;
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
      createRawContentDetails('api_response', text),
    );
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    throw new AiClientError('invalid_json', 'AI API 返回内容不是合法 JSON', createRawContentDetails('api_response', text));
  }
}

function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const details = createRawContentDetails('model_content', content);

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        if (looksLikeTruncatedJson(trimmed)) {
          throw new AiClientError('truncated_json', '模型返回内容疑似被截断，不是合法 JSON', details);
        }
        throw new AiClientError('invalid_json', '模型返回内容不是合法 JSON', details);
      }
    }
    if (looksLikeTruncatedJson(trimmed)) {
      throw new AiClientError('truncated_json', '模型返回内容疑似被截断，不是合法 JSON', details);
    }
    throw new AiClientError('invalid_json', '模型返回内容不是合法 JSON', details);
  }
}

function createRawContentDetails(source: NonNullable<AiClientErrorDetails['source']>, raw: string): AiClientErrorDetails {
  return {
    source,
    preview: previewRawContent(raw),
    rawLength: raw.length,
    rawContent: raw,
  };
}

function looksLikeTruncatedJson(trimmed: string): boolean {
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  const lastCharacter = trimmed.at(-1);
  if (lastCharacter === '}' || lastCharacter === ']') {
    return false;
  }
  return true;
}

function previewRawContent(raw: string): string {
  return raw.trim().slice(0, 2000);
}

function buildBatchPrompt(records: ReviewRecord[]): string {
  const maxItemsTotal = records.length * MAX_EVIDENCE_ITEMS_PER_RECORD;
  return JSON.stringify({
    task:
      '从这批评论中抽取可验证的原文证据片段。每条评论可以抽取多个 evidenceItems；同一条评论如果同时有好评点和负面点，必须分别抽取 positive 和 negative。必须返回严格 JSON，字段和类型必须完全符合 jsonContract。',
    rules: [
      'quote 必须是 content 字段里的原文连续片段，不能改写、总结或使用酒店/商家回复。',
      'aspectLabel 是这个 quote 表达的具体方面，必须比“服务/环境/卫生/设施/位置/service”这类上位类目更具体，例如“服务响应”“房间卫生”“周边位置”“停车便利”。',
      '每条评论最多返回 4 个 evidenceItems，只保留最能代表该评论的 1-4 个原文片段；不要把同一句长 quote 拆成很多 aspectLabel。',
      '同一个 quote 在同一条评论里只能返回一次；如果一个 quote 涉及多个方面，请选择最主要的 aspectLabel，不要重复输出。',
      '如果一条评论没有清晰观点、无明确正负倾向或没有可引用的原文片段，就不要为它生成 evidenceItem。',
      '“不算太远”“还可以”“不算差”“还行”这类缓和表述不能仅凭“不算”判为 negative；除非同一句或上下文同时出现“太远”“不方便”“赶车需要提前规划”“难找”“绕路”“台阶”等明确风险，否则不要抽取为风险证据。',
      '不要因为评分高而忽略负面细节；不要因为评分低而忽略正面细节。',
      'sentiment 只能是 positive 或 negative，禁止返回 neutral；“不算太亮”“有点旧”“稍微慢”这类轻微不足也归为 negative。',
      `本批总数最多返回 records.length * maxItemsPerRecord 条，也就是 maxItemsTotal=${maxItemsTotal} 条；输出前逐一核对 recordIds，禁止返回不在 recordIds 中的 recordId。`,
    ],
    limits: {
      maxItemsPerRecord: MAX_EVIDENCE_ITEMS_PER_RECORD,
      maxItemsTotal,
    },
    recordIds: records.map((record) => record.recordId),
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
      '对已验证的评论证据做全量主题归并。优先输出 topicGroups + assignments。topicGroups 描述最终主题组，assignments 只负责把每个 candidate 分配到某个 groupId。程序会在本地按 groupId 合并成主题；这一步不是筛选 TopN，不能因为某个候选重要性低就省略，TopN 只由程序后续排序截断。',
    rules: [
      '这是通用评论分析，不要假设一定是酒店、电商或餐饮；根据输入 quote 自身判断。',
      'sentiment 只能是 positive 或 negative，其他一律不允许；禁止返回 mixed、neutral、both、ambivalent。',
      '混合证据按主导方向归类；混合评论必须拆成 positive group 或 negative group，不允许输出 mixed group。',
      'topicGroups 里的 groupId 只做内部关联键，简短且稳定，例如 g1、g2、g3。不要把 groupId 设计成长文本。',
      'topicGroups 里的 category 是上位类目，只回答属于哪类，例如：服务、卫生、位置、设施、餐饮、房型、价格/性价比、交通、回复/售后、其他。',
      'topicGroups 里的 mergeKey 是内部归并键，只用于把相近 candidate 合到同一组，例如：服务态度、房间卫生、出行位置；mergeKey 不直接展示给用户。',
      `topicGroups 里的 displayTopic 是后续 Top ${topN} 排行可能展示的标题，必须是自然短句，像人在复盘评论时会说的话。`,
      'displayTopic 绝对不能写成“服务/环境/卫生/设施/位置/餐饮/房型/交通/其他/service”这类上位类目，也不能照抄 category；要根据证据归纳，正向、负向和改进建议都要自然具体。',
      'displayTopic 不要使用四字成语、四字口号或生硬标签；优先写成 6-14 个中文字左右的自然短句。',
      'assignments 只需要把 candidate 指到某个 groupId；每个输入 candidate 的 id 必须且只能出现在一个 assignments 里，不能漏掉、不能重复、不能返回输入里不存在的 id。',
      'assignments.length 必须等于 candidateIds.length；输出前逐一核对 candidateIds，确认每个 candidateId 都在 assignments 中出现一次。',
      '同一个 groupId 只能接收同一种 sentiment 的 candidates；positive candidate 必须分配到 positive topicGroup，negative candidate 必须分配到 negative topicGroup，绝不能混放。',
      'assignment 有 candidateId 时只输出 candidateId 和 groupId 即可，不要重复 sourceLabel 或 sentiment；只有无法使用 candidateId 时才输出 sourceLabel/sentiment。',
      '如果某个 candidate 没有任何 quote 匹配该主题，assignment 仍必须存在，但 acceptedQuotes 可以省略。',
      '即使某个 candidate 看起来像弱负面、低重要性或不适合 TopN，也必须分配到最接近的同 sentiment group，不能因为语义轻微就省略。',
      'summary 要用证据片段解释这个主题，action 要写成能落地的改进建议，避免“持续优化”“提升体验”这类空泛表达。',
      '如果你更习惯旧格式，也可以返回 mappings；程序会兼容 topicGroups+assignments、mappings 或 groups，但优先返回 topicGroups+assignments。',
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
      topicGroups: [
        {
          groupId: 'string，简短稳定的内部归并组 ID，例如 g1',
          sentiment: 'positive 或 negative，其他一律不允许',
          mergeKey: 'string，内部归并键，不直接展示',
          category: 'string，上位类目，例如 服务/卫生/位置',
          displayTopic: 'string，最终榜单展示标题，不能是单个类目词',
          summary: 'string，主题总结',
          action: 'string，可选，negative 主题的建议动作',
        },
      ],
      assignments: [
        {
          candidateId: 'string，可选但推荐，必须等于输入 candidate.id',
          sourceLabel: 'string，可选，但当不填 candidateId 时用于识别候选',
          sentiment: 'positive 或 negative，可选但建议与 candidate 一致',
          groupId: 'string，必须等于某个 topicGroups.groupId',
          acceptedQuotes: ['string，可选；只在需要过滤 quote 时返回，只能来自对应 candidate.quotes'],
        },
      ],
    },
    candidateIds: candidates.map((candidate) => candidate.id).filter((id): id is string => Boolean(id)),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      sourceLabel: candidate.sourceLabel,
      sentiment: candidate.sentiment,
      count: candidate.count,
      quotes: candidate.quotes.slice(0, TOPIC_MERGE_PROMPT_QUOTE_LIMIT),
    })),
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

function deduplicateEvidenceItems(items: TopicEvidenceItem[]): TopicEvidenceItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.recordId,
      normalizeEvidenceText(item.quote),
      item.sentiment,
      normalizeEvidenceText(item.aspectLabel),
    ].join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function limitEvidenceItemsByRecord(items: TopicEvidenceItem[]): TopicEvidenceItem[] {
  const countByRecordId = new Map<string, number>();
  const quoteByRecordId = new Map<string, Set<string>>();
  return items.filter((item) => {
    const currentCount = countByRecordId.get(item.recordId) ?? 0;
    if (currentCount >= MAX_EVIDENCE_ITEMS_PER_RECORD) {
      return false;
    }

    const quoteKey = `${item.sentiment}|${normalizeEvidenceText(item.quote)}`;
    const seenQuotes = quoteByRecordId.get(item.recordId) ?? new Set<string>();
    if (seenQuotes.has(quoteKey)) {
      return false;
    }

    seenQuotes.add(quoteKey);
    quoteByRecordId.set(item.recordId, seenQuotes);
    countByRecordId.set(item.recordId, currentCount + 1);
    return true;
  });
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
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
