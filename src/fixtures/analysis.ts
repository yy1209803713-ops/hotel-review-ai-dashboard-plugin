import type { AnalyzeBatchImpl } from '../services/analysisPipeline';
import type { AnalysisResult, BatchAiResult, TopicEvidenceItem } from '../types/analysis';

export const FIXTURE_ANALYSIS_RESULT: AnalysisResult = {
  analysisId: 'analysis-fixture-20260603',
  generatedAt: '2026-06-03T12:00:00+08:00',
  model: 'fixture-ai',
  status: 'complete',
  scope: {
    hotelName: '昆明中维翠湖宾馆',
    periodType: 'month',
    startDate: '2026-06-01',
    endDate: '2026-06-30',
  },
  overview: {
    totalReviews: 5,
    positiveReviews: 3,
    negativeOrRiskReviews: 2,
    mixedReviews: 1,
    neutralReviews: 0,
    averageScore: 4.54,
    replyRate: 0.4,
  },
  positiveTopics: [
    {
      mergeKey: '位置优越',
      topic: '位置绝佳，紧邻翠湖',
      displayTopic: '位置绝佳，紧邻翠湖',
      category: '位置',
      count: 4,
      sentiment: 'positive',
      commentRecordIds: ['rec27ww4KBxDj2', 'rec27ww4KBxDCf', 'rec27ww4KBxE2y', 'recFixtureRisk02'],
      evidencePhrases: ['位置没得说', '离翠湖踏脚就到', '出行方便'],
      summary: '客人高频认可酒店紧邻翠湖，步行游览和城市出行都方便。',
    },
    {
      mergeKey: '服务热情',
      topic: '服务热情响应快',
      displayTopic: '服务热情响应快',
      category: '服务',
      count: 3,
      sentiment: 'positive',
      commentRecordIds: ['rec27ww4KBxDj2', 'rec27ww4KBxDCf', 'recFixtureRisk02'],
      evidencePhrases: ['服务超一流', '前台小王', '服务热情'],
      summary: '前台与服务人员的响应速度、主动性和礼貌程度形成明显好评点。',
    },
    {
      mergeKey: '早餐体验',
      topic: '早餐与甜品体验好',
      displayTopic: '早餐与甜品体验好',
      category: '餐饮',
      count: 1,
      sentiment: 'positive',
      commentRecordIds: ['rec27ww4KBxE2y'],
      evidencePhrases: ['早餐米线非常好吃', '银耳汤很好喝'],
      summary: '米线和夜间饮品成为少量但鲜明的餐饮记忆点。',
    },
  ],
  negativeTopics: [
    {
      mergeKey: '卫浴不便',
      topic: '设施老化 / 卫浴不便',
      displayTopic: '设施老化 / 卫浴不便',
      category: '设施',
      count: 2,
      sentiment: 'negative',
      commentRecordIds: ['rec27ww4KBxDj2', 'recFixtureRisk01'],
      evidencePhrases: ['时间痕迹', '莲蓬老化', '洗漱不方便'],
      summary: '部分客人能接受老牌酒店气质，但卫浴和设施维护仍是风险点。',
      action: '优先排查卫浴设施、莲蓬和水压问题，并在回复中说明具体整改动作。',
    },
    {
      mergeKey: '床品不适',
      topic: '枕头或床品不适',
      displayTopic: '枕头或床品不适',
      category: '房型',
      count: 1,
      sentiment: 'negative',
      commentRecordIds: ['recFixtureRisk01'],
      evidencePhrases: ['枕头也不舒服'],
      summary: '床品舒适度的个体差异会拉低住宿体验。',
      action: '提供备选枕型，并在入住服务中主动提示。',
    },
    {
      mergeKey: '毛巾卫生',
      topic: '毛巾潮湿 / 更换不及时',
      displayTopic: '毛巾潮湿 / 更换不及时',
      category: '卫生',
      count: 1,
      sentiment: 'negative',
      commentRecordIds: ['recFixtureRisk02'],
      evidencePhrases: ['毛巾感觉潮', '没有及时更换'],
      summary: '续住清洁细节会影响高分评论中的负面感受。',
      action: '强化续住客房毛巾更换 SOP，增加客房复核。',
    },
  ],
  actionItems: [
    {
      id: 'action-1',
      title: '优先处理：设施老化 / 卫浴不便',
      description: '优先排查卫浴设施、莲蓬和水压问题，并在回复中说明具体整改动作。',
      impactCount: 2,
      topic: '设施老化 / 卫浴不便',
    },
    {
      id: 'action-2',
      title: '优先处理：枕头或床品不适',
      description: '提供备选枕型，并在入住服务中主动提示。',
      impactCount: 1,
      topic: '枕头或床品不适',
    },
    {
      id: 'action-3',
      title: '优先处理：毛巾潮湿 / 更换不及时',
      description: '强化续住客房毛巾更换 SOP，增加客房复核。',
      impactCount: 1,
      topic: '毛巾潮湿 / 更换不及时',
    },
  ],
};

export const fixtureAnalyzeBatch: AnalyzeBatchImpl = async ({ records }): Promise<BatchAiResult> => {
  return {
    evidenceItems: records.flatMap((record) => fixtureEvidenceForRecord(record)),
  };
};

function fixtureEvidenceForRecord(record: { recordId: string; content: string }) {
  const evidenceItems: TopicEvidenceItem[] = [];
  const positiveQuote = firstMatch(record.content, ['位置没得说', '紧邻翠湖', '出行方便', '服务热情', '早餐米线非常好吃']);
  const negativeQuote = firstMatch(record.content, ['设施有点老', '莲蓬老化', '洗漱不方便', '不舒服', '毛巾感觉潮']);

  if (positiveQuote) {
    evidenceItems.push({
      recordId: record.recordId,
      quote: positiveQuote,
      sentiment: 'positive',
      aspectLabel: /服务/.test(positiveQuote) ? '服务体验' : '位置便利',
    });
  }

  if (negativeQuote) {
    evidenceItems.push({
      recordId: record.recordId,
      quote: negativeQuote,
      sentiment: 'negative',
      aspectLabel: /毛巾|潮/.test(negativeQuote) ? '卫生细节' : '设施体验',
    });
  }

  return evidenceItems;
}

function firstMatch(content: string, phrases: string[]): string | null {
  return phrases.find((phrase) => content.includes(phrase)) ?? null;
}
