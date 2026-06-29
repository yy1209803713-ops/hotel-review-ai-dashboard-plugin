import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { SourceType, type IDataRange } from '@lark-base-open/js-sdk';
import { ConfigPanel } from './components/ConfigPanel';
import { DashboardShell } from './components/DashboardShell';
import { DEFAULT_CONFIG, FIELD_LABELS } from './constants/defaults';
import { buildDataConditions } from './services/dashboardConfig';
import { logConfigDebug, summarizeFieldMapping, summarizePluginConfig } from './services/debugLog';
import { getPeriodRange } from './services/filtering';
import { normalizeReviewRecord, readReviewRecords } from './services/baseRecords';
import { getMissingRequiredFields, suggestFieldMapping } from './services/fieldMapping';
import { loadPluginConfig, savePluginConfig } from './services/cacheStore';
import {
  assertRenderableAnalysisSummary,
  BackendAnalysisError,
  createBackendAnalysisClient,
  type BackendAnalysisClient,
  type BackendAnalysisJob,
  type BackendOwnership,
} from './services/backendAnalysisClient';
import {
  runtime as defaultRuntime,
  type DashboardRuntime,
  type RuntimeCategory,
  type RuntimeTable,
} from './runtime/sdk';
import type { FieldMapping, FilterState, PeriodType, PluginConfig } from './types/config';
import type { AnalysisResult, ReviewRecord, TopicSummary } from './types/analysis';

const EVIDENCE_PAGE_SIZE = 10;
const FILTER_OPTION_REQUIRED_FIELD_KEYS: Array<keyof FieldMapping> = ['content', 'hotelName', 'checkInMonth'];
const COMPLETE_JOB_STATUSES = new Set(['success', 'failed', 'canceled']);

type TopicEvidencePage = {
  evidence: Array<{
    evidenceId?: string;
    recordId?: string;
    quote?: string;
    quotes?: string[];
    review?: Partial<ReviewRecord>;
  }>;
  page: number;
};

type DisplayInitSnapshot = {
  configWithBackend: PluginConfig;
  analysis: AnalysisResult | null;
  activeJob: BackendAnalysisJob | null;
  currentScopeKey: string | null;
  currentResultId: string | null;
};

type BackendResultSnapshot = {
  analysis: AnalysisResult;
  resultId: string;
};

type RuntimePromiseCacheEntry<T> = {
  promise: Promise<T>;
};

const displayInitSnapshotCache = new WeakMap<object, Map<string, RuntimePromiseCacheEntry<DisplayInitSnapshot>>>();

function getRuntimeCacheKey(runtime: DashboardRuntime): object {
  return runtime.cacheKey ?? runtime;
}

function getCachedRuntimePromise<T>(
  cache: WeakMap<object, Map<string, { promise: Promise<T> }>>,
  runtime: DashboardRuntime,
  cacheKey: string,
  factory: () => Promise<T>,
) {
  const runtimeCacheKey = getRuntimeCacheKey(runtime);
  let runtimeCache = cache.get(runtimeCacheKey);
  if (!runtimeCache) {
    runtimeCache = new Map<string, { promise: Promise<T> }>();
    cache.set(runtimeCacheKey, runtimeCache);
  }

  const cachedEntry = runtimeCache.get(cacheKey);
  if (cachedEntry) {
    return cachedEntry.promise;
  }

  const nextEntry: RuntimePromiseCacheEntry<T> = {
    promise: Promise.resolve()
      .then(factory)
      .finally(() => {
        const currentRuntimeCache = cache.get(runtimeCacheKey);
        if (currentRuntimeCache?.get(cacheKey) === nextEntry) {
          currentRuntimeCache.delete(cacheKey);
        }
      }),
  };
  runtimeCache.set(cacheKey, nextEntry);
  return nextEntry.promise;
}

