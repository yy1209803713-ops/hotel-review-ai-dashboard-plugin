import { createHash } from 'node:crypto';
import { BackendAnalysisError, type BackendAnalysisSourceKind } from './backendAnalysis';
import type { PostgresQueryClient } from './postgresReviewSyncStore';
import type { ReviewSourceQuery } from './reviewSource';
import type { SourceTopicMapping } from '../src/services/analysisPipeline';
import type {
  ReviewRecord,
  TopicEvidenceItem,
  TopicMergeCandidate,
  TopicMergeGroup,
  TopicSentiment,
} from '../src/types/analysis';

export const EVIDENCE_CACHE_EXTRACTOR_VERSION = 'evidence-v1.3-topic-quality';
export const TOPIC_MAPPING_CACHE_VERSION = 'topic-mapping-v1.0';

export type AnalysisCacheSourceIdentity = {
  tenantKey: string;
  sourceKind: BackendAnalysisSourceKind;
  sourceId: string;
  tableId?: string;
};

export type AnalysisEvidenceCacheHit = {
  cacheRecordId: string;
  record: ReviewRecord;
  evidenceItems: TopicEvidenceItem[];
};

export type AnalysisEvidenceCacheDiagnostics = {
  cacheTableFound: boolean;
  cacheTableId?: string;
  requestedRecords: number;
  cacheRowsRead: number;
  hitRecords: number;
  missRecords: number;
  missReasonCounts: Record<string, number>;
  sampleMisses: Array<{ recordId: string; reviewId: string; reason: string }>;
};

export type AnalysisEvidenceCacheReadResult = {
  tableId?: string;
  hits: AnalysisEvidenceCacheHit[];
  misses: ReviewRecord[];
  diagnostics: AnalysisEvidenceCacheDiagnostics;
};

export type AnalysisTopicMappingCacheHit = {
  cacheRecordId: string;
  candidate: TopicMergeCandidate;
  mapping: SourceTopicMapping;
};

export type AnalysisTopicMappingCacheDiagnostics = {
  cacheTableFound: boolean;
  cacheTableId?: string;
  requestedCandidates: number;
  cacheRowsRead: number;
  hitCandidates: number;
  missCandidates: number;
  missReasonCounts: Record<string, number>;
  sampleMisses: Array<{ sentiment: TopicSentiment; sourceLabel: string; reason: string }>;
};

export type AnalysisTopicMappingCacheReadResult = {
  tableId?: string;
  hits: AnalysisTopicMappingCacheHit[];
  misses: TopicMergeCandidate[];
  diagnostics: AnalysisTopicMappingCacheDiagnostics;
};

export type EvidenceBatchDiagnosticInput = AnalysisCacheSourceIdentity & {
  jobId: string;
  model: string;
  extractorVersion?: string;
  batchIndex: number;
  batchNumber: number;
  batchCount: number;
  recordIds: string[];
  records: ReviewRecord[];
  errorCode?: string;
  errorMessage: string;
  rawContent?: string;
  rawLength?: number;
  preview?: string;
  details?: unknown;
  createdAt?: string;
};

export type AnalysisCacheRepository = {
  readEvidenceCache(input: AnalysisCacheSourceIdentity & {
    model: string;
    records: ReviewRecord[];
    now?: string;
  }): Promise<AnalysisEvidenceCacheReadResult>;
  saveEvidenceCacheEntries(input: AnalysisCacheSourceIdentity & {
    model: string;
    records: ReviewRecord[];
    evidenceItems: TopicEvidenceItem[];
    now?: string;
  }): Promise<void>;
  readTopicMappingCache(input: AnalysisCacheSourceIdentity & {
    model: string;
    candidates: TopicMergeCandidate[];
    now?: string;
  }): Promise<AnalysisTopicMappingCacheReadResult>;
  saveTopicMappingCacheEntries(input: AnalysisCacheSourceIdentity & {
    model: string;
    candidates: TopicMergeCandidate[];
    groups: TopicMergeGroup[];
    now?: string;
  }): Promise<void>;
  saveEvidenceBatchDiagnostic?(input: EvidenceBatchDiagnosticInput): Promise<void>;
};

