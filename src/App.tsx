import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { SourceType, type IDataRange } from '@lark-base-open/js-sdk';
import { ConfigPanel } from './components/ConfigPanel';
import { DashboardShell } from './components/DashboardShell';
import { DEFAULT_CONFIG, FIELD_LABELS } from './constants/defaults';
import { buildDataConditions } from './services/dashboardConfig';
import { getPeriodRange } from './services/filtering';
import { normalizeReviewRecord, readReviewRecords } from './services/baseRecords';
import { filterReviews } from './services/filtering';
import { getMissingRequiredFields, suggestFieldMapping } from './services/fieldMapping';
import { runAnalysis, type AnalysisCacheUsage, type TopicMappingUsage } from './services/analysisPipeline';
import { ANALYSIS_COPY_VERSION, buildScopeSnapshot, isCacheStale, type ScopeSnapshot } from './services/stats';
import { buildHostDataSignal, parseHostVisibleReviewIds } from './services/hostDataScope';
import { loadPluginConfig, saveAnalysisCache, savePluginConfig } from './services/cacheStore';
import { writeAnalysisResult } from './services/writeback';
import { formatAiClientError, testAiConnection } from './services/aiClient';
import { readEvidenceCache, saveEvidenceCacheEntries, touchEvidenceCacheEntries } from './services/evidenceCache';
import {
  readTopicMappingCache,
  saveTopicMappingCacheEntries,
  touchTopicMappingCacheEntries,
  type TopicMappingCacheReadResult,
} from './services/topicMappingCache';
import { triggerWarmup } from './services/warmupClient';
import {
  runtime as defaultRuntime,
  type DashboardRuntime,
  type DashboardStateName,
  type RuntimeCategory,
  type RuntimeTable,
} from './runtime/sdk';
import type { AnalysisCache, FieldMapping, FilterState, PeriodType, PluginConfig } from './types/config';
import type { AnalysisResult, ReviewRecord, TopicSummary } from './types/analysis';
import type { WarmupMode, WarmupResponse } from './services/warmup';

const EVIDENCE_PAGE_SIZE = 10;
const FILTER_OPTION_REQUIRED_FIELD_KEYS: Array<keyof FieldMapping> = ['content', 'hotelName', 'checkInMonth'];
const HOST_DATA_SCOPE_UNSUPPORTED_MESSAGE =
  '当前仪表盘筛选结果无法映射到评论 ID，已停止 AI 分析以避免分析到非当前范围的数据。请检查字段映射和数据源配置。';

