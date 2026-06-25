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
  fieldMapping?: Record<string, string>;
  startDate?: string;
  endDate?: string;
  configId?: string;
  dryRun?: boolean;
};

export type WarmupResponse = {
  jobId: string;
  status: 'accepted' | 'running' | 'success' | 'partial_success' | 'failed' | 'skipped';
  mode: WarmupMode;
  summary: {
    recordsScanned?: number;
    totalReviews: number;
    evidenceCacheHits: number;
    evidenceCacheMisses: number;
    evidenceRecordsSaved: number;
    evidenceCacheInserts?: number;
    evidenceCacheUpdates?: number;
    topicMappingHits: number;
    topicMappingMisses: number;
    topicMappingsSaved: number;
    topicMappingCacheInserts?: number;
    topicMappingCacheUpdates?: number;
  };
  errors: Array<{
    stage: WarmupStage;
    message: string;
    recordId?: string;
  }>;
};