export function createPostgresAnalysisCacheRepository(client: PostgresQueryClient): AnalysisCacheRepository {
  return {
    async readEvidenceCache(input) {
      const diagnostics: AnalysisEvidenceCacheDiagnostics = {
        cacheTableFound: true,
        cacheTableId: 'evidence_cache',
        requestedRecords: input.records.length,
        cacheRowsRead: 0,
        hitRecords: 0,
        missRecords: input.records.length,
        missReasonCounts: {},
        sampleMisses: [],
      };
      if (!input.records.length) {
        return { tableId: input.tableId, hits: [], misses: [], diagnostics };
      }

      const recordsById = new Map(input.records.map((record) => [record.recordId, record]));
      const contentHashes = new Map(input.records.map((record) => [record.recordId, hashContent(record.content)]));
      const { rows } = await client.query<EvidenceCacheRow>(
        `select * from evidence_cache
        where tenant_key = $1
          and source_kind = $2
          and source_id = $3
          and model = $4
          and extractor_version = $5
          and source_record_id = any($6::text[])`,
        [
          input.tenantKey,
          input.sourceKind,
          input.sourceId,
          input.model,
          EVIDENCE_CACHE_EXTRACTOR_VERSION,
          input.records.map((record) => record.recordId),
        ],
      );
      diagnostics.cacheRowsRead = rows.length;

      const hitsByRecordId = new Map<string, AnalysisEvidenceCacheHit>();
      const missReasonByRecordId = new Map<string, string>();
      const hitRowIds: string[] = [];

      for (const row of rows) {
        const record = recordsById.get(row.source_record_id);
        if (!record) {
          continue;
        }
        if (row.content_hash !== contentHashes.get(record.recordId)) {
          missReasonByRecordId.set(record.recordId, 'content_hash_mismatch');
          continue;
        }
        const evidenceItems = parseEvidenceItems(row.evidence_json);
        if (!evidenceItems) {
          missReasonByRecordId.set(record.recordId, 'evidence_json_invalid');
          continue;
        }
        hitsByRecordId.set(record.recordId, {
          cacheRecordId: row.id,
          record,
          evidenceItems,
        });
        hitRowIds.push(row.id);
      }

      if (hitRowIds.length) {
        await client.query(
          `update evidence_cache
          set last_used_at = $1, updated_at = updated_at
          where id = any($2::uuid[])`,
          [input.now ?? new Date().toISOString(), hitRowIds],
        );
      }

      return {
        tableId: input.tableId,
        hits: input.records.flatMap((record) => {
          const hit = hitsByRecordId.get(record.recordId);
          return hit ? [hit] : [];
        }),
        misses: input.records.filter((record) => !hitsByRecordId.has(record.recordId)),
        diagnostics: finalizeEvidenceDiagnostics(diagnostics, input.records, hitsByRecordId, missReasonByRecordId),
      };
    },

    async saveEvidenceCacheEntries(input) {
      if (!input.records.length) {
        return;
      }
      const now = input.now ?? new Date().toISOString();
      const evidenceByRecordId = groupEvidenceByRecord(input.evidenceItems);
      for (const record of input.records) {
        await client.query(
          `insert into evidence_cache (
            tenant_key, source_kind, source_id, source_record_id, content_hash,
            model, extractor_version, evidence_json, created_at, updated_at, last_used_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, $9)
          on conflict (tenant_key, source_kind, source_id, source_record_id, content_hash, model, extractor_version)
          do update set
            evidence_json = excluded.evidence_json,
            updated_at = excluded.updated_at,
            last_used_at = excluded.last_used_at`,
          [
            input.tenantKey,
            input.sourceKind,
            input.sourceId,
            record.recordId,
            hashContent(record.content),
            input.model,
            EVIDENCE_CACHE_EXTRACTOR_VERSION,
            JSON.stringify(evidenceByRecordId.get(record.recordId) ?? []),
            now,
          ],
        );
      }
    },

    async readTopicMappingCache(input) {
      const diagnostics: AnalysisTopicMappingCacheDiagnostics = {
        cacheTableFound: true,
        cacheTableId: 'topic_mapping_cache',
        requestedCandidates: input.candidates.length,
        cacheRowsRead: 0,
        hitCandidates: 0,
        missCandidates: input.candidates.length,
        missReasonCounts: {},
        sampleMisses: [],
      };
      if (!input.candidates.length) {
        return { tableId: input.tableId, hits: [], misses: [], diagnostics };
      }

      const candidateKeys = new Set(input.candidates.map(candidateKey));
      const candidatesByKey = new Map(input.candidates.map((candidate) => [candidateKey(candidate), candidate]));
      const { rows } = await client.query<TopicMappingCacheRow>(
        `select * from topic_mapping_cache
        where tenant_key = $1
          and source_kind = $2
          and source_id = $3
          and model = $4
          and mapping_version = $5`,
        [
          input.tenantKey,
          input.sourceKind,
          input.sourceId,
          input.model,
          TOPIC_MAPPING_CACHE_VERSION,
        ],
      );
      diagnostics.cacheRowsRead = rows.length;

      const hitsByKey = new Map<string, AnalysisTopicMappingCacheHit>();
      const missReasonByKey = new Map<string, string>();
      const hitRowIds: string[] = [];

      for (const row of rows) {
        if (row.sentiment !== 'positive' && row.sentiment !== 'negative') {
          continue;
        }
        const key = mappingKey(row.sentiment, row.normalized_source_label);
        if (!candidateKeys.has(key)) {
          continue;
        }
        const candidate = candidatesByKey.get(key);
        if (!candidate) {
          continue;
        }
        const mapping = parseTopicMapping(row.mapping_json);
        if (!mapping || mapping.sentiment !== candidate.sentiment) {
          missReasonByKey.set(key, 'mapping_json_invalid');
          continue;
        }
        hitsByKey.set(key, {
          cacheRecordId: row.id,
          candidate,
          mapping: {
            ...mapping,
            sourceLabel: candidate.sourceLabel,
            acceptedQuotes: mapping.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
          },
        });
        hitRowIds.push(row.id);
      }

      if (hitRowIds.length) {
        await client.query(
          `update topic_mapping_cache
          set last_used_at = $1, updated_at = updated_at
          where id = any($2::uuid[])`,
          [input.now ?? new Date().toISOString(), hitRowIds],
        );
      }

      return {
        tableId: input.tableId,
        hits: input.candidates.flatMap((candidate) => {
          const hit = hitsByKey.get(candidateKey(candidate));
          return hit ? [hit] : [];
        }),
        misses: input.candidates.filter((candidate) => !hitsByKey.has(candidateKey(candidate))),
        diagnostics: finalizeTopicDiagnostics(diagnostics, input.candidates, hitsByKey, missReasonByKey),
      };
    },

    async saveTopicMappingCacheEntries(input) {
      if (!input.candidates.length || !input.groups.length) {
        return;
      }
      const now = input.now ?? new Date().toISOString();
      const mappings = buildMappingsFromGroups(input.candidates, input.groups);
      for (const candidate of input.candidates) {
        const mapping = mappings.get(candidateKey(candidate));
        if (!mapping) {
          continue;
        }
        await client.query(
          `insert into topic_mapping_cache (
            tenant_key, source_kind, source_id, sentiment, normalized_source_label,
            model, mapping_version, mapping_json, created_at, updated_at, last_used_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, $9)
          on conflict (tenant_key, source_kind, source_id, sentiment, normalized_source_label, model, mapping_version)
          do update set
            mapping_json = excluded.mapping_json,
            updated_at = excluded.updated_at,
            last_used_at = excluded.last_used_at`,
          [
            input.tenantKey,
            input.sourceKind,
            input.sourceId,
            candidate.sentiment,
            normalizeTopic(candidate.sourceLabel),
            input.model,
            TOPIC_MAPPING_CACHE_VERSION,
            JSON.stringify(mapping),
            now,
          ],
        );
      }
    },

    async saveEvidenceBatchDiagnostic(input) {
      await client.query(
        `insert into ai_batch_diagnostics (
          job_id, tenant_key, source_kind, source_id, table_id, model, extractor_version,
          batch_index, batch_number, batch_count, record_ids_json, records_json,
          error_code, error_message, raw_content, raw_length, preview, details_json, created_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11::jsonb, $12::jsonb,
          $13, $14, $15, $16, $17, $18::jsonb, $19
        )`,
        [
          input.jobId,
          input.tenantKey,
          input.sourceKind,
          input.sourceId,
          input.tableId ?? null,
          input.model,
          input.extractorVersion ?? EVIDENCE_CACHE_EXTRACTOR_VERSION,
          input.batchIndex,
          input.batchNumber,
          input.batchCount,
          JSON.stringify(input.recordIds),
          JSON.stringify(input.records.map(diagnosticRecordSnapshot)),
          input.errorCode ?? null,
          input.errorMessage,
          input.rawContent ?? null,
          input.rawLength ?? input.rawContent?.length ?? null,
          input.preview ?? null,
          JSON.stringify(sanitizeDiagnosticDetails(input.details)),
          input.createdAt ?? new Date().toISOString(),
        ],
      );
    },
  };
}