export default function App() {
  const runtime = defaultRuntime;
  const [state] = useState(runtime.getState());
  const [config, setConfig] = useState<PluginConfig>(DEFAULT_CONFIG);
  const [filters, setFilters] = useState<FilterState>(() => withComputedRange(DEFAULT_CONFIG.filters));
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<TopicSummary | null>(null);
  const [evidenceRecords, setEvidenceRecords] = useState<ReviewRecord[]>([]);
  const [evidencePage, setEvidencePage] = useState(1);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [tables, setTables] = useState<RuntimeTable[]>([]);
  const [categories, setCategories] = useState<RuntimeCategory[]>([]);
  const [dataRanges, setDataRanges] = useState<IDataRange[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [warmupRunning, setWarmupRunning] = useState(false);
  const [warmupStatus, setWarmupStatus] = useState<{ response: WarmupResponse; triggeredAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [currentScope, setCurrentScope] = useState<ScopeSnapshot | null>(null);
  const [optionRecords, setOptionRecords] = useState<ReviewRecord[]>([]);
  const [hostData, setHostData] = useState<unknown[][] | null>(null);
  const [scopeWarning, setScopeWarning] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const evidenceRequestId = useRef(0);
  const configSourceRequestId = useRef(0);
  const configRef = useRef(config);
  const mountedRef = useRef(true);
  const isCurrentConfigSourceRequest = (requestId?: number) =>
    mountedRef.current && (requestId === undefined || configSourceRequestId.current === requestId);

  const isConfigMode = state === 'Create' || state === 'Config';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    const previousThemeMode = document.documentElement.getAttribute('theme-mode');
    document.documentElement.classList.toggle('full-screen', state === 'FullScreen');
    runtime.getTheme().then((theme) => {
      if (mountedRef.current) {
        document.documentElement.setAttribute('theme-mode', theme.theme === 'DARK' ? 'dark' : 'light');
      }
    }).catch(() => undefined);
    const unsubscribeTheme = runtime.onThemeChange((theme) => {
      if (!mountedRef.current) {
        return;
      }
      document.documentElement.setAttribute('theme-mode', theme.theme === 'DARK' ? 'dark' : 'light');
    });
    const unsubscribeData = runtime.onDataChange((data) => {
      if (!mountedRef.current) {
        return;
      }
      setHostData(data);
      setCurrentScope((current) =>
        current
          ? {
              ...current,
              source: {
                ...current.source,
                hostDataSignal: buildHostDataSignal(data),
              },
            }
          : current,
      );
      runtime.setRendered();
    });
    const unsubscribeConfig = runtime.onConfigChange((configSnapshot) => {
      if (!mountedRef.current || state === 'Create') {
        return;
      }
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_CHANGE_EVENT__', 'host', {
        state,
        reloadToken,
        runtimeConfig: configSnapshot,
      });
      setReloadToken((current) => current + 1);
    });

    return () => {
      document.documentElement.classList.remove('full-screen');
      if (previousThemeMode === null) {
        document.documentElement.removeAttribute('theme-mode');
      } else {
        document.documentElement.setAttribute('theme-mode', previousThemeMode);
      }
      unsubscribeTheme();
      unsubscribeData();
      unsubscribeConfig();
    };
  }, [runtime, state]);

  useEffect(() => {
    async function init() {
      setLoading(true);
      setError(null);
      setSelectedTopic(null);
      setEvidenceRecords([]);
      setEvidencePage(1);
      setEvidenceLoading(false);
      setOptionRecords([]);
      setCategories([]);
      setDataRanges([]);
      setHostData(null);
      setScopeWarning(null);
      configSourceRequestId.current += 1;

      try {
        if (state === 'View' || state === 'FullScreen') {
          await initializeDisplayState();
          return;
        }

        const tableList = await runtime.getTableList();
        if (!mountedRef.current) {
          return;
        }
        setTables(tableList);

        if (state === 'Create') {
          await initializeCreateState(tableList);
          return;
        }

        await initializeConfigState();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '初始化失败');
      } finally {
        if (mountedRef.current) {
          setLoading(false);
          runtime.setRendered();
        }
      }
    }

    async function initializeCreateState(tableList: RuntimeTable[]) {
      const firstTable = tableList[0];
      if (!firstTable) {
        setConfig(DEFAULT_CONFIG);
        setAnalysis(null);
        return;
      }

      const requestId = configSourceRequestId.current + 1;
      configSourceRequestId.current = requestId;
      const draftConfig: PluginConfig = {
        ...DEFAULT_CONFIG,
        source: {
          ...DEFAULT_CONFIG.source,
          tableId: firstTable.tableId,
          viewId: undefined,
          dataRange: undefined,
          fields: { ...DEFAULT_CONFIG.source.fields },
        },
      };
      await loadSourceMetadata(draftConfig, requestId, true);
    }

    async function initializeConfigState() {
      const pluginConfig = await loadPluginConfig(runtime);
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_LOAD__', 'init-config', {
        state,
        reloadToken,
        pluginConfig,
      });
      if (!mountedRef.current) {
        return;
      }
      setConfig(pluginConfig);
      setFilters(withComputedRange(pluginConfig.filters));
      setAnalysis(pluginConfig.analysisCache?.result ?? null);
      setCurrentScope(pluginConfig.analysisCache?.scopeSnapshot ? (pluginConfig.analysisCache.scopeSnapshot as ScopeSnapshot) : null);
      if (!pluginConfig.source.tableId.trim()) {
        setHostData(null);
        return;
      }

      const requestId = configSourceRequestId.current + 1;
      configSourceRequestId.current = requestId;
      await loadSourceMetadata(pluginConfig, requestId, true);
    }

    async function initializeDisplayState() {
      const pluginConfig = await loadPluginConfig(runtime);
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_LOAD__', 'init-display', {
        state,
        reloadToken,
        pluginConfig,
      });
      if (!mountedRef.current) {
        return;
      }
      setConfig(pluginConfig);
      setFilters(withComputedRange(pluginConfig.filters));
      setAnalysis(pluginConfig.analysisCache?.result ?? null);
      setDataRanges([]);
      setCategories([]);
      const hostDataSnapshot = await runtime.getData();
      setHostData(hostDataSnapshot);
      if (pluginConfig.analysisCache?.scopeSnapshot) {
        setCurrentScope(buildCurrentScope(pluginConfig, hostDataSnapshot, pluginConfig.analysisCache.scopeSnapshot as ScopeSnapshot));
      } else {
        setCurrentScope(null);
      }
      if (pluginConfig.source.tableId.trim()) {
        await loadFilterOptionRecords(pluginConfig);
      }
    }

    async function loadSourceMetadata(pluginConfig: PluginConfig, requestId: number, loadPreview: boolean) {
      const tableId = pluginConfig.source.tableId.trim();
      if (!tableId) {
        return;
      }

      const [categoryList, dataRangeList] = await Promise.all([
        runtime.getCategories(tableId),
        runtime.getTableDataRange(tableId),
      ]);
      if (!isCurrentConfigSourceRequest(requestId)) {
        return;
      }

      const runtimeCategories = categoryList as RuntimeCategory[];
      const normalizedSource = normalizeSourceSelection(pluginConfig.source, dataRangeList as IDataRange[]);
      const configWithSuggestedFields = withSuggestedFieldMapping(
        {
          ...pluginConfig,
          source: normalizedSource,
        },
        runtimeCategories,
      );
      setConfig(configWithSuggestedFields);
      setCategories(runtimeCategories);
      setDataRanges(dataRangeList as IDataRange[]);

      if (loadPreview) {
        const previewData = await runtime.getPreviewData(buildDataConditions(configWithSuggestedFields));
        if (!isCurrentConfigSourceRequest(requestId)) {
          return;
        }
        setHostData(previewData);
        setCurrentScope(
          buildCurrentScope(
            configWithSuggestedFields,
            previewData,
            configWithSuggestedFields.analysisCache?.scopeSnapshot as ScopeSnapshot | undefined,
          ),
        );
      }

      if (hasFilterOptionRequiredFields(configWithSuggestedFields.source.fields)) {
        await loadFilterOptionRecords(configWithSuggestedFields, requestId);
      }
    }

    init();
  }, [state, reloadToken]);

  const stale = useMemo(() => {
    const cacheScope = config.analysisCache?.scopeSnapshot as ScopeSnapshot | undefined;
    if (!analysis) {
      return false;
    }
    if (!cacheScope) {
      return true;
    }
    if (!currentScope) {
      return true;
    }
    return isCacheStale(cacheScope, currentScope);
  }, [analysis, config.analysisCache?.scopeSnapshot, currentScope]);

  const hotelOptions = useMemo(
    () => uniqueSorted(optionRecords.map((record) => record.hotelName).filter(Boolean), filters.hotelName),
    [filters.hotelName, optionRecords],
  );
  const checkInMonthOptions = useMemo(
    () => uniqueSorted(optionRecords.map((record) => record.checkInMonth ?? '').filter(Boolean), filters.checkInMonth).reverse(),
    [filters.checkInMonth, optionRecords],
  );

  async function handleUpdateAnalysis() {
    const timingRows: AnalysisTimingRow[] = [];
    const runStartedAt = getNowMs();

    setError(null);
    setScopeWarning(null);
    const missingFieldMessage = getMissingFieldMappingMessage(config.source.fields);
    if (missingFieldMessage) {
      setError(missingFieldMessage);
      Toast.error(missingFieldMessage);
      return;
    }

    if (!config.ai.apiKey.trim()) {
      const message = '请先填写并保存 API Key';
      setError(message);
      Toast.error(message);
      return;
    }

    const hostVisibleReviewIds = parseHostVisibleReviewIds(hostData);
    if (!hostVisibleReviewIds) {
      const message = HOST_DATA_SCOPE_UNSUPPORTED_MESSAGE;
      setScopeWarning(message);
      Toast.warning(message);
      return;
    }

    setLoading(true);
    setAnalysisRunning(true);
    Toast.info('开始读取评论并更新 AI 聚合分析');

    try {
      const records = await measureAnalysisStep(timingRows, '读表', () => readRecordsForConfig(runtime, config), (result) => ({
        records: result.length,
        detail: config.source.viewId ? `view=${config.source.viewId}` : `table=${config.source.tableId}`,
      }));
      setOptionRecords(records);
      const scopedRecords = records.filter((record) => hostVisibleReviewIds.has(record.reviewId));
      const filtered = measureAnalysisSyncStep(timingRows, '过滤', () => filterReviews(scopedRecords, filters), (result) => ({
        records: result.length,
        detail: `仪表盘可见 ${scopedRecords.length} 条；原始 ${records.length} 条`,
      }));

      if (!filtered.length) {
        setError('当前筛选范围内没有可分析评论');
        return;
      }

      const sourceScope = buildCurrentSourceScope(config, hostData);
      const scope = buildScopeSnapshot(filtered, filters, config.source.fields, config.ai.model, sourceScope);
      const evidenceCache = await measureAnalysisStep(timingRows, '读取证据缓存', () => readEvidenceCache(runtime, {
        tableId: config.source.tableId,
        model: config.ai.model,
        records: filtered,
      }), (cache) => ({
        records: cache.hits.length,
        detail: `命中 ${cache.hits.length} 条；待分析 ${cache.misses.length} 条`,
      }));
      logAnalysisDebug('__HOTEL_REVIEW_AI_CACHE_READ__', {
        scope: {
          hotelName: filters.hotelName,
          periodType: filters.periodType,
          startDate: filters.startDate,
          endDate: filters.endDate,
        },
        diagnostics: evidenceCache.diagnostics,
      });
      if (evidenceCache.tableId && evidenceCache.hits.length) {
        touchEvidenceCacheEntries(runtime, {
          cacheTableId: evidenceCache.tableId,
          cacheRecordIds: evidenceCache.hits.map((hit) => hit.cacheRecordId),
        });
      }
      let newEvidenceItems: AnalysisCacheUsage['newEvidenceItems'] = [];
      let topicMappingUsage: TopicMappingUsage | null = null;
      let topicMappingCache: TopicMappingCacheReadResult | null = null;
      const result = await measureAnalysisStep(timingRows, 'AI 总耗时', () => runAnalysis({
        records: filtered,
        config: config.ai,
        filters,
        fields: config.source.fields,
        cachedEvidenceItems: evidenceCache.hits.flatMap((hit) => hit.evidenceItems),
        cacheMissRecords: evidenceCache.misses,
        readTopicMappingsImpl: async ({ candidates }) => {
          const cache = await measureAnalysisStep(timingRows, '读取主题映射缓存', () => readTopicMappingCache(runtime, {
            tableId: config.source.tableId,
            model: config.ai.model,
            candidates,
          }), (cache) => ({
            records: cache.hits.length,
            detail: `命中 ${cache.hits.length} 个；待归并 ${cache.misses.length} 个`,
          }));
          topicMappingCache = cache;
          logAnalysisDebug('__HOTEL_REVIEW_AI_TOPIC_MAPPING_CACHE_READ__', {
            scope: {
              hotelName: filters.hotelName,
              periodType: filters.periodType,
              startDate: filters.startDate,
              endDate: filters.endDate,
            },
            diagnostics: cache.diagnostics,
          });
          if (cache.tableId && cache.hits.length) {
            touchTopicMappingCacheEntries(runtime, {
              cacheTableId: cache.tableId,
              cacheRecordIds: cache.hits.map((hit) => hit.cacheRecordId),
            });
          }
          return {
            cachedMappings: cache.hits.map((hit) => hit.mapping),
            cachedCandidates: cache.hits.map((hit) => hit.candidate),
          };
        },
        onCacheUsage: async (usage) => {
          newEvidenceItems = usage.newEvidenceItems;
          if (!evidenceCache.misses.length || !usage.newEvidenceItems.length) {
            return;
          }
          try {
            await measureAnalysisStep(timingRows, '保存证据缓存', () => saveEvidenceCacheEntries(runtime, {
              tableId: config.source.tableId,
              model: config.ai.model,
              records: evidenceCache.misses,
              evidenceItems: usage.newEvidenceItems,
            }), () => ({
              records: evidenceCache.misses.length,
            }));
            logAnalysisDebug('__HOTEL_REVIEW_AI_CACHE_SAVE__', {
              tableId: config.source.tableId,
              cacheTableId: evidenceCache.tableId ?? null,
              savedRecords: evidenceCache.misses.length,
              savedEvidenceItems: usage.newEvidenceItems.length,
            });
          } catch (evidenceCacheError) {
            logAnalysisDebug('__HOTEL_REVIEW_AI_CACHE_SAVE_FAIL__', {
              tableId: config.source.tableId,
              cacheTableId: evidenceCache.tableId ?? null,
              savedRecords: evidenceCache.misses.length,
              savedEvidenceItems: usage.newEvidenceItems.length,
              error: evidenceCacheError instanceof Error ? evidenceCacheError.message : String(evidenceCacheError),
            });
            Toast.warning(
              evidenceCacheError instanceof Error
                ? `证据缓存保存失败：${evidenceCacheError.message}`
                : '证据缓存保存失败，本次结果已保留',
            );
          }
        },
        onTopicMappingUsage: async (usage) => {
          topicMappingUsage = usage;
          if (!usage.newCandidates.length || !usage.newGroups.length) {
            return;
          }
          try {
            await measureAnalysisStep(timingRows, '保存主题映射缓存', () => saveTopicMappingCacheEntries(runtime, {
              tableId: config.source.tableId,
              model: config.ai.model,
              candidates: usage.newCandidates,
              groups: usage.newGroups,
            }), () => ({
              records: usage.newCandidates.length,
            }));
            logAnalysisDebug('__HOTEL_REVIEW_AI_TOPIC_MAPPING_CACHE_SAVE__', {
              tableId: config.source.tableId,
              cacheTableId: topicMappingCache?.tableId ?? null,
              savedCandidates: usage.newCandidates.length,
              savedGroups: usage.newGroups.length,
            });
          } catch (topicMappingCacheError) {
            logAnalysisDebug('__HOTEL_REVIEW_AI_TOPIC_MAPPING_CACHE_SAVE_FAIL__', {
              tableId: config.source.tableId,
              cacheTableId: topicMappingCache?.tableId ?? null,
              savedCandidates: usage.newCandidates.length,
              savedGroups: usage.newGroups.length,
              error: topicMappingCacheError instanceof Error ? topicMappingCacheError.message : String(topicMappingCacheError),
            });
            Toast.warning(
              topicMappingCacheError instanceof Error
                ? `主题映射缓存保存失败：${topicMappingCacheError.message}`
                : '主题映射缓存保存失败，本次结果已保留',
            );
          }
        },
        onBatchTiming: (timing) => {
          timingRows.push({
            step: `AI 批次 ${timing.batchIndex + 1}/${timing.batchCount}`,
            durationMs: timing.durationMs,
            status: timing.status,
            records: timing.recordCount,
          });
        },
        onStageTiming: (timing) => {
          timingRows.push(timing);
        },
      }), (result) => ({
        records: result.overview.totalReviews,
        detail: `model=${result.model}; 缓存命中 ${evidenceCache.hits.length} 条；新分析 ${evidenceCache.misses.length} 条`,
      }));
      logAnalysisDebug('__HOTEL_REVIEW_AI_CACHE_USAGE__', {
        cachedEvidenceCount: evidenceCache.hits.reduce((sum, hit) => sum + hit.evidenceItems.length, 0),
        cachedRecordCount: evidenceCache.hits.length,
        analyzedRecordCount: evidenceCache.misses.length,
        analyzedRecordIds: evidenceCache.misses.map((record) => record.recordId),
        newEvidenceCount: newEvidenceItems.length,
        newEvidenceRecordIds: newEvidenceItems.map((item) => item.recordId),
      });
      const mappingUsage = topicMappingUsage as TopicMappingUsage | null;
      const mappingCache = topicMappingCache as TopicMappingCacheReadResult | null;
      logAnalysisDebug('__HOTEL_REVIEW_AI_TOPIC_MAPPING_CACHE_USAGE__', {
        cachedMappingCount: mappingUsage?.cachedMappingCount ?? mappingCache?.hits.length ?? 0,
        missedCandidateCount: mappingUsage?.missedCandidateCount ?? mappingCache?.misses.length ?? 0,
        newCandidateLabels: mappingUsage?.newCandidates.map((candidate) => ({
          sourceLabel: candidate.sourceLabel,
          sentiment: candidate.sentiment,
        })) ?? [],
        newGroupCount: mappingUsage?.newGroups.length ?? 0,
      });
      const cache: AnalysisCache = {
        result,
        scopeSnapshot: scope,
        sourceSnapshot: config.source,
        model: config.ai.model,
        generatedAt: result.generatedAt,
      };
      logAnalysisDebug('__HOTEL_REVIEW_AI_ANALYSIS_CACHE_SIZE__', {
        jsonBytes: new TextEncoder().encode(JSON.stringify(cache)).length,
        resultBytes: new TextEncoder().encode(JSON.stringify(result)).length,
        scopeSnapshotBytes: new TextEncoder().encode(JSON.stringify(scope)).length,
        sourceSnapshotBytes: new TextEncoder().encode(JSON.stringify(config.source)).length,
      });

      const analysisCacheTraceId = createAnalysisCacheTraceId();
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_BEGIN__', 'analysis-cache', {
        traceId: analysisCacheTraceId,
        state,
        filters,
        pluginConfig: {
          ...config,
          filters,
          analysisCache: cache,
        },
      });
      await measureAnalysisStep(timingRows, '保存缓存', () => saveAnalysisCache(runtime, cache));
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_END__', 'analysis-cache', {
        traceId: analysisCacheTraceId,
        state,
        filters,
        pluginConfig: {
          ...config,
          filters,
          analysisCache: cache,
        },
      });
      try {
        const writeback = await measureAnalysisStep(timingRows, '写回', () => writeAnalysisResult(runtime, result, config.writeback), (writeback) => {
          if (writeback.status === 'skipped') {
            return {
              status: 'skipped',
              detail: writeback.reason,
            };
          }
          return {
            detail: `batchTable=${writeback.batchTableId}; topicTable=${writeback.topicTableId}`,
          };
        });
        if (writeback.status === 'skipped' && writeback.reason === 'permission_denied') {
          Toast.warning('没有 Base 编辑权限，已仅保存插件缓存');
        } else if (writeback.status === 'skipped' && writeback.reason === 'unconfirmed') {
          Toast.warning('写回创建尚未确认，已仅保存插件缓存');
        }
      } catch (writebackError) {
        Toast.warning(writebackError instanceof Error ? `写回失败：${writebackError.message}` : '写回失败，已保留插件缓存');
      }
      setConfig((current) => ({ ...current, filters, analysisCache: cache }));
      setCurrentScope(scope);
      setAnalysis(result);
      setSelectedTopic(null);
      setEvidenceRecords([]);
      setEvidencePage(1);
      Toast.success('AI 聚合分析已更新');
    } catch (cause) {
      const message = formatAiClientError(cause);
      setError(message);
      Toast.error(`更新分析失败：${message}`);
    } finally {
      publishAnalysisTimingReport(timingRows, getNowMs() - runStartedAt);
      setLoading(false);
      setAnalysisRunning(false);
      runtime.setRendered();
    }
  }

  async function handleTestConnection() {
    if (!config.ai.apiKey.trim()) {
      const message = '请先填写并保存 API Key';
      setError(message);
      Toast.error(message);
      return;
    }

    setTestingConnection(true);
    try {
      const result = await testAiConnection({ config: config.ai });
      Toast.success(`AI API 连接成功：${result.model}`);
    } catch (cause) {
      Toast.error(`AI API 测试失败：${formatAiClientError(cause)}`);
    } finally {
      setTestingConnection(false);
    }
  }

  async function handleWarmup(mode: WarmupMode) {
    setError(null);
    setWarmupRunning(true);
    const triggeredAt = new Date().toISOString();
    try {
      const response = await triggerWarmup(config, mode, 'dashboard-button');
      setWarmupStatus({ response, triggeredAt });
      if (response.status === 'failed') {
        const message = formatWarmupFailure(response.errors[0]);
        setError(message);
        Toast.error(message);
        return;
      }
      if (response.status === 'skipped') {
        const message = response.errors[0]
          ? formatWarmupFailure(response.errors[0]).replace('缓存预热失败', '缓存预热跳过')
          : '缓存预热已跳过';
        Toast.warning(message);
        return;
      }
      Toast.success(
        `缓存预热完成：新增证据 ${response.summary.evidenceRecordsSaved} 条，新增主题映射 ${response.summary.topicMappingsSaved} 条`,
      );
    } catch (cause) {
      const message = formatWarmupClientError(cause);
      setWarmupStatus((current) =>
        current && current.response.status === 'failed'
          ? current
          : {
              response: {
                jobId: 'warmup-client-error',
                status: 'failed',
                mode,
                summary: {
                  totalReviews: 0,
                  evidenceCacheHits: 0,
                  evidenceCacheMisses: 0,
                  evidenceRecordsSaved: 0,
                  topicMappingHits: 0,
                  topicMappingMisses: 0,
                  topicMappingsSaved: 0,
                },
                errors: [
                  {
                    stage: 'validate_request',
                    message,
                  },
                ],
              },
              triggeredAt,
            },
      );
      setError(message);
      Toast.error(message);
    } finally {
      setWarmupRunning(false);
      runtime.setRendered();
    }
  }

  async function handleSelectTopic(topic: TopicSummary) {
    setSelectedTopic(topic);
    setEvidencePage(1);
    await loadTopicEvidencePage(topic, 1);
  }

  async function handleEvidencePageChange(page: number) {
    if (!selectedTopic) {
      return;
    }
    setEvidencePage(page);
    await loadTopicEvidencePage(selectedTopic, page);
  }

  async function loadTopicEvidencePage(topic: TopicSummary, page: number) {
    const requestId = evidenceRequestId.current + 1;
    evidenceRequestId.current = requestId;

    const start = (page - 1) * EVIDENCE_PAGE_SIZE;
    const pageRecordIds = topic.commentRecordIds.slice(start, start + EVIDENCE_PAGE_SIZE);
    if (!pageRecordIds.length || !config.source.tableId.trim()) {
      setEvidenceRecords([]);
      setEvidenceLoading(false);
      return;
    }

    setEvidenceLoading(true);
    try {
      const records = await runtime.readRecordsByIds(config.source.tableId, pageRecordIds);
      if (evidenceRequestId.current !== requestId) {
        return;
      }
      const recordsById = new Map(records.map((record) => [record.recordId, record]));
      setEvidenceRecords(
        pageRecordIds
          .map((recordId) => recordsById.get(recordId))
          .filter((record): record is NonNullable<typeof record> => Boolean(record))
          .map((record) => normalizeReviewRecord(record, config.source.fields)),
      );
    } catch (cause) {
      if (evidenceRequestId.current !== requestId) {
        return;
      }
      setError(cause instanceof Error ? cause.message : '读取关联评论失败');
    } finally {
      if (evidenceRequestId.current === requestId) {
        setEvidenceLoading(false);
        runtime.setRendered();
      }
    }
  }

  function handleCloseTopic() {
    evidenceRequestId.current += 1;
    setSelectedTopic(null);
    setEvidenceRecords([]);
    setEvidencePage(1);
    setEvidenceLoading(false);
  }

  async function handleSaveConfig() {
    setError(null);
    const saveValidationMessage = getSaveValidationMessage(config);
    if (saveValidationMessage) {
      setError(saveValidationMessage);
      Toast.error(saveValidationMessage);
      return;
    }

    setSaving(true);
    const configToSave = { ...config, filters };
    const sourceRequestId = configSourceRequestId.current;
    try {
      const manualSaveTraceId = createAnalysisCacheTraceId();
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_BEGIN__', 'manual-config', {
        traceId: manualSaveTraceId,
        state,
        configToSave,
      });
      await savePluginConfig(runtime, configToSave);
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_END__', 'manual-config', {
        traceId: manualSaveTraceId,
        state,
        configToSave,
      });
      loadFilterOptionRecords(configToSave, sourceRequestId).catch(() => undefined);
      Toast.success('配置已保存');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存配置失败';
      setError(message);
      Toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function loadFilterOptionRecords(pluginConfig: PluginConfig, requestId?: number) {
    const isCurrentRequest = () => isCurrentConfigSourceRequest(requestId);
    if (!pluginConfig.source.tableId.trim()) {
      if (isCurrentRequest()) {
        setOptionRecords([]);
      }
      return;
    }
    if (!hasFilterOptionRequiredFields(pluginConfig.source.fields)) {
      if (isCurrentRequest()) {
        setOptionRecords([]);
      }
      return;
    }

    const records = await readRecordsForConfig(runtime, pluginConfig);
    if (isCurrentRequest()) {
      setOptionRecords(records);
    }
  }

  async function handleConfigChange(nextConfig: PluginConfig) {
    const previousTableId = config.source.tableId;
    const nextTableId = nextConfig.source.tableId;
    const dataRangeChanged = !isSameDataRange(config.source.dataRange, nextConfig.source.dataRange);
    const fieldMappingChanged = !isSameFieldMapping(config.source.fields, nextConfig.source.fields);
    setConfig(nextConfig);
    if (nextTableId === previousTableId) {
      if ((dataRangeChanged || fieldMappingChanged) && isConfigMode) {
        setError(null);
        setOptionRecords([]);
        const requestId = configSourceRequestId.current + 1;
        configSourceRequestId.current = requestId;
        try {
          const [previewData, optionRecordsResult] = await Promise.all([
            runtime.getPreviewData(buildDataConditions(nextConfig)),
            hasFilterOptionRequiredFields(nextConfig.source.fields) ? readRecordsForConfig(runtime, nextConfig) : Promise.resolve(null),
          ]);
          if (!isCurrentConfigSourceRequest(requestId)) {
            return;
          }
          setHostData(previewData);
          setCurrentScope(buildCurrentScope(nextConfig, previewData, nextConfig.analysisCache?.scopeSnapshot as ScopeSnapshot | undefined));
          setOptionRecords(optionRecordsResult ?? []);
        } catch (cause) {
          if (!isCurrentConfigSourceRequest(requestId)) {
            return;
          }
          setError(cause instanceof Error ? cause.message : '读取字段配置失败');
        }
      }
      return;
    }
    setError(null);
    setCategories([]);
    setDataRanges([]);
    setHostData(null);
    setOptionRecords([]);
    setConfig({
      ...nextConfig,
      source: {
        ...nextConfig.source,
        dataRange: undefined,
        viewId: undefined,
      },
    });

    if (!nextTableId.trim()) {
      configSourceRequestId.current += 1;
      return;
    }

    const requestId = configSourceRequestId.current + 1;
    configSourceRequestId.current = requestId;
    try {
      const [categoryList, dataRangeList] = await Promise.all([
        runtime.getCategories(nextTableId),
        runtime.getTableDataRange(nextTableId),
      ]);
      if (!isCurrentConfigSourceRequest(requestId)) {
        return;
      }
      const runtimeCategories = categoryList as RuntimeCategory[];
      const normalizedSource = normalizeSourceSelection(
        {
          ...nextConfig.source,
          dataRange: nextConfig.source.dataRange,
          viewId: nextConfig.source.viewId,
        },
        dataRangeList as IDataRange[],
      );
      const configWithSuggestedFields = withSuggestedFieldMapping(
        {
          ...nextConfig,
          source: normalizedSource,
        },
        runtimeCategories,
      );
      setConfig(configWithSuggestedFields);
      setCategories(runtimeCategories);
      setDataRanges(dataRangeList as IDataRange[]);
      const previewData = await runtime.getPreviewData(buildDataConditions(configWithSuggestedFields));
      if (!isCurrentConfigSourceRequest(requestId)) {
        return;
      }
      setHostData(previewData);
      setCurrentScope(
        buildCurrentScope(
          configWithSuggestedFields,
          previewData,
          configWithSuggestedFields.analysisCache?.scopeSnapshot as ScopeSnapshot | undefined,
        ),
      );
      loadFilterOptionRecords(configWithSuggestedFields, requestId).catch(() => undefined);
    } catch (cause) {
      if (!isCurrentConfigSourceRequest(requestId)) {
        return;
      }
      setError(cause instanceof Error ? cause.message : '读取字段配置失败');
    }
  }

  function handleFilterChange(nextFilters: FilterState) {
    applyFilterSelection(nextFilters);
  }

  function applyFilterSelection(nextFilters: FilterState) {
    const nextConfig = { ...configRef.current, filters: nextFilters };
    configRef.current = nextConfig;
    setFilters(nextFilters);
    setConfig(nextConfig);
    if (analysis) {
      setCurrentScope(buildCurrentScope(nextConfig, hostData, currentScope, nextFilters));
    }
    if (!isConfigMode && !loading && !saving) {
      const displayFilterSaveTraceId = createAnalysisCacheTraceId();
      debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_BEGIN__', 'display-filter', {
        traceId: displayFilterSaveTraceId,
        state,
        loading,
        saving,
        nextConfig,
      });
      savePluginConfig(runtime, nextConfig).then(() => {
        debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_END__', 'display-filter', {
          traceId: displayFilterSaveTraceId,
          state,
          nextConfig,
        });
      }).catch((cause) => {
        debugAnalysisCacheConfig('__HOTEL_REVIEW_AI_CONFIG_SAVE_FAIL__', 'display-filter', {
          traceId: displayFilterSaveTraceId,
          state,
          nextConfig,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        const message = cause instanceof Error ? cause.message : '保存筛选配置失败';
        setError(message);
        Toast.error(message);
      });
    }
  }

  function handlePeriodChange(periodType: PeriodType) {
    if (periodType === 'custom') {
      applyFilterSelection({ ...filters, periodType });
      return;
    }
    const range = getPeriodRange(periodType);
    applyFilterSelection({ ...filters, periodType, ...range });
  }

  const shell = (
    <DashboardShell
      analysis={analysis}
      filters={filters}
      hotelOptions={hotelOptions}
      checkInMonthOptions={checkInMonthOptions}
      selectedTopic={selectedTopic}
      evidenceRecords={evidenceRecords}
      evidencePage={evidencePage}
      evidencePageSize={EVIDENCE_PAGE_SIZE}
      evidenceLoading={evidenceLoading}
      loading={loading}
      analysisRunning={analysisRunning}
      error={error}
      scopeWarning={scopeWarning}
      stale={stale}
      warmupStatus={warmupStatus}
      onFilterChange={handleFilterChange}
      onPeriodChange={handlePeriodChange}
      onUpdate={handleUpdateAnalysis}
      onSelectTopic={handleSelectTopic}
      onEvidencePageChange={handleEvidencePageChange}
      onCloseTopic={handleCloseTopic}
    />
  );

  if (!isConfigMode) {
    return shell;
  }

  return (
    <div className="config-layout">
      <div className="config-preview">{shell}</div>
      <ConfigPanel
        config={config}
        tables={tables}
        categories={categories}
        dataRanges={dataRanges}
        saving={saving}
        testingConnection={testingConnection}
        warmupRunning={warmupRunning}
        disabled={loading || saving}
        onChange={handleConfigChange}
        onSave={handleSaveConfig}
        onTestConnection={handleTestConnection}
        onWarmupBootstrap={() => handleWarmup('bootstrap')}
        onWarmupIncremental={() => handleWarmup('incremental')}
      />
    </div>
  );
}

