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
    expect(prompt).toContain('不算太远');
    expect(prompt).toContain('不能仅凭“不算”判为 negative');
    expect(prompt).toContain('赶车需要提前规划');
  });

  it('deduplicates repeated evidence and asks the model to limit evidence per review', async () => {
    const repeatedQuote = '房间宽敞舒适，设备新，私汤舒适度高，酒店环境适合出游度假，餐厅味道不错';
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  evidenceItems: [
                    ...Array.from({ length: 3 }, () => ({
                      recordId: 'rec1',
                      quote: repeatedQuote,
                      sentiment: 'positive',
                      aspectLabel: '房间舒适度',
                    })),
                    {
                      recordId: 'rec1',
                      quote: repeatedQuote,
                      sentiment: 'positive',
                      aspectLabel: '私汤舒适度',
                    },
                    {
                      recordId: 'rec1',
                      quote: repeatedQuote,
                      sentiment: 'positive',
                      aspectLabel: '度假氛围',
                    },
                    {
                      recordId: 'rec1',
                      quote: repeatedQuote,
                      sentiment: 'positive',
                      aspectLabel: '餐厅菜品口味',
                    },
                    {
                      recordId: 'rec1',
                      quote: repeatedQuote,
                      sentiment: 'positive',
                      aspectLabel: '服务态度',
                    },
                    {
                      recordId: 'rec2',
                      quote: '位置很好',
                      sentiment: 'positive',
                      aspectLabel: '位置便利',
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

    const evidenceItems = result.evidenceItems ?? [];

    expect(evidenceItems.filter((item) => item.recordId === 'rec1')).toMatchObject([
      {
        recordId: 'rec1',
        quote: repeatedQuote,
        sentiment: 'positive',
        aspectLabel: '房间舒适度',
      },
    ]);
    expect(evidenceItems.find((item) => item.recordId === 'rec2')).toMatchObject({
      recordId: 'rec2',
      quote: '位置很好',
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = JSON.parse(body.messages.find((message) => message.role === 'user')?.content ?? '{}') as {
      limits: {
        maxItemsPerRecord: number;
        maxItemsTotal: number;
      };
      recordIds: string[];
      records: Array<{ recordId: string }>;
    };
    const prompt = body.messages.map((message) => message.content).join('\n');
    expect(userPrompt.limits).toEqual({
      maxItemsPerRecord: 4,
      maxItemsTotal: records.length * 4,
    });
    expect(userPrompt.recordIds).toEqual(['rec1']);
    expect(userPrompt.records.map((record) => record.recordId)).toEqual(userPrompt.recordIds);
    expect(prompt).toContain('每条评论最多返回 4 个 evidenceItems');
    expect(prompt).toContain('本批总数最多返回 records.length * maxItemsPerRecord 条');
    expect(prompt).toContain('maxItemsTotal');
    expect(prompt).toContain('输出前逐一核对 recordIds');
    expect(prompt).toContain('同一个 quote 在同一条评论里只能返回一次');
  });

  it('merges evidence candidates into topic groups with separate category, merge key, and display topic', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  topicGroups: [
                    {
                      groupId: 'g1',
                      mergeKey: '位置便利',
                      sentiment: 'positive',
                      category: '位置',
                      displayTopic: '地理位置好，出行方便',
                      summary: '客人认可位置便利。',
                    },
                  ],
                  assignments: [
                    {
                      candidateId: 'c001',
                      groupId: 'g1',
                      acceptedQuotes: ['位置很好'],
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
          id: 'c001',
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
          candidateId: 'c001',
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
    const userPrompt = JSON.parse(body.messages.find((message) => message.role === 'user')?.content ?? '{}') as {
      candidates: Array<{ id?: string; sourceLabel: string }>;
    };
    expect(userPrompt.candidates[0]).toMatchObject({ id: 'c001', sourceLabel: '地理位置优越' });
    expect(prompt).toContain('displayTopic');
    expect(prompt).toContain('mergeKey');
    expect(prompt).toContain('candidateId');
    expect(prompt).toContain('category 是上位类目');
    expect(prompt).toContain('sentiment 只能是 positive 或 negative，其他一律不允许');
    expect(prompt).toContain('禁止返回 mixed、neutral、both、ambivalent');
    expect(prompt).toContain('混合证据按主导方向归类');
    expect(prompt).toContain('只输出 mappings');
    expect(prompt).toContain('mappings.length 必须等于 candidateIds.length');
    expect(prompt).toContain('输出前逐一核对 candidateIds');
    expect(prompt).toContain('即使某个 candidate 看起来像弱负面');
    expect(prompt).toContain('positive candidate 必须生成 positive mapping');
    expect(prompt).toContain('negative candidate 必须生成 negative mapping');
    expect(prompt).not.toContain('请输出 groups');
    expect(prompt).not.toContain('优先返回 topicGroups+assignments');
    expect(prompt).toContain('地理位置好，出行方便');
    expect(prompt).toContain('卫生做得很好，打扫得很及时');
  });

  it('prompts topic merge as full coverage mapping instead of TopN filtering and accepts omitted quotes', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  groups: [
                    {
                      mergeKey: '服务响应',
                      sentiment: 'positive',
                      category: '服务',
                      displayTopic: '服务响应快，沟通顺畅',
                      summary: '客人认可服务响应速度。',
                      members: [
                        {
                          candidateId: 'c001',
                          sourceLabel: '服务响应速度',
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
          id: 'c001',
          sourceLabel: '服务响应速度',
          sentiment: 'positive',
          count: 2,
          quotes: ['响应很快', '沟通顺畅'],
        },
      ],
      fetchImpl,
    });

    expect(result.groups[0].members[0]).toEqual({
      candidateId: 'c001',
      sourceLabel: '服务响应速度',
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages.map((message) => message.content).join('\n');
    const userPrompt = JSON.parse(body.messages.find((message) => message.role === 'user')?.content ?? '{}') as {
      candidateIds?: string[];
    };
    expect(userPrompt.candidateIds).toEqual(['c001']);
    expect(prompt).toContain('不是筛选 TopN');
    expect(prompt).toContain('TopN 只由程序后续排序截断');
    expect(prompt).toContain('acceptedQuotes 可以省略');
  });

  it('accepts flat topic mappings and groups them locally by merge key', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mappings: [
                    {
                      candidateId: 'c001',
                      sourceLabel: '房间空间',
                      sentiment: 'positive',
                      mergeKey: '房间空间采光',
                      category: '房型',
                      displayTopic: '房间宽敞，采光也好',
                      summary: '客人认可房间空间和采光。',
                      acceptedQuotes: ['房间很大'],
                    },
                    {
                      candidateId: 'c002',
                      sourceLabel: '房间采光',
                      sentiment: 'positive',
                      mergeKey: '房间空间采光',
                      category: '房型',
                      displayTopic: '房间宽敞，采光也好',
                      summary: '客人认可房间空间和采光。',
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
          id: 'c001',
          sourceLabel: '房间空间',
          sentiment: 'positive',
          count: 1,
          quotes: ['房间很大'],
        },
        {
          id: 'c002',
          sourceLabel: '房间采光',
          sentiment: 'positive',
          count: 1,
          quotes: ['采光很好'],
        },
      ],
      fetchImpl,
    });

    expect(result.groups).toEqual([
      {
        mergeKey: '房间空间采光',
        sentiment: 'positive',
        category: '房型',
        displayTopic: '房间宽敞，采光也好',
        summary: '客人认可房间空间和采光。',
        action: undefined,
        members: [
          {
            candidateId: 'c001',
            sourceLabel: '房间空间',
            acceptedQuotes: ['房间很大'],
          },
          {
            candidateId: 'c002',
            sourceLabel: '房间采光',
          },
        ],
      },
    ]);
  });

  it('asks the model for one mapping per candidate and includes retry feedback when provided', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mappings: [
                    {
                      candidateId: 'c001',
                      sourceLabel: '服务态度',
                      sentiment: 'positive',
                      mergeKey: '服务态度',
                      category: '服务',
                      displayTopic: '服务热情，沟通顺畅',
                      summary: '客人认可服务。',
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

    await mergeEvidenceTopics({
      config,
      topN: 10,
      candidates: [
        {
          id: 'c001',
          sourceLabel: '服务态度',
          sentiment: 'positive',
          count: 1,
          quotes: ['服务热情'],
        },
      ],
      previousErrorMessage: '好评主题合并结果无效：AI 主题归并漏掉候选标签：positive|服务态度',
      fetchImpl,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const requestBody = JSON.parse(String(init.body));
    const systemMessage = requestBody.messages[0].content as string;
    const prompt = JSON.parse(requestBody.messages[1].content as string);

    expect(systemMessage).toContain('为每个 candidate 生成一条 mapping');
    expect(prompt.task).toContain('只输出 mappings');
    expect(prompt.rules.join('\n')).toContain('mappings.length 必须等于 candidateIds.length');
    expect(prompt.rules.join('\n')).not.toContain('优先输出 topicGroups + assignments');
    expect(prompt.previousErrorMessage).toBe('好评主题合并结果无效：AI 主题归并漏掉候选标签：positive|服务态度');
    expect(prompt.jsonContract).toEqual({
      mappings: [
        {
          candidateId: 'string，必须等于输入 candidate.id',
          sourceLabel: 'string，必须等于输入 candidate.sourceLabel',
          sentiment: 'positive 或 negative，必须等于输入 candidate.sentiment',
          mergeKey: 'string，内部归并键，不直接展示',
          category: 'string，上位类目，例如 服务/卫生/位置',
          displayTopic: 'string，最终榜单展示标题，不能是单个类目词',
          summary: 'string，主题总结',
          acceptedQuotes: ['string，可选；只在需要过滤 quote 时返回，只能来自对应 candidate.quotes'],
          action: 'string，可选，negative 主题的建议动作',
        },
      ],
    });
  });

  it('accepts compact topic groups and assignment mappings to reduce model output size', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  topicGroups: [
                    {
                      groupId: 'g1',
                      sentiment: 'positive',
                      mergeKey: '房间空间采光',
                      category: '房型',
                      displayTopic: '房间宽敞，采光也好',
                      summary: '客人认可房间空间和采光。',
                    },
                  ],
                  assignments: [
                    {
                      candidateId: 'c001',
                      groupId: 'g1',
                      acceptedQuotes: ['房间很大'],
                    },
                    {
                      candidateId: 'c002',
                      groupId: 'g1',
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
          id: 'c001',
          sourceLabel: '房间空间',
          sentiment: 'positive',
          count: 1,
          quotes: ['房间很大'],
        },
        {
          id: 'c002',
          sourceLabel: '房间采光',
          sentiment: 'positive',
          count: 1,
          quotes: ['采光很好'],
        },
      ],
      fetchImpl,
    });

    expect(result.groups).toEqual([
      {
        mergeKey: '房间空间采光',
        sentiment: 'positive',
        category: '房型',
        displayTopic: '房间宽敞，采光也好',
        summary: '客人认可房间空间和采光。',
        action: undefined,
        members: [
          {
            candidateId: 'c001',
            sourceLabel: '房间空间',
            acceptedQuotes: ['房间很大'],
          },
          {
            candidateId: 'c002',
            sourceLabel: '房间采光',
            acceptedQuotes: undefined,
          },
        ],
      },
    ]);
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

  it('uses the configured request timeout duration for analysis requests', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    try {
      const promise = analyzeBatch({
        config: { ...config, requestTimeoutSeconds: 600 },
        records,
        fetchImpl,
      });
      const expectation = expect(promise).rejects.toMatchObject({
        code: 'timeout',
        message: 'AI API 请求超时（600秒未返回）',
      });

      await vi.advanceTimersByTimeAsync(600_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the configured request timeout duration for topic merge requests', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    try {
      const promise = mergeEvidenceTopics({
        config: { ...config, requestTimeoutSeconds: 600 },
        topN: 10,
        candidates: [
          {
            id: 'c001',
            sourceLabel: '地理位置优越',
            sentiment: 'positive',
            count: 2,
            quotes: ['位置很好'],
          },
        ],
        fetchImpl,
      });
      const expectation = expect(promise).rejects.toMatchObject({
        code: 'timeout',
        message: 'AI API 请求超时（600秒未返回）',
      });

      await vi.advanceTimersByTimeAsync(600_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws a typed error when model content is not valid JSON', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 });
    });

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toBeInstanceOf(AiClientError);
    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('includes a raw content preview when model content is not valid JSON', async () => {
    const rawContent = 'not json at all';
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: rawContent } }] }), { status: 200 });
    });

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({
      code: 'invalid_json',
      details: {
        source: 'model_content',
        preview: rawContent,
        rawLength: rawContent.length,
      },
    });
  });

  it('classifies unfinished JSON object responses as truncated model output', async () => {
    const rawContent = '{"evidenceItems":[{"recordId":"rec1","quote":"位置很好"';
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: rawContent } }] }), { status: 200 });
    });

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({
      code: 'truncated_json',
      message: '模型返回内容疑似被截断，不是合法 JSON',
      details: {
        source: 'model_content',
        preview: rawContent,
        rawLength: rawContent.length,
      },
    });
  });

  it('reports HTML responses before trying to parse chat completion payloads', async () => {
    const fetchImpl = vi.fn(async () => new Response('<!doctype html><html></html>', { status: 200 }));

    await expect(analyzeBatch({ config, records, fetchImpl })).rejects.toMatchObject({
      code: 'invalid_json',
      message: expect.stringContaining('AI API 返回了 HTML 页面'),
    });
  });
});