export function resolveAnalysisCacheSourceIdentity(query: ReviewSourceQuery): AnalysisCacheSourceIdentity {
  const sourceKind = resolveCacheSourceKind(query);
  const sourceId = resolveCacheSourceId(query);
  return {
    tenantKey: requireNonEmptyString(query.tenantKey, 'tenantKey is required for analysis cache'),
    sourceKind,
    sourceId,
    tableId: query.tableId,
  };
}

type EvidenceCacheRow = {
  id: string;
  source_record_id: string;
  content_hash: string;
  evidence_json: TopicEvidenceItem[] | string;
};

type TopicMappingCacheRow = {
  id: string;
  sentiment: string;
  normalized_source_label: string;
  mapping_json: SourceTopicMapping | string;
};

function diagnosticRecordSnapshot(record: ReviewRecord): Record<string, unknown> {
  return {
    recordId: record.recordId,
    reviewId: record.reviewId,
    hotelName: record.hotelName,
    score: record.score,
    reviewDate: record.reviewDate,
    checkInMonth: record.checkInMonth,
    roomType: record.roomType,
    hasReply: record.hasReply,
    content: record.content,
  };
}

function sanitizeDiagnosticDetails(details: unknown): unknown {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return details ?? {};
  }
  const { rawContent, ...rest } = details as Record<string, unknown>;
  return rest;
}