function readRecordsForConfig(runtime: DashboardRuntime, pluginConfig: PluginConfig): Promise<ReviewRecord[]> {
  if (!pluginConfig.source.tableId.trim()) {
    return Promise.resolve([]);
  }

  return readReviewRecords(
    (params) =>
      runtime.readRecordsPage(params.tableId, {
        viewId: params.viewId,
        pageSize: params.pageSize,
        pageToken: params.pageToken,
      }),
    {
      tableId: pluginConfig.source.tableId,
      viewId: pluginConfig.source.viewId,
      fields: pluginConfig.source.fields,
    },
  );
}

function formatWarmupFailure(error: WarmupResponse['errors'][number] | undefined): string {
  if (!error) {
    return '缓存预热失败';
  }
  return `缓存预热失败：${error.stage} ${error.message}`;
}

function formatWarmupClientError(cause: unknown): string {
  const error = cause as { stage?: unknown; message?: unknown };
  const message = typeof error.message === 'string' ? error.message : cause instanceof Error ? cause.message : String(cause);
  if (typeof error.stage === 'string' && error.stage) {
    return `缓存预热失败：${error.stage} ${message}`;
  }
  return `缓存预热失败：${message}`;
}

function withComputedRange(filters: FilterState): FilterState {
  if (filters.periodType === 'custom') {
    return filters;
  }
  return {
    ...filters,
    ...getPeriodRange(filters.periodType),
  };
}

