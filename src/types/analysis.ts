export type ReviewRecord = {
  recordId: string;
  reviewId: string;
  hotelName: string;
  score: number | null;
  reviewDate: string | null;
  checkInMonth: string | null;
  roomType: string | null;
  hasReply: boolean;
  replyContent: string | null;
  content: string;
};

export type OverviewMetrics = {
  totalReviews: number;
  positiveReviews: number;
  negativeOrRiskReviews: number;
  mixedReviews: number;
  neutralReviews: number;
  averageScore: number | null;
  replyRate: number;
};

export type TopicSentiment = 'positive' | 'negative';

export type TopicEvidenceItem = {
  recordId: string;
  quote: string;
  sentiment: TopicSentiment;
  aspectLabel: string;
  reason?: string;
};

export type TopicMergeCandidate = {
  sourceLabel: string;
  sentiment: TopicSentiment;
  count: number;
  quotes: string[];
};

export type TopicMergeMember = {
  sourceLabel: string;
  acceptedQuotes: string[];
};

export type TopicMergeGroup = {
  mergeKey: string;
  sentiment: TopicSentiment;
  category: string;
  displayTopic: string;
  summary: string;
  action?: string;
  members: TopicMergeMember[];
};

export type TopicMergeResult = {
  groups: TopicMergeGroup[];
};

export type TopicSummary = {
  mergeKey: string;
  topic: string;
  displayTopic: string;
  category: string;
  count: number;
  sentiment: TopicSentiment;
  commentRecordIds: string[];
  evidencePhrases: string[];
  evidenceItems?: TopicEvidenceItem[];
  summary: string;
  action?: string;
};

export type BatchAiResult = {
  evidenceItems?: TopicEvidenceItem[];
  summary?: {
    positiveCount: number;
    negativeCount: number;
    mixedCount: number;
    neutralCount: number;
  };
  positiveTopics?: TopicSummary[];
  negativeTopics?: TopicSummary[];
};

export type ActionItem = {
  id: string;
  title: string;
  description: string;
  impactCount: number;
  topic: string;
};

export type AnalysisResult = {
  analysisId: string;
  generatedAt: string;
  model: string;
  status: 'complete' | 'partial';
  scope: {
    hotelName: string;
    periodType: string;
    startDate: string;
    endDate: string;
  };
  overview: OverviewMetrics;
  positiveTopics: TopicSummary[];
  negativeTopics: TopicSummary[];
  actionItems: ActionItem[];
};
