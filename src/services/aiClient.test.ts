import { describe, expect, it, vi } from 'vitest';
import type { AiConfig } from '../types/config';
import type { ReviewRecord } from '../types/analysis';
import { AiClientError, analyzeBatch, mergeEvidenceTopics, normalizeChatCompletionsUrl, testAiConnection } from './aiClient';

const config: AiConfig = {
  apiBaseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  maxBatchSize: 80,
  topN: 10,
};

const records: ReviewRecord[] = [
  {
    recordId: 'rec1',
    reviewId: '1',
    hotelName: '昆明中维翠湖宾馆',
    score: 5,
    reviewDate: '2026-06-01 10:00:00',
    checkInMonth: '2026-06-01 00:00:00',
    roomType: '大床房',
    hasReply: false,
    replyContent: '',
    content: '位置很好，服务热情。',
  },
];

describe('normalizeChatCompletionsUrl', () => {
  it('accepts both API base and full chat completions URL', () => {
    expect(normalizeChatCompletionsUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
    expect(normalizeChatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('throws a typed error when API base URL is missing', () => {
    expect(() => normalizeChatCompletionsUrl('')).toThrow(AiClientError);
  });

  it('throws a typed error when API base URL is not an absolute http URL', () => {
    expect(() => normalizeChatCompletionsUrl('user@example.com')).toThrow(AiClientError);
    expect(() => normalizeChatCompletionsUrl('user@example.com')).toThrow('API Base URL 必须是 http(s):// 开头的完整地址');
  });
});

describe('testAiConnection', () => {
  it('posts a small Chat Completions request to the configured API', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200 },
      );
    });

    const result = await testAiConnection({ config, fetchImpl });

    expect(result).toEqual({ url: 'https://api.example.com/v1/chat/completions', model: 'gpt-4o-mini' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );
  });

  it('surfaces HTTP status and response text when connection test fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('model not found', { status: 404 }));

    await expect(testAiConnection({ config, fetchImpl })).rejects.toMatchObject({
      code: 'http_error',
      message: expect.stringContaining('404 model not found'),
    });
  });

  it('reports HTML responses as API base URL or proxy configuration errors', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 }));

    await expect(testAiConnection({ config, fetchImpl })).rejects.toMatchObject({
      code: 'invalid_json',
      message: expect.stringContaining('AI API 返回了 HTML 页面'),
    });
  });
});

describe('analyzeBatch', () => {
  it('posts OpenAI-compatible request and validates evidence-first batch JSON', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: {
                    positiveCount: 1,
                    negativeCount: 0,
                    mixedCount: 0,
                    neutralCount: 0,
                  },
                  evidenceItems: [
                    {
                      recordId: 'rec1',
                      quote: '位置很好',
                      sentiment: 'positive',
                      aspectLabel: '位置便利',
                      reason: '客人认可酒店位置。',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await analyzeBatch({ config, records, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test',
        }),
      }),
    );
    expect(result.evidenceItems?.[0]).toMatchObject({
      recordId: 'rec1',
      quote: '位置很好',
      aspectLabel: '位置便利',
    });
  });

  it('reports missing required fields and invalid types from model responses', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  evidenceItems: [
                    {
                      recordId: 'rec1',
                      quote: 1,
                      sentiment: 'positive',
                      aspectLabel: '服务热情',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({
      code: 'schema_invalid',
      message: expect.stringContaining('字段 evidenceItems.0.quote 类型错误：期望 string，实际 number'),
    });
  });

  it('keeps neutral model evidence from failing the batch while preserving mild negative cues', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  evidenceItems: [
                    {
                      recordId: 'rec1',
                      quote: '房间灯光是暖黄色调的，不算太亮。',
                      sentiment: 'neutral',
                      aspectLabel: '房间灯光',
                      reason: '客观描述里包含亮度不足的轻微负面体验。',
                    },
                    {
                      recordId: 'rec1',
                      quote: '房间灯光是暖黄色调的',
                      sentiment: 'neutral',
                      aspectLabel: '房间灯光',
                      reason: '仅描述色调，没有明确正负倾向。',
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await analyzeBatch({ config, records, fetchImpl });

    expect(result.evidenceItems).toEqual([
      {
        recordId: 'rec1',
        quote: '房间灯光是暖黄色调的，不算太亮。',
        sentiment: 'negative',
        aspectLabel: '房间灯光',
        reason: '客观描述里包含亮度不足的轻微负面体验。',
      },
    ]);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('禁止返回 neutral');
    expect(prompt).toContain('无明确正负倾向');
  });

  it('merges evidence candidates into topic groups with separate category, merge key, and display topic', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [
                    {
                      mergeKey: '位置便利',
                      sentiment: 'positive',
                      category: '位置',
                      displayTopic: '地理位置好，出行方便',
                      summary: '客人认可位置便利。',
                      members: [
                        {
                          sourceLabel: '地理位置优越',
                          acceptedQuotes: ['位置很好'],
                        },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const result = await mergeEvidenceTopics({
      config,
      topN: 10,
      candidates: [
        {
          sourceLabel: '地理位置优越',
          sentiment: 'positive',
          count: 2,
          quotes: ['位置很好', '雪花酥很好吃'],
        },
      ],
      fetchImpl,
    });

    expect(result.groups[0]).toMatchObject({
      mergeKey: '位置便利',
      category: '位置',
      displayTopic: '地理位置好，出行方便',
      members: [
        {
          sourceLabel: '地理位置优越',
          acceptedQuotes: ['位置很好'],
        },
      ],
    });

    expect(fetchImpl).toHaveBeenCalled();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('displayTopic');
    expect(prompt).toContain('mergeKey');
    expect(prompt).toContain('category 是上位类目');
    expect(prompt).toContain('sentiment 只能是 positive 或 negative，其他一律不允许');
    expect(prompt).toContain('禁止返回 mixed、neutral、both、ambivalent');
    expect(prompt).toContain('混合证据按主导方向归类');
    expect(prompt).toContain('地理位置好，出行方便');
    expect(prompt).toContain('卫生做得很好，打扫得很及时');
  });

  it('throws a typed error when the API key is missing', async () => {
    await expect(analyzeBatch({ config: { ...config, apiKey: '' }, records, fetchImpl: fetch })).rejects.toMatchObject({
      code: 'missing_key',
    });
  });

  it('reports the analysis timeout duration when the model does not return', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    await expect(analyzeBatch({ config, records, fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'timeout',
      message: 'AI API 请求超时（1秒未返回）',
    });
  });

  it('throws a typed error when model content is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 });
    });

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toBeInstanceOf(AiClientError);
    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('reports HTML responses before trying to parse chat completion payloads', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 }));

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({
      code: 'invalid_json',
      message: expect.stringContaining('AI API 返回了 HTML 页面'),
    });
  });
});