function buildCurrentScope(
  pluginConfig: PluginConfig,
  hostDataSnapshot: unknown[][] | null,
  cachedScope?: ScopeSnapshot | null,
  nextFilters?: FilterState,
): ScopeSnapshot | null {
  if (!cachedScope && !pluginConfig.analysisCache?.result) {
    return null;
  }

  const currentFilters = nextFilters ?? withComputedRange(pluginConfig.filters);
  return {
    filters: currentFilters,
    fields: pluginConfig.source.fields,
    model: pluginConfig.ai.model,
    analysisCopyVersion: ANALYSIS_COPY_VERSION,
    totalReviews: cachedScope?.totalReviews ?? pluginConfig.analysisCache?.result.overview.totalReviews ?? 0,
    firstRecordId: cachedScope?.firstRecordId ?? null,
    lastRecordId: cachedScope?.lastRecordId ?? null,
    source: buildCurrentSourceScope(pluginConfig, hostDataSnapshot),
  };
}

function buildCurrentSourceScope(pluginConfig: PluginConfig, hostDataSnapshot: unknown[][] | null): ScopeSnapshot['source'] {
  return {
    tableId: pluginConfig.source.tableId,
    dataRange: pluginConfig.source.dataRange,
    hostDataSignal: buildHostDataSignal(hostDataSnapshot),
  };
}

