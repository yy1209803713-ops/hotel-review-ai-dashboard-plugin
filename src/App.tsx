import { useEffect, useMemo, useRef, useState } from 'react';
import { Toast } from '@douyinfe/semi-ui';
import { ConfigPanel } from './components/ConfigPanel';
import { DashboardShell } from './components/DashboardShell';
import { DEFAULT_CONFIG } from './constants/defaults';
import { getPeriodRange } from './services/filtering';
import { normalizeReviewRecord, readReviewRecords } from './services/baseRecords';
import { filterReviews } from './services/filtering';
import { runAnalysis } from './services/analysisPipeline';
import { ANALYSIS_COPY_VERSION, buildScopeSnapshot, isCacheStale, type ScopeSnapshot } from './services/stats';
import { loadPluginConfig, saveAnalysisCache, savePluginConfig } from './services/cacheStore';
import { writeAnalysisResult } from './services/writeback';
import { formatAiClientError, testAiConnection } from './services/aiClient';
import { runtime, type RuntimeCategory, type RuntimeTable } from './runtime/sdk';
import type { AnalysisCache, FilterState, PeriodType, PluginConfig } from './types/config';
import type { AnalysisResult, ReviewRecord, TopicSummary } from './types/analysis';

const EVIDENCE_PAGE_SIZE = 10;

export default function App() {
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentScope, setCurrentScope] = useState<ScopeSnapshot | null>(null);
  const [optionRecords, setOptionRecords] = useState<ReviewRecord[]>([]);
  const evidenceRequestId = useRef(0);

  const isConfigMode = state === 'Create' || state === 'Config';

  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const pluginConfig = await loadPluginConfig(runtime);
        if (!mounted) {
          return;
        }
        setConfig(pluginConfig);
        setFilters(withComputedRange(pluginConfig.filters));
        setAnalysis(pluginConfig.analysisCache?.result ?? null);
        const [tableList, categoryList] = await Promise.all([
          runtime.getTableList(),
          runtime.getCategories(pluginConfig.source.tableId),
        ]);
        if (!mounted) {
          return;
        }
        setTables(tableList);
        setCategories(categoryList as RuntimeCategory[]);
        readRecordsForConfig(pluginConfig)
          .then((records) => {
            if (mounted) {
              setOptionRecords(records);
            }
          })
          .catch(() => undefined);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '初始化失败');
      } finally {
        setLoading(false);
        runtime.setRendered();
      }
    }

    init();
    return () => {
      mounted = false;
    };
  }, []);

  const stale = useMemo(() => {
    const cacheScope = config.analysisCache?.scopeSnapshot as ScopeSnapshot | undefined;
    if (!analysis) {
      return false;
    }
    if (!cacheScope) {
      return true;
    }
    return isCacheStale(cacheScope, currentScope ?? cacheScope);
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
    setLoading(true);
    setSelectedTopic(null);
    setEvidenceRecords([]);
    setEvidencePage(1);
    Toast.info('开始读取评论并更新 AI 聚合分析');

    try {
      const records = await measureAnalysisStep(timingRows, '读表', () => readRecordsForConfig(config), (result) => ({
        records: result.length,
        detail: config.source.viewId ? `view=${config.source.viewId}` : `table=${config.source.tableId}`,
      }));
      setOptionRecords(records);
      const filtered = measureAnalysisSyncStep(timingRows, '过滤', () => filterReviews(records, filters), (result) => ({
        records: result.length,
        detail: `原始 ${records.length} 条`,
      }));

      if (!filtered.length) {
        setAnalysis(null);
        setError('当前筛选范围内没有可分析评论');
        return;
      }

      const scope = buildScopeSnapshot(filtered, filters, config.source.fields, config.ai.model);
      const result = await measureAnalysisStep(timingRows, 'AI 总耗时', () => runAnalysis({
        records: filtered,
        config: config.ai,
        filters,
        fields: config.source.fields,
        onBatchTiming: (timing) => {
          timingRows.push({
            step: `AI 批次 ${timing.batchIndex + 1}/${timing.batchCount}`,
            durationMs: timing.durationMs,
            status: timing.status,
            records: timing.recordCount,
          });
        },
      }), (result) => ({
        records: result.overview.totalReviews,
        detail: `model=${result.model}`,
      }));
      const cache: AnalysisCache = {
        result,
        scopeSnapshot: scope,
        sourceSnapshot: config.source,
        model: config.ai.model,
        generatedAt: result.generatedAt,
      };

      await measureAnalysisStep(timingRows, '保存缓存', () => saveAnalysisCache(runtime, cache));
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
      Toast.success('AI 聚合分析已更新');
    } catch (cause) {
      const message = formatAiClientError(cause);
      setError(message);
      Toast.error(`更新分析失败：${message}`);
    } finally {
      publishAnalysisTimingReport(timingRows, getNowMs() - runStartedAt);
      setLoading(false);
      runtime.setRendered();
    }
  }

  async function handleTestConnection() {
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
    if (!pageRecordIds.length) {
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
    setSaving(true);
    try {
      await savePluginConfig(runtime, { ...config, filters });
      loadFilterOptionRecords({ ...config, filters }).catch(() => undefined);
      Toast.success('配置已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存配置失败');
    } finally {
      setSaving(false);
    }
  }

  async function loadFilterOptionRecords(pluginConfig: PluginConfig) {
    const records = await readRecordsForConfig(pluginConfig);
    setOptionRecords(records);
  }

  function handleFilterChange(nextFilters: FilterState) {
    setFilters(nextFilters);
    if (analysis) {
      setCurrentScope({
        filters: nextFilters,
        fields: config.source.fields,
        model: config.ai.model,
        analysisCopyVersion: ANALYSIS_COPY_VERSION,
        totalReviews: config.analysisCache?.result.overview.totalReviews ?? 0,
        firstRecordId: '',
        lastRecordId: '',
      });
    }
  }

  function handlePeriodChange(periodType: PeriodType) {
    if (periodType === 'custom') {
      setFilters((current) => ({ ...current, periodType }));
      return;
    }
    setFilters((current) => ({ ...current, periodType, ...getPeriodRange(periodType) }));
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
      error={error}
      stale={stale}
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
        saving={saving}
        testingConnection={testingConnection}
        onChange={setConfig}
        onSave={handleSaveConfig}
        onTestConnection={handleTestConnection}
      />
    </div>
  );
}

function readRecordsForConfig(pluginConfig: PluginConfig): Promise<ReviewRecord[]> {
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

  if (hasGroup) {
    console.groupEnd();
  }
}

function getNowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value);
}