function resolveCacheSourceKind(query: ReviewSourceQuery): BackendAnalysisSourceKind {
  const configuredKind = pickNonEmptyString(query.sourceConfig?.upstreamSourceKind ?? query.sourceConfig?.sourceKind);
  if (configuredKind) {
    if (configuredKind === 'feishu_base' || configuredKind === 'postgres' || configuredKind === 'external') {
      return configuredKind;
    }
    throw new BackendAnalysisError(400, 'read_evidence_cache', 'analysis cache source kind must be feishu_base, postgres, or external');
  }
  if (query.baseToken || query.tableId) {
    return 'feishu_base';
  }
  return 'postgres';
}

function resolveCacheSourceId(query: ReviewSourceQuery): string {
  const configuredSourceId = pickNonEmptyString(query.sourceConfig?.sourceId);
  if (configuredSourceId) {
    return configuredSourceId;
  }
  const feishuSourceId = [query.baseToken, query.tableId, query.viewId].filter(isNonEmptyString).join(':');
  if (feishuSourceId) {
    return feishuSourceId;
  }
  throw new BackendAnalysisError(400, 'read_evidence_cache', 'sourceConfig.sourceId is required for analysis cache');
}

function parseEvidenceItems(rawJson: TopicEvidenceItem[] | string): TopicEvidenceItem[] | null {
  const parsed = parseJson(rawJson);
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.flatMap((item): TopicEvidenceItem[] => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const value = item as Partial<TopicEvidenceItem>;
    if (
      typeof value.recordId !== 'string' ||
      typeof value.quote !== 'string' ||
      (value.sentiment !== 'positive' && value.sentiment !== 'negative') ||
      typeof value.aspectLabel !== 'string'
    ) {
      return [];
    }
    return [
      {
        recordId: value.recordId,
        quote: value.quote,
        sentiment: value.sentiment,
        aspectLabel: value.aspectLabel,
        reason: typeof value.reason === 'string' ? value.reason : undefined,
      },
    ];
  });
}

function parseTopicMapping(rawJson: SourceTopicMapping | string): SourceTopicMapping | null {
  const value = parseJson(rawJson) as Partial<SourceTopicMapping>;
  if (
    !value ||
    typeof value.sourceLabel !== 'string' ||
    (value.sentiment !== 'positive' && value.sentiment !== 'negative') ||
    typeof value.mergeKey !== 'string' ||
    typeof value.category !== 'string' ||
    typeof value.displayTopic !== 'string' ||
    typeof value.summary !== 'string'
  ) {
    return null;
  }
  return {
    sourceLabel: value.sourceLabel,
    sentiment: value.sentiment,
    mergeKey: value.mergeKey,
    category: value.category,
    displayTopic: value.displayTopic,
    summary: value.summary,
    acceptedQuotes: Array.isArray(value.acceptedQuotes)
      ? value.acceptedQuotes.filter((quote): quote is string => typeof quote === 'string')
      : undefined,
    action: typeof value.action === 'string' ? value.action : undefined,
  };
}

