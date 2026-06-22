export type WarmupMode = 'bootstrap' | 'incremental';

export type WarmupSource = 'dashboard-button' | 'feishu-workflow' | 'manual';

export type WarmupStage =
  | 'validate_request'
  | 'lock'
  | 'read_reviews'
  | 'read_evidence_cache'
  | 'extract_evidence'
  | 'save_evidence_cache'
  | 'read_topic_mapping_cache'
  | 'merge_topics'
  | 'save_topic_mapping_cache';

export type WarmupRequest = {
  mode: WarmupMode;
  source: WarmupSource;
  baseToken?: string;
  tableId: string;
  viewId?: string;
  configId?: string;
  dryRun?: boolean;
};

export type WarmupResponse = {
  jobId: string;
  status: 'accepted' | 'running' | 'success' | 'partial_success' | 'failed' | 'skipped';
  mode: WarmupMode;
  summary: {
    totalReviews: number;
    evidenceCacheHits: number;
    evidenceCacheMisses: number;
    evidenceRecordsSaved: number;
    topicMappingHits: number;
    topicMappingMisses: number;
    topicMappingsSaved: number;
  };
  errors: Array<{
    stage: WarmupStage;
    message: string;
    recordId?: string;
  }>;
};