export default function App() {
  const runtime = defaultRuntime;
  const [state] = useState(runtime.getState());
  const [config, setConfig] = useState<PluginConfig>(DEFAULT_CONFIG);
  const [filters, setFilters] = useState<FilterState>(() => withComputedRange(DEFAULT_CONFIG.filters));
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisFilters, setAnalysisFilters] = useState<FilterState | null>(null);
  const [selectedTopic, setSelectedTopic] = useState<TopicSummary | null>(null);
  const [evidenceRecords, setEvidenceRecords] = useState<ReviewRecord[]>([]);
  const [evidencePage, setEvidencePage] = useState(1);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [tables, setTables] = useState<RuntimeTable[]>([]);
  const [categories, setCategories] = useState<RuntimeCategory[]>([]);
  const [dataRanges, setDataRanges] = useState<IDataRange[]>([]);
  const [loading, setLoading] = useState(true);
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [exportingSummary, setExportingSummary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeWarning, setScopeWarning] = useState<string | null>(null);
  const [optionRecords, setOptionRecords] = useState<ReviewRecord[]>([]);
  const [hostData, setHostData] = useState<unknown[][] | null>(null);
  const [currentScopeKey, setCurrentScopeKey] = useState<string | null>(null);
  const [currentResultId, setCurrentResultId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const hostDataGenerationRef = useRef(0);
  const evidenceRequestId = useRef(0);
  const configSourceRequestId = useRef(0);
  const initRequestRef = useRef(0);
  const renderedRequestRef = useRef(0);
  const configReloadSuppressionRef = useRef(0);
  const configRef = useRef(config);
  const mountedRef = useRef(true);

  const isConfigMode = state === 'Create' || state === 'Config';
  const showCacheDiagnostics = isDemoMode();
  const isCurrentConfigSourceRequest = (requestId?: number) =>
    mountedRef.current && (requestId === undefined || configSourceRequestId.current === requestId);
  const isConfigReloadSuppressed = () => configReloadSuppressionRef.current > 0;

  async function withSuppressedConfigReloads<T>(action: () => Promise<T>): Promise<T> {
    configReloadSuppressionRef.current += 1;
    try {
      return await action();
    } finally {
      configReloadSuppressionRef.current = Math.max(0, configReloadSuppressionRef.current - 1);
    }
  }

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
      if (mountedRef.current) {
        document.documentElement.setAttribute('theme-mode', theme.theme === 'DARK' ? 'dark' : 'light');
      }
    });
    const unsubscribeData = runtime.onDataChange((data) => {
      if (!mountedRef.current) {
        return;
      }
      hostDataGenerationRef.current += 1;
      setHostData(data);
      runtime.setRendered();
    });
    const unsubscribeConfig = runtime.onConfigChange(() => {
      if (!mountedRef.current || state === 'Create' || isConfigReloadSuppressed()) {
        return;
      }
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
    const initRequestId = initRequestRef.current + 1;
    initRequestRef.current = initRequestId;
    const isCurrentInitRequest = () => mountedRef.current && initRequestRef.current === initRequestId;
    const markRenderedOnce = () => {
      if (!isCurrentInitRequest() || renderedRequestRef.current === initRequestId) {
        return;
      }
      renderedRequestRef.current = initRequestId;
      runtime.setRendered();
    };

    async function init() {
      setLoading(true);
      setError(null);
      setScopeWarning(null);
      setSelectedTopic(null);
      setEvidenceRecords([]);
      setEvidencePage(1);
      setEvidenceLoading(false);
      setOptionRecords([]);
      setCategories([]);
      setDataRanges([]);
      setHostData(null);
      setAnalysis(null);
      setAnalysisFilters(null);
      setAnalysisRunning(false);
      setCurrentScopeKey(null);
      setCurrentResultId(null);
      setExportingSummary(false);
      configSourceRequestId.current += 1;

      try {
        if (state === 'View' || state === 'FullScreen') {
          await initializeDisplayState(initRequestId, markRenderedOnce);
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
        if (isCurrentInitRequest()) {
          setError(formatBackendAnalysisError(cause));
        }
      } finally {
        if (isCurrentInitRequest()) {
          setLoading(false);
          markRenderedOnce();
        }
      }
    }

    async function initializeCreateState(tableList: RuntimeTable[]) {
      const firstTable = tableList[0];
      if (!firstTable) {
        setConfig(DEFAULT_CONFIG);
        return;
      }

      const requestId = configSourceRequestId.current + 1;
      configSourceRequestId.current = requestId;
      await loadSourceMetadata({
        ...DEFAULT_CONFIG,
        source: {
          ...DEFAULT_CONFIG.source,
          tableId: firstTable.tableId,
          viewId: undefined,
          dataRange: undefined,
          fields: { ...DEFAULT_CONFIG.source.fields },
        },
      }, requestId, true);
    }

    async function initializeConfigState() {
      const pluginConfig = await loadPluginConfig(runtime);
      if (!mountedRef.current) {
        return;
      }
      setConfig(pluginConfig);
      setFilters(withComputedRange(pluginConfig.filters));
      if (!pluginConfig.source.tableId.trim()) {
        return;
      }

      const requestId = configSourceRequestId.current + 1;
      configSourceRequestId.current = requestId;
      await loadSourceMetadata(pluginConfig, requestId, true);
    }

    async function initializeDisplayState(initRequestId: number, markRenderedOnce: () => void) {
      const pluginConfig = await loadPluginConfig(runtime);
      logConfigDebug('displayInit:loadedConfig', {
        state,
        reloadToken,
        pluginConfig: summarizePluginConfig(pluginConfig),
      });
      if (!isCurrentInitRequest()) {
        return;
      }
      configRef.current = pluginConfig;
      setConfig(pluginConfig);
      setFilters(withComputedRange(pluginConfig.filters));

      let displayConfig = pluginConfig;
      let displayInitSnapshot: DisplayInitSnapshot | null = null;
      try {
        displayInitSnapshot = await getDisplayInitSnapshot(runtime, state, reloadToken, pluginConfig);
        if (!isCurrentInitRequest()) {
          return;
        }
        displayConfig = displayInitSnapshot.configWithBackend;
        configRef.current = displayConfig;
        setConfig(displayConfig);
        setFilters(withComputedRange(displayConfig.filters));
        setCurrentScopeKey(displayInitSnapshot.currentScopeKey);
        setCurrentResultId(displayInitSnapshot.currentResultId);
        setAnalysis(displayInitSnapshot.analysis);
        setAnalysisFilters(displayInitSnapshot.analysis ? withComputedRange(displayConfig.filters) : null);
        setAnalysisRunning(Boolean(displayInitSnapshot.activeJob));
      } catch (cause) {
        if (!isCurrentInitRequest()) {
          return;
        }
        setError(formatBackendAnalysisError(cause));
      }

      const sourceRequestId = configSourceRequestId.current + 1;
      configSourceRequestId.current = sourceRequestId;
      setLoading(false);
      markRenderedOnce();
      if (displayInitSnapshot?.activeJob) {
        void continueRestoredBackendJob(displayConfig, displayInitSnapshot.activeJob, initRequestId);
      }
      void loadDisplayHostDataInBackground(initRequestId, sourceRequestId);
      void loadDisplayOptionRecordsInBackground(displayConfig, initRequestId, sourceRequestId);
    }

    async function loadDisplayHostDataInBackground(initRequestId: number, sourceRequestId: number) {
      const hostDataGeneration = hostDataGenerationRef.current;
      try {
        const hostDataSnapshot = await runtime.getData();
        if (
          !isFreshDisplayHostDataRequest(
            initRequestRef.current,
            initRequestId,
            configSourceRequestId.current,
            sourceRequestId,
            hostDataGenerationRef.current,
            hostDataGeneration,
            mountedRef.current,
          )
        ) {
          return;
        }
        setHostData(hostDataSnapshot);
      } catch (cause) {
        if (
          isFreshDisplayHostDataRequest(
            initRequestRef.current,
            initRequestId,
            configSourceRequestId.current,
            sourceRequestId,
            hostDataGenerationRef.current,
            hostDataGeneration,
            mountedRef.current,
          )
        ) {
          setError(formatBackendAnalysisError(cause));
        }
        return;
      }
    }

    async function loadDisplayOptionRecordsInBackground(pluginConfig: PluginConfig, initRequestId: number, sourceRequestId: number) {
      try {
        if (!pluginConfig.source.tableId.trim() || !hasFilterOptionRequiredFields(pluginConfig.source.fields)) {
          if (isCurrentInitRequest() && initRequestRef.current === initRequestId && isCurrentConfigSourceRequest(sourceRequestId)) {
            setOptionRecords([]);
          }
          return;
        }
        const optionRecordsSnapshot = await readRecordsForConfig(runtime, pluginConfig);
        if (!isCurrentInitRequest() || initRequestRef.current !== initRequestId || !isCurrentConfigSourceRequest(sourceRequestId)) {
          return;
        }
        setOptionRecords(optionRecordsSnapshot);
      } catch (cause) {
        if (isCurrentInitRequest() && initRequestRef.current === initRequestId && isCurrentConfigSourceRequest(sourceRequestId)) {
          setError(formatBackendAnalysisError(cause));
        }
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
      const nextConfig = withSuggestedFieldMapping({ ...pluginConfig, source: normalizedSource }, runtimeCategories);
      setConfig(nextConfig);
      setCategories(runtimeCategories);
      setDataRanges(dataRangeList as IDataRange[]);

      if (loadPreview) {
        const previewData = await runtime.getPreviewData(buildDataConditions(nextConfig));
        if (!isCurrentConfigSourceRequest(requestId)) {
          return;
        }
        setHostData(previewData);
      }

      if (hasFilterOptionRequiredFields(nextConfig.source.fields)) {
        await loadFilterOptionRecords(nextConfig, requestId);
      }
    }

    init();
  }, [state, reloadToken]);

  const stale = Boolean(analysis && analysisFilters && !isSameFilterState(filters, analysisFilters));
  const hotelOptions = useMemo(
    () => uniqueSorted(optionRecords.map((record) => record.hotelName).filter(Boolean), filters.hotelName),
    [filters.hotelName, optionRecords],
  );
  const checkInMonthOptions = useMemo(
    () => uniqueSorted(optionRecords.map((record) => record.checkInMonth ?? '').filter(Boolean), filters.checkInMonth).reverse(),
    [filters.checkInMonth, optionRecords],
  );

  async function getDisplayInitSnapshot(
    runtime: DashboardRuntime,
    currentState: string,
    currentReloadToken: number,
    pluginConfig: PluginConfig,
  ) {
    const cacheKey = `${currentState}:${currentReloadToken}`;
    return getCachedRuntimePromise(displayInitSnapshotCache, runtime, cacheKey, async () => {
      const backendSnapshot = await restoreBackendAnalysis(pluginConfig);
      return {
        pluginConfig,
        ...backendSnapshot,
      };
    });
  }

  async function restoreBackendAnalysis(pluginConfig: PluginConfig): Promise<DisplayInitSnapshot> {
    return withSuppressedConfigReloads(async () => {
      const backendValidationMessage = getBackendValidationMessage(pluginConfig);
      if (backendValidationMessage) {
        throw new BackendAnalysisError('validate_request', backendValidationMessage);
      }

      const ownership = await getBackendOwnership(runtime);
      const client = createBackendAnalysisClient({ endpointUrl: pluginConfig.backend.endpointUrl });
      const upserted = await upsertBackendAnalysisConfig(client, ownership, pluginConfig);
      const configWithBackend = withBackendConfigId(pluginConfig, upserted);
      configRef.current = configWithBackend;
      if (shouldPersistBackendConfigMetadata(pluginConfig, upserted)) {
        await savePluginConfig(runtime, configWithBackend);
      }

      const scope = await client.resolveScope({ ...ownership, configId: upserted.configId });
      const currentJob = await client.getCurrentJob({ ...ownership, scopeKey: scope.scopeKey });
      if (currentJob && !COMPLETE_JOB_STATUSES.has(currentJob.status)) {
        const latestSnapshot = await fetchLatestBackendResult(client, ownership, currentJob.scopeKey, undefined, true);
        if (latestSnapshot) {
          return {
            configWithBackend,
            activeJob: currentJob,
            currentScopeKey: currentJob.scopeKey,
            currentResultId: latestSnapshot.resultId,
            analysis: latestSnapshot.analysis,
          };
        }
        return {
          configWithBackend,
          activeJob: currentJob,
          currentScopeKey: currentJob.scopeKey,
          currentResultId: null,
          analysis: null,
        };
      }
      if (currentJob?.status === 'success') {
        if (!currentJob.resultId) {
          throw new BackendAnalysisError('validate_response', '后端成功任务缺少 resultId');
        }
        const currentSnapshot = await fetchLatestBackendResult(client, ownership, currentJob.scopeKey, currentJob.resultId);
        return {
          configWithBackend,
          activeJob: null,
          currentScopeKey: currentJob.scopeKey,
          currentResultId: currentJob.resultId,
          analysis: currentSnapshot?.analysis ?? null,
        };
      }
      if (currentJob?.status === 'failed' || currentJob?.status === 'canceled') {
        throw new BackendAnalysisError(
          currentJob.errorStage ?? currentJob.stage ?? 'load_config',
          currentJob.errorMessage ?? (currentJob.status === 'canceled' ? '后端分析任务已取消' : '后端分析任务失败'),
        );
      }

      const latestSnapshot = await fetchLatestBackendResult(client, ownership, scope.scopeKey, undefined, true);
      return {
        configWithBackend,
        activeJob: null,
        currentScopeKey: scope.scopeKey,
        currentResultId: latestSnapshot?.resultId ?? null,
        analysis: latestSnapshot?.analysis ?? null,
      };
    });
  }

  async function continueRestoredBackendJob(pluginConfig: PluginConfig, initialJob: BackendAnalysisJob, initRequestId: number) {
    try {
      const ownership = await getBackendOwnership(runtime);
      const client = createBackendAnalysisClient({ endpointUrl: pluginConfig.backend.endpointUrl });
      const completedJob = await waitForBackendJob(
        client,
        ownership,
        initialJob,
        () => mountedRef.current && initRequestRef.current === initRequestId,
      );
      if (!mountedRef.current || initRequestRef.current !== initRequestId) {
        return;
      }
      if (completedJob.status !== 'success' || !completedJob.resultId) {
        throw new BackendAnalysisError(
          completedJob.errorStage ?? completedJob.stage ?? 'load_config',
          completedJob.errorMessage ?? '后端分析任务未成功完成',
        );
      }
      await loadLatestBackendResult(
        client,
        ownership,
        completedJob.scopeKey,
        completedJob.resultId,
        false,
        pluginConfig.filters,
      );
    } catch (cause) {
      if (mountedRef.current && initRequestRef.current === initRequestId) {
        const message = formatBackendAnalysisError(cause);
        setError(message);
        Toast.error(`恢复后端分析任务失败：${message}`);
      }
    } finally {
      if (mountedRef.current && initRequestRef.current === initRequestId) {
        setAnalysisRunning(false);
        runtime.setRendered();
      }
    }
  }

  async function handleUpdateAnalysis() {
    setError(null);
    setScopeWarning(null);
    logConfigDebug('handleUpdateAnalysis:beforeValidation', {
      state,
      config: summarizePluginConfig(config),
      fields: summarizeFieldMapping(config.source.fields),
    });
    const missingFieldMessage = getMissingFieldMappingMessage(config.source.fields);
    if (missingFieldMessage) {
      logConfigDebug('handleUpdateAnalysis:missingFields', {
        state,
        message: missingFieldMessage,
        fields: summarizeFieldMapping(config.source.fields),
      });
      setError(missingFieldMessage);
      Toast.error(missingFieldMessage);
      return;
    }

    const backendValidationMessage = getBackendValidationMessage(config);
    if (backendValidationMessage) {
      setError(backendValidationMessage);
      Toast.error(backendValidationMessage);
      return;
    }

    setLoading(true);
    setAnalysisRunning(true);
    setAnalysis(null);
    setAnalysisFilters(null);
    setSelectedTopic(null);
    setEvidenceRecords([]);
    setEvidencePage(1);
    setCurrentScopeKey(null);
    setCurrentResultId(null);
    Toast.info('已提交后端分析任务');
    console.info(
      '__HOTEL_REVIEW_AI_FRONTEND_ANALYSIS_REQUEST__',
      JSON.stringify({
        filters,
        backendEndpointUrl: config.backend.endpointUrl,
        hasBaseToken: Boolean(config.backend.baseToken.trim()),
        tableId: config.source.tableId,
        viewId: config.source.viewId,
      }),
    );

    try {
      await withSuppressedConfigReloads(async () => {
        const configToSave = { ...config, filters };
        await savePluginConfig(runtime, configToSave);
        const ownership = await getBackendOwnership(runtime);
        const client = createBackendAnalysisClient({ endpointUrl: configToSave.backend.endpointUrl });
        const upserted = await upsertBackendAnalysisConfig(client, ownership, configToSave);
        const configWithBackend = withBackendConfigId(configToSave, upserted);
        configRef.current = configWithBackend;
        setConfig(configWithBackend);
        await savePluginConfig(runtime, configWithBackend);

        const createdJob = await client.createAnalysisJob({
          ...ownership,
          configId: upserted.configId,
          forceRefresh: true,
        });
        const completedJob = await waitForBackendJob(client, ownership, createdJob, () => mountedRef.current);
        if (completedJob.status !== 'success' || !completedJob.resultId) {
          throw new BackendAnalysisError(
            completedJob.errorStage ?? completedJob.stage ?? 'load_config',
            completedJob.errorMessage ?? '后端分析任务未成功完成',
          );
        }
        await loadLatestBackendResult(client, ownership, completedJob.scopeKey, completedJob.resultId);
        Toast.success('后端 AI 聚合分析已更新');
      });
    } catch (cause) {
      const message = formatBackendAnalysisError(cause);
      setError(message);
      Toast.error(`更新分析失败：${message}`);
    } finally {
      setLoading(false);
      setAnalysisRunning(false);
      runtime.setRendered();
    }
  }

  async function handleExportBaseSummary() {
    setError(null);
    if (!currentResultId || !currentScopeKey) {
      const message = '当前没有可导出的后端分析结果';
      setError(message);
      Toast.error(message);
      return;
    }

    const backendValidationMessage = getBackendValidationMessage(config);
    if (backendValidationMessage) {
      setError(backendValidationMessage);
      Toast.error(backendValidationMessage);
      return;
    }

    setExportingSummary(true);
    try {
      const ownership = await getBackendOwnership(runtime);
      const client = createBackendAnalysisClient({ endpointUrl: config.backend.endpointUrl });
      const exported = await client.exportBaseSummary({
        ...ownership,
        resultId: currentResultId,
        scopeKey: currentScopeKey,
      });
      Toast.success(`摘要已导出到 Base：${exported.summaryTableId} / ${exported.topicTableId}`);
    } catch (cause) {
      const message = formatBackendAnalysisError(cause);
      setError(message);
      Toast.error(`导出摘要失败：${message}`);
    } finally {
      setExportingSummary(false);
    }
  }

  async function loadLatestBackendResult(
    client: BackendAnalysisClient,
    ownership: BackendOwnership,
    scopeKey: string,
    expectedResultId?: string,
    ignoreNotFound = false,
    filtersForResult: FilterState = configRef.current.filters,
  ): Promise<BackendResultSnapshot | null> {
    try {
      const snapshot = await fetchLatestBackendResult(client, ownership, scopeKey, expectedResultId, ignoreNotFound);
      if (!snapshot) {
        return null;
      }
      setCurrentScopeKey(scopeKey);
      setCurrentResultId(snapshot.resultId);
      setAnalysis(snapshot.analysis);
      setAnalysisFilters(withComputedRange(filtersForResult));
      setSelectedTopic(null);
      setEvidenceRecords([]);
      setEvidencePage(1);
      return snapshot;
    } catch (cause) {
      if (ignoreNotFound && cause instanceof BackendAnalysisError && cause.status === 404) {
        return null;
      }
      throw cause;
    }
  }

  async function fetchLatestBackendResult(
    client: BackendAnalysisClient,
    ownership: BackendOwnership,
    scopeKey: string,
    expectedResultId?: string,
    ignoreNotFound = false,
  ): Promise<BackendResultSnapshot | null> {
    try {
      const latest = await client.getLatestResult({ ...ownership, scopeKey });
      if (expectedResultId && latest.resultId !== expectedResultId) {
        throw new BackendAnalysisError('validate_response', '后端 latest result 与完成的 job resultId 不一致');
      }
      const result = assertRenderableAnalysisSummary(latest.summary);
      console.info(
        '__HOTEL_REVIEW_AI_FRONTEND_ANALYSIS_RESULT__',
        JSON.stringify({
          scopeKey,
          resultId: latest.resultId,
          totalReviews: result.overview.totalReviews,
          positiveTopics: result.positiveTopics.length,
          negativeTopics: result.negativeTopics.length,
          actionItems: result.actionItems.length,
        }),
      );
      return {
        analysis: result,
        resultId: latest.resultId,
      };
    } catch (cause) {
      if (ignoreNotFound && cause instanceof BackendAnalysisError && cause.status === 404) {
        return null;
      }
      throw cause;
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
    if (!currentResultId || !currentScopeKey || !config.backend.endpointUrl.trim()) {
      setEvidenceRecords([]);
      setEvidenceLoading(false);
      return;
    }

    setEvidenceLoading(true);
    try {
      const ownership = await getBackendOwnership(runtime);
      const client = createBackendAnalysisClient({ endpointUrl: config.backend.endpointUrl });
      const evidence = await client.getTopicEvidence({
        ...ownership,
        resultId: currentResultId,
        topicId: topic.mergeKey,
        scopeKey: currentScopeKey,
        page,
        pageSize: EVIDENCE_PAGE_SIZE,
      }) as TopicEvidencePage;
      if (evidenceRequestId.current !== requestId) {
        return;
      }
      setEvidenceRecords(topicEvidenceToReviewRecords(evidence));
    } catch (cause) {
      if (evidenceRequestId.current === requestId) {
        setError(formatBackendAnalysisError(cause));
      }
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
    logConfigDebug('handleSaveConfig:clicked', {
      state,
      config: summarizePluginConfig(config),
      fields: summarizeFieldMapping(config.source.fields),
    });
    const saveValidationMessage = getSaveValidationMessage(config);
    if (saveValidationMessage) {
      logConfigDebug('handleSaveConfig:validationBlocked', {
        state,
        message: saveValidationMessage,
        config: summarizePluginConfig(config),
        fields: summarizeFieldMapping(config.source.fields),
      });
      setError(saveValidationMessage);
      Toast.error(saveValidationMessage);
      return;
    }

    setSaving(true);
    const configToSave = { ...config, filters };
    const sourceRequestId = configSourceRequestId.current;
    logConfigDebug('handleSaveConfig:beforeSave', {
      state,
      sourceRequestId,
      config: summarizePluginConfig(configToSave),
      fields: summarizeFieldMapping(configToSave.source.fields),
    });
    try {
      await withSuppressedConfigReloads(async () => {
        await savePluginConfig(runtime, configToSave);
        logConfigDebug('handleSaveConfig:afterDashboardSaveBeforeBackend', {
          state,
          sourceRequestId,
          config: summarizePluginConfig(configToSave),
        });
        const ownership = await getBackendOwnership(runtime);
        const client = createBackendAnalysisClient({ endpointUrl: configToSave.backend.endpointUrl });
        const upserted = await upsertBackendAnalysisConfig(client, ownership, configToSave);
        const configWithBackend = withBackendConfigId(configToSave, upserted);
        logConfigDebug('handleSaveConfig:afterBackendUpsert', {
          state,
          sourceRequestId,
          upserted,
          config: summarizePluginConfig(configWithBackend),
        });
        configRef.current = configWithBackend;
        setConfig(configWithBackend);
        await savePluginConfig(runtime, configWithBackend);
        logConfigDebug('handleSaveConfig:afterBackendConfigSave', {
          state,
          sourceRequestId,
          config: summarizePluginConfig(configWithBackend),
        });
        await loadFilterOptionRecords(configWithBackend, sourceRequestId);
      });
      Toast.success('配置已保存');
    } catch (cause) {
      const message = formatBackendAnalysisError(cause);
      setError(message);
      Toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  async function loadFilterOptionRecords(pluginConfig: PluginConfig, requestId?: number) {
    const isCurrentRequest = () => isCurrentConfigSourceRequest(requestId);
    if (!pluginConfig.source.tableId.trim() || !hasFilterOptionRequiredFields(pluginConfig.source.fields)) {
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
    setCurrentScopeKey(null);
    setCurrentResultId(null);

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
          setOptionRecords(optionRecordsResult ?? []);
        } catch (cause) {
          if (isCurrentConfigSourceRequest(requestId)) {
            setError(cause instanceof Error ? cause.message : '读取字段配置失败');
          }
        }
      }
      return;
    }

    setError(null);
    setCategories([]);
    setDataRanges([]);
    setHostData(null);
    setOptionRecords([]);
    const resetConfig = {
      ...nextConfig,
      source: {
        ...nextConfig.source,
        dataRange: undefined,
        viewId: undefined,
      },
    };
    setConfig(resetConfig);

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
      const normalizedSource = normalizeSourceSelection(resetConfig.source, dataRangeList as IDataRange[]);
      const nextConfigWithFields = withSuggestedFieldMapping({ ...resetConfig, source: normalizedSource }, runtimeCategories);
      setConfig(nextConfigWithFields);
      setCategories(runtimeCategories);
      setDataRanges(dataRangeList as IDataRange[]);
      const previewData = await runtime.getPreviewData(buildDataConditions(nextConfigWithFields));
      if (!isCurrentConfigSourceRequest(requestId)) {
        return;
      }
      setHostData(previewData);
      await loadFilterOptionRecords(nextConfigWithFields, requestId);
    } catch (cause) {
      if (isCurrentConfigSourceRequest(requestId)) {
        setError(cause instanceof Error ? cause.message : '读取字段配置失败');
      }
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
  }

  function handlePeriodChange(periodType: PeriodType) {
    if (periodType === 'custom') {
      applyFilterSelection({ ...filters, periodType });
      return;
    }
    applyFilterSelection({ ...filters, periodType, ...getPeriodRange(periodType) });
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
      exportDisabled={!currentResultId || !currentScopeKey || analysisRunning || exportingSummary}
      exporting={exportingSummary}
      error={error}
      scopeWarning={scopeWarning}
      stale={stale}
      warmupStatus={null}
      showCacheDiagnostics={showCacheDiagnostics}
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
        disabled={loading || saving}
        onChange={handleConfigChange}
        onSave={handleSaveConfig}
      />
    </div>
  );
}

function isDemoMode(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const demo = new URLSearchParams(window.location.search).get('demo');
  return demo === '1' || demo === 'true';
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

async function getBackendOwnership(runtime: DashboardRuntime): Promise<BackendOwnership> {
  const [tenantKey, baseUserId, pluginInstanceId] = await Promise.all([
    runtime.getTenantKey(),
    runtime.getBaseUserId(),
    runtime.getInstanceId(),
  ]);
  if (!tenantKey.trim() || !baseUserId.trim() || !pluginInstanceId.trim()) {
    throw new BackendAnalysisError('resolve_identity', '无法获取后端分析所需的租户、用户或插件实例身份');
  }
  return { tenantKey, baseUserId, pluginInstanceId };
}

async function upsertBackendAnalysisConfig(
  client: BackendAnalysisClient,
  ownership: BackendOwnership,
  pluginConfig: PluginConfig,
) {
  return client.upsertConfig({
    ...ownership,
    baseToken: pluginConfig.backend.baseToken.trim(),
    model: pluginConfig.ai.model.trim(),
    source: {
      kind: 'postgres',
      sourceId: buildBackendSourceId(pluginConfig),
      upstreamSourceKind: 'feishu_base',
      tableId: pluginConfig.source.tableId.trim(),
      viewId: pluginConfig.source.viewId?.trim() || undefined,
      fieldMapping: pluginConfig.source.fields,
    },
    filters: withComputedRange(pluginConfig.filters),
    dashboardDataConditions: buildDataConditions(pluginConfig),
  });
}

function buildBackendSourceId(pluginConfig: PluginConfig): string {
  return [
    pluginConfig.backend.baseToken.trim(),
    pluginConfig.source.tableId.trim(),
  ].filter(Boolean).join(':');
}

function withBackendConfigId(
  pluginConfig: PluginConfig,
  upserted: { configId: string; configVersion: number },
): PluginConfig {
  return {
    ...pluginConfig,
    backend: {
      ...pluginConfig.backend,
      configId: upserted.configId,
      configVersion: upserted.configVersion,
    },
  };
}

function shouldPersistBackendConfigMetadata(
  pluginConfig: PluginConfig,
  upserted: { configId: string; configVersion: number },
): boolean {
  return pluginConfig.backend.configId !== upserted.configId;
}

async function waitForBackendJob(
  client: BackendAnalysisClient,
  ownership: BackendOwnership,
  initialJob: BackendAnalysisJob,
  shouldContinue: () => boolean = () => true,
): Promise<BackendAnalysisJob> {
  let job = initialJob;
  while (shouldContinue()) {
    if (COMPLETE_JOB_STATUSES.has(job.status)) {
      return job;
    }
    job = await client.getJob(job.jobId, ownership);
    if (COMPLETE_JOB_STATUSES.has(job.status)) {
      return job;
    }
    await sleep(1000);
  }
  throw new BackendAnalysisError(job.stage ?? 'load_config', '后端分析任务轮询已停止');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function topicEvidenceToReviewRecords(page: TopicEvidencePage): ReviewRecord[] {
  return page.evidence.map((item, index) => {
    const stableId = item.recordId || item.evidenceId || `evidence-${page.page}-${index}`;
    return {
      recordId: item.review?.recordId ?? stableId,
      reviewId: item.review?.reviewId ?? stableId,
      hotelName: item.review?.hotelName ?? '',
      score: item.review?.score ?? null,
      reviewDate: item.review?.reviewDate ?? null,
      checkInMonth: item.review?.checkInMonth ?? null,
      roomType: item.review?.roomType ?? null,
      hasReply: item.review?.hasReply ?? false,
      replyContent: item.review?.replyContent ?? null,
      content: item.review?.content ?? item.quote ?? '',
    };
  });
}

function formatBackendAnalysisError(cause: unknown): string {
  if (cause instanceof BackendAnalysisError) {
    return `${cause.stage} ${cause.message}`;
  }
  const error = cause as { stage?: unknown; message?: unknown };
  const message = typeof error.message === 'string' ? error.message : cause instanceof Error ? cause.message : String(cause);
  if (typeof error.stage === 'string' && error.stage) {
    return `${error.stage} ${message}`;
  }
  return message;
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

function getBackendValidationMessage(config: PluginConfig): string | null {
  if (!config.source.tableId.trim()) {
    return '请先选择数据表';
  }

  const missingFieldMessage = getMissingFieldMappingMessage(config.source.fields);
  if (missingFieldMessage) {
    return missingFieldMessage;
  }

  if (!config.backend.endpointUrl.trim()) {
    return '请先填写后端分析服务地址';
  }

  if (!config.backend.baseToken.trim()) {
    return '请先填写 Base Token';
  }

  if (!config.ai.model.trim()) {
    return '请先填写后端 Model';
  }

  return null;
}

function getSaveValidationMessage(config: PluginConfig): string | null {
  return getBackendValidationMessage(config);
}

function getViewIdFromDataRange(dataRange?: IDataRange): string | undefined {
  return dataRange?.type === SourceType.VIEW ? dataRange.viewId : undefined;
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

function isSameFilterState(left: FilterState, right: FilterState): boolean {
  return JSON.stringify(withComputedRange(left)) === JSON.stringify(withComputedRange(right));
}

function hasFilterOptionRequiredFields(fields: FieldMapping): boolean {
  return FILTER_OPTION_REQUIRED_FIELD_KEYS.every((key) => fields[key]?.trim());
}

export function isFreshDisplayHostDataRequest(
  currentInitRequestId: number,
  activeInitRequestId: number,
  currentSourceRequestId: number,
  activeSourceRequestId: number,
  currentHostDataGeneration: number,
  capturedHostDataGeneration: number,
  isMounted: boolean,
) {
  return (
    isMounted &&
    currentInitRequestId === activeInitRequestId &&
    currentSourceRequestId === activeSourceRequestId &&
    currentHostDataGeneration === capturedHostDataGeneration
  );
}