function finalizeEvidenceDiagnostics(
  diagnostics: AnalysisEvidenceCacheDiagnostics,
  records: ReviewRecord[],
  hitsByRecordId: Map<string, AnalysisEvidenceCacheHit>,
  missReasonByRecordId: Map<string, string>,
): AnalysisEvidenceCacheDiagnostics {
  const missReasonCounts: Record<string, number> = {};
  const sampleMisses: AnalysisEvidenceCacheDiagnostics['sampleMisses'] = [];
  for (const record of records) {
    if (hitsByRecordId.has(record.recordId)) {
      continue;
    }
    const reason = missReasonByRecordId.get(record.recordId) ?? 'cache_no_matching_row';
    missReasonCounts[reason] = (missReasonCounts[reason] ?? 0) + 1;
    if (sampleMisses.length < 5) {
      sampleMisses.push({ recordId: record.recordId, reviewId: record.reviewId, reason });
    }
  }
  return {
    ...diagnostics,
    hitRecords: hitsByRecordId.size,
    missRecords: records.length - hitsByRecordId.size,
    missReasonCounts,
    sampleMisses,
  };
}

function finalizeTopicDiagnostics(
  diagnostics: AnalysisTopicMappingCacheDiagnostics,
  candidates: TopicMergeCandidate[],
  hitsByKey: Map<string, AnalysisTopicMappingCacheHit>,
  missReasonByKey: Map<string, string>,
): AnalysisTopicMappingCacheDiagnostics {
  const missReasonCounts: Record<string, number> = {};
  const sampleMisses: AnalysisTopicMappingCacheDiagnostics['sampleMisses'] = [];
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (hitsByKey.has(key)) {
      continue;
    }
    const reason = missReasonByKey.get(key) ?? 'cache_no_matching_row';
    missReasonCounts[reason] = (missReasonCounts[reason] ?? 0) + 1;
    if (sampleMisses.length < 5) {
      sampleMisses.push({
        sentiment: candidate.sentiment,
        sourceLabel: candidate.sourceLabel,
        reason,
      });
    }
  }
  return {
    ...diagnostics,
    hitCandidates: hitsByKey.size,
    missCandidates: candidates.length - hitsByKey.size,
    missReasonCounts,
    sampleMisses,
  };
}

function buildMappingsFromGroups(
  candidates: TopicMergeCandidate[],
  groups: TopicMergeGroup[],
): Map<string, SourceTopicMapping> {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const bySource = new Map(candidates.map((candidate) => [candidateKey(candidate), candidate]));
  const mappings = new Map<string, SourceTopicMapping>();

  for (const group of groups) {
    for (const member of group.members) {
      const candidate =
        (member.candidateId ? byId.get(member.candidateId) : undefined) ??
        bySource.get(mappingKey(group.sentiment, normalizeTopic(member.sourceLabel)));
      if (!candidate) {
        continue;
      }
      mappings.set(candidateKey(candidate), {
        sourceLabel: candidate.sourceLabel,
        sentiment: candidate.sentiment,
        mergeKey: group.mergeKey.trim() || candidate.sourceLabel,
        category: group.category.trim() || candidate.sourceLabel,
        displayTopic: group.displayTopic.trim() || candidate.sourceLabel,
        summary: group.summary.trim() || `${group.displayTopic || group.mergeKey || candidate.sourceLabel}相关评论证据。`,
        acceptedQuotes: member.acceptedQuotes?.filter((quote) => candidate.quotes.includes(quote)),
        action: group.action?.trim() || undefined,
      });
    }
  }

  return mappings;
}

function groupEvidenceByRecord(evidenceItems: TopicEvidenceItem[]): Map<string, TopicEvidenceItem[]> {
  const grouped = new Map<string, TopicEvidenceItem[]>();
  for (const item of evidenceItems) {
    grouped.set(item.recordId, [...(grouped.get(item.recordId) ?? []), item]);
  }
  return grouped;
}

function candidateKey(candidate: TopicMergeCandidate): string {
  return mappingKey(candidate.sentiment, normalizeTopic(candidate.sourceLabel));
}

function mappingKey(sentiment: TopicSentiment, normalizedSourceLabel: string): string {
  return `${sentiment}|${normalizedSourceLabel}`;
}

function normalizeTopic(topic: string): string {
  return topic.replace(/\s+/g, '').replace(/[，,。./\\-]/g, '').toLocaleLowerCase();
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return JSON.parse(value) as unknown;
  }
  return value;
}

function pickNonEmptyString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (!isNonEmptyString(value)) {
    throw new BackendAnalysisError(400, 'read_evidence_cache', message);
  }
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