function uniqueSorted(values: string[], selectedValue: string): string[] {
  const uniqueValues = Array.from(new Set(values)).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
  if (selectedValue !== 'all' && selectedValue && !uniqueValues.includes(selectedValue)) {
    return [selectedValue, ...uniqueValues];
  }
  return uniqueValues;
}

function withSuggestedFieldMapping(pluginConfig: PluginConfig, fields: RuntimeCategory[]): PluginConfig {
  const suggestedFields = suggestFieldMapping(fields);
  let changed = false;
  const nextFields = { ...pluginConfig.source.fields };

  for (const key of getMissingRequiredFields(nextFields)) {
    if (suggestedFields[key]) {
      nextFields[key] = suggestedFields[key];
      changed = true;
    }
  }

  if (!changed) {
    return pluginConfig;
  }

  return {
    ...pluginConfig,
    source: {
      ...pluginConfig.source,
      fields: nextFields,
    },
  };
}

function getMissingFieldMappingMessage(fields: FieldMapping): string | null {
  const missingFields = getMissingRequiredFields(fields);
  if (!missingFields.length) {
    return null;
  }

  return `请先完成字段映射：${missingFields.map((key) => FIELD_LABELS[key]).join('、')}`;
}

function getSaveValidationMessage(config: PluginConfig): string | null {
  if (!config.source.tableId.trim()) {
    return '请先选择数据表';
  }

  const missingFieldMessage = getMissingFieldMappingMessage(config.source.fields);
  if (missingFieldMessage) {
    return missingFieldMessage;
  }

  if (!config.ai.apiBaseUrl.trim()) {
    return '请先填写 API Base URL';
  }

  if (!config.ai.model.trim()) {
    return '请先填写 Model';
  }

  return null;
}

function getViewIdFromDataRange(dataRange?: IDataRange): string | undefined {
  return dataRange?.type === 'VIEW' ? dataRange.viewId : undefined;
}

function getDataRangeValue(dataRange?: IDataRange): string | undefined {
  if (!dataRange) {
    return undefined;
  }
  return dataRange.type === SourceType.VIEW ? `${SourceType.VIEW}:${dataRange.viewId}` : SourceType.ALL;
}

function normalizeSourceSelection(source: PluginConfig['source'], dataRanges: IDataRange[]): PluginConfig['source'] {
  const fallbackDataRange = dataRanges.find((dataRange) => dataRange.type === SourceType.ALL) ?? ({ type: SourceType.ALL } as IDataRange);
  const requestedValue = getDataRangeValue(source.dataRange);
  const resolvedDataRange = requestedValue
    ? dataRanges.find((dataRange) => getDataRangeValue(dataRange) === requestedValue) ?? fallbackDataRange
    : fallbackDataRange;

  return {
    ...source,
    dataRange: resolvedDataRange,
    viewId: getViewIdFromDataRange(resolvedDataRange),
  };
}

function isSameDataRange(left?: IDataRange, right?: IDataRange): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function isSameFieldMapping(left: FieldMapping, right: FieldMapping): boolean {
  return Object.keys(left).every((key) => left[key as keyof FieldMapping] === right[key as keyof FieldMapping]);
}

function hasFilterOptionRequiredFields(fields: FieldMapping): boolean {
  return FILTER_OPTION_REQUIRED_FIELD_KEYS.every((key) => fields[key]?.trim());
}

type AnalysisTimingStatus = 'success' | 'error' | 'skipped';

type AnalysisTimingRow = {
  step: string;
  durationMs: number;
  status: AnalysisTimingStatus;
  records?: number;
  detail?: string;
};

type AnalysisTimingMeta = Omit<Partial<AnalysisTimingRow>, 'step' | 'durationMs'>;

type AnalysisTimingDebugGlobal = typeof globalThis & {
  __HOTEL_REVIEW_AI_LAST_TIMING__?: {
    totalMs: number;
    rows: AnalysisTimingRow[];
  };
};

async function measureAnalysisStep<T>(
  rows: AnalysisTimingRow[],
  step: string,
  action: () => Promise<T>,
  getMeta?: (result: T) => AnalysisTimingMeta,
): Promise<T> {
  const startedAt = getNowMs();
  try {
    const result = await action();
    rows.push({
      step,
      durationMs: roundMs(getNowMs() - startedAt),
      status: 'success',
      ...getMeta?.(result),
    });
    return result;
  } catch (cause) {
    rows.push({
      step,
      durationMs: roundMs(getNowMs() - startedAt),
      status: 'error',
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

function measureAnalysisSyncStep<T>(
  rows: AnalysisTimingRow[],
  step: string,
  action: () => T,
  getMeta?: (result: T) => AnalysisTimingMeta,
): T {
  const startedAt = getNowMs();
  try {
    const result = action();
    rows.push({
      step,
      durationMs: roundMs(getNowMs() - startedAt),
      status: 'success',
      ...getMeta?.(result),
    });
    return result;
  } catch (cause) {
    rows.push({
      step,
      durationMs: roundMs(getNowMs() - startedAt),
      status: 'error',
      detail: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
}

function publishAnalysisTimingReport(rows: AnalysisTimingRow[], totalMs: number): void {
  const report = {
    totalMs: roundMs(totalMs),
    rows,
  };
  (globalThis as AnalysisTimingDebugGlobal).__HOTEL_REVIEW_AI_LAST_TIMING__ = report;

  if (typeof console === 'undefined' || !rows.length) {
    return;
  }

  const tableRows = rows.map((row) => ({
    环节: row.step,
    状态: row.status,
    耗时ms: row.durationMs,
    评论数: row.records ?? '',
    详情: row.detail ?? '',
  }));
  const title = `[酒店评论 AI 分析耗时] 总耗时 ${report.totalMs}ms`;
  const hasGroup = typeof console.groupCollapsed === 'function' && typeof console.groupEnd === 'function';

  if (hasGroup) {
    console.groupCollapsed(title);
  } else {
    console.info(title);
  }

  if (typeof console.table === 'function') {
    console.table(tableRows);
  } else {
    console.info(tableRows);
  }
  console.info('__HOTEL_REVIEW_AI_LAST_TIMING__', report);
  console.info('__HOTEL_REVIEW_AI_TIMING_JSON__', JSON.stringify(report));

  if (hasGroup) {
    console.groupEnd();
  }
}

function logAnalysisDebug(label: string, payload: unknown): void {
  if (typeof console === 'undefined') {
    return;
  }
  console.info(label, JSON.stringify(payload));
}

function debugAnalysisCacheConfig(
  label: string,
  source: string,
  payload: {
    traceId?: string;
    state?: DashboardStateName;
    reloadToken?: number;
    loading?: boolean;
    saving?: boolean;
    filters?: FilterState;
    pluginConfig?: PluginConfig;
    configToSave?: PluginConfig;
    nextConfig?: PluginConfig;
    runtimeConfig?: unknown;
    error?: string;
  },
): void {
  const pluginConfig = payload.pluginConfig ?? payload.configToSave ?? payload.nextConfig ?? getRuntimePluginConfig(payload.runtimeConfig);
  const analysisCache = pluginConfig?.analysisCache;
  const filters = payload.filters ?? pluginConfig?.filters;
  logAnalysisDebug(label, {
    source,
    traceId: payload.traceId ?? createAnalysisCacheTraceId(),
    state: payload.state,
    reloadToken: payload.reloadToken,
    loading: payload.loading,
    saving: payload.saving,
    hasAnalysisCache: Boolean(analysisCache),
    cache: summarizeAnalysisCache(analysisCache),
    filters: filters ? summarizeFilters(filters) : undefined,
    sourceConfig: pluginConfig
      ? {
          tableId: pluginConfig.source.tableId,
          viewId: pluginConfig.source.viewId,
          dataRangeType: pluginConfig.source.dataRange?.type,
        }
      : undefined,
    runtimeConfigHasCustomConfig: hasRuntimeCustomConfig(payload.runtimeConfig),
    error: payload.error,
  });
}

function getRuntimePluginConfig(runtimeConfig: unknown): PluginConfig | undefined {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') {
    return undefined;
  }
  const customConfig = (runtimeConfig as { customConfig?: unknown }).customConfig;
  if (!customConfig || typeof customConfig !== 'object') {
    return undefined;
  }
  return customConfig as PluginConfig;
}

function hasRuntimeCustomConfig(runtimeConfig: unknown): boolean | undefined {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') {
    return undefined;
  }
  return Boolean((runtimeConfig as { customConfig?: unknown }).customConfig);
}

function summarizeAnalysisCache(analysisCache: AnalysisCache | undefined) {
  if (!analysisCache) {
    return undefined;
  }
  return {
    analysisId: analysisCache.result.analysisId,
    resultGeneratedAt: analysisCache.result.generatedAt,
    cacheGeneratedAt: analysisCache.generatedAt,
    model: analysisCache.model,
    totalReviews: analysisCache.result.overview.totalReviews,
    positiveTopicCount: analysisCache.result.positiveTopics.length,
    negativeTopicCount: analysisCache.result.negativeTopics.length,
    bytes: new TextEncoder().encode(JSON.stringify(analysisCache)).length,
  };
}

function summarizeFilters(filters: FilterState) {
  return {
    hotelName: filters.hotelName,
    periodType: filters.periodType,
    startDate: filters.startDate,
    endDate: filters.endDate,
    checkInMonth: filters.checkInMonth,
    minScore: filters.minScore,
    maxScore: filters.maxScore,
    replyStatus: filters.replyStatus,
    keyword: filters.keyword,
  };
}

function createAnalysisCacheTraceId(): string {
  return `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value);
}
