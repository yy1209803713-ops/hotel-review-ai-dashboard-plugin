import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SourceType, type IDataCondition } from '@lark-base-open/js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './constants/defaults';
import type { DashboardRuntime, RuntimeCategory } from './runtime/sdk';
import type { RecordsPage } from './services/baseRecords';
import type { PluginConfig } from './types/config';

const runtimeRef = vi.hoisted(() => ({
  current: undefined as DashboardRuntime | undefined,
}));

const analysisPipelineMock = vi.hoisted(() => ({
  runAnalysis: vi.fn(),
}));

const backendAnalysisClientMock = vi.hoisted(() => ({
  createBackendAnalysisClient: vi.fn(),
  client: {
    upsertConfig: vi.fn(),
    resolveScope: vi.fn(),
    getCurrentJob: vi.fn(),
    createAnalysisJob: vi.fn(),
    getJob: vi.fn(),
    getLatestResult: vi.fn(),
    getTopicEvidence: vi.fn(),
    exportBaseSummary: vi.fn(),
  },
}));

vi.mock('./runtime/sdk', () => ({
  runtime: new Proxy(
    {},
    {
      get: (_target, prop: keyof DashboardRuntime) => runtimeRef.current?.[prop],
    },
  ),
}));

vi.mock('./services/analysisPipeline', () => ({
  runAnalysis: analysisPipelineMock.runAnalysis,
}));

vi.mock('./services/backendAnalysisClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/backendAnalysisClient')>();
  return {
    ...actual,
    createBackendAnalysisClient: backendAnalysisClientMock.createBackendAnalysisClient,
  };
});

vi.mock('@douyinfe/semi-ui', () => ({
  Banner: (props: { description?: React.ReactNode }) => <div role="alert">{props.description}</div>,
  Button: (props: { children: React.ReactNode; disabled?: boolean; loading?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={props.disabled || props.loading} onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Input: (props: {
    name?: string;
    value?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
  }) => (
    <input
      aria-label={props.name}
      name={props.name}
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value)}
    />
  ),
  InputNumber: (props: {
    value?: number | null;
    placeholder?: string;
    onChange?: (value: number | null) => void;
  }) => (
    <input
      type="number"
      placeholder={props.placeholder}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value === '' ? null : Number(event.target.value))}
    />
  ),
  Modal: (props: { visible?: boolean; children?: React.ReactNode }) => (props.visible ? <div>{props.children}</div> : null),
  Pagination: () => null,
  Select: (props: {
    value?: string;
    optionList: Array<{ label: string; value: string }>;
    onChange?: (value: string) => void;
  }) => (
    <select value={props.value} onChange={(event) => props.onChange?.(event.target.value)}>
      {props.optionList.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Spin: () => <div>loading</div>,
  Switch: (props: { checked?: boolean; onChange?: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.target.checked)}
    />
  ),
  Toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('lottie-web', () => ({
  default: {
    loadAnimation: vi.fn(() => ({
      addEventListener: vi.fn(),
      destroy: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  },
}));

const { default: App } = await import('./App');
const { Toast } = await import('@douyinfe/semi-ui');
const { getPeriodRange } = await import('./services/filtering');

describe('App initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeRef.current = undefined;
    analysisPipelineMock.runAnalysis.mockResolvedValue(createAnalysisResult(0));
    backendAnalysisClientMock.createBackendAnalysisClient.mockReturnValue(backendAnalysisClientMock.client);
    backendAnalysisClientMock.client.upsertConfig.mockResolvedValue({ configId: 'config-1', configVersion: 1 });
    backendAnalysisClientMock.client.resolveScope.mockResolvedValue({
      scopeKey: 'scope-initial',
      configVersion: 1,
      sourceVersion: {
        kind: 'feishu_base',
        sourceId: 'tbl1',
        version: 'v1',
        generatedAt: '2026-06-18T00:00:00.000Z',
        recordCount: 1,
        contentHash: 'hash-1',
      },
    });
    backendAnalysisClientMock.client.getCurrentJob.mockResolvedValue(null);
    backendAnalysisClientMock.client.createAnalysisJob.mockResolvedValue({
      jobId: 'job-1',
      scopeKey: 'scope-create',
      status: 'queued',
    });
    backendAnalysisClientMock.client.getJob.mockResolvedValue({
      jobId: 'job-1',
      scopeKey: 'scope-actual',
      status: 'success',
      resultId: 'result-1',
    });
    backendAnalysisClientMock.client.getLatestResult.mockResolvedValue({
      resultId: 'result-1',
      summary: createAnalysisResult(1),
    });
    backendAnalysisClientMock.client.getTopicEvidence.mockResolvedValue({
      evidence: [],
      page: 1,
      pageSize: 20,
      total: 0,
    });
    backendAnalysisClientMock.client.exportBaseSummary.mockResolvedValue({
      resultId: 'result-1',
      summaryTableId: 'tbl-summary',
      topicTableId: 'tbl-topic',
      summaryRecordIds: ['rec-summary'],
      topicRecordIds: ['rec-topic'],
      exportedAt: '2026-06-18T12:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('initializes Create state from the first table without calling saved Dashboard config', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Create',
      getConfig: vi.fn(async () => {
        throw new Error('Create state must not call getConfig');
      }),
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '第一张表' },
        { tableId: 'table-b', tableName: '第二张表' },
      ]),
      getTableDataRange: vi.fn(async () => [
        { type: SourceType.ALL },
        { type: SourceType.VIEW, viewId: 'view-a', viewName: '有效评论视图' },
      ]),
      getCategories: vi.fn(async () => aliasCategories),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('第一张表')).toBeInTheDocument());

    expect(runtime.getConfig).not.toHaveBeenCalled();
    expect(runtime.getTableDataRange).toHaveBeenCalledWith('table-a');
    expect(runtime.getCategories).toHaveBeenCalledWith('table-a');
    expect(runtime.getPreviewData).toHaveBeenCalledWith([
      {
        tableId: 'table-a',
        dataRange: { type: SourceType.ALL },
        groups: [{ fieldId: 'fld_id' }],
        series: 'COUNTA',
      },
    ]);
    expect(screen.getByText('插件配置')).toBeInTheDocument();
    expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument();
  });

  it('loads preview data from saved Dashboard config in Config state', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [
          {
            tableId: 'tbl1',
            dataRange: viewDataRange('view-a', '有效评论'),
            groups: [{ fieldId: 'fld_id' }],
            series: 'COUNTA' as const,
          },
        ],
        customConfig: withSource({
          tableId: 'tbl1',
          viewId: 'view-a',
          dataRange: viewDataRange('view-a', '有效评论'),
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn(async () => [
        { type: SourceType.ALL },
        viewDataRange('view-a', '有效评论'),
      ]),
      getCategories: vi.fn(async () => optionCategories('a')),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getPreviewData).toHaveBeenCalledTimes(1));

    expect(runtime.getPreviewData).toHaveBeenCalledWith([
      {
        tableId: 'tbl1',
        dataRange: { type: SourceType.VIEW, viewId: 'view-a', viewName: '有效评论' },
        groups: [{ fieldId: 'fld_a_review_id' }],
        series: 'COUNTA',
      },
    ]);
    expect(runtime.getData).not.toHaveBeenCalled();
  });

  it('does not request preview data when Config state has no source table', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: '' }),
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getTableList).toHaveBeenCalledTimes(1));
    expect(runtime.getPreviewData).not.toHaveBeenCalled();
  });

  it('normalizes a stale saved view before save when the host has no range options', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [
          {
            tableId: 'tbl1',
            dataRange: viewDataRange('view-stale', '旧视图'),
            groups: [{ fieldId: 'fld_a_review_id' }],
            series: 'COUNTA' as const,
          },
        ],
        customConfig: withSource({
          tableId: 'tbl1',
          viewId: 'view-stale',
          dataRange: viewDataRange('view-stale', '旧视图'),
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn(async () => []),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument());
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalled());
    expect(runtime.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        dataConditions: [
          expect.objectContaining({
            tableId: 'tbl1',
            dataRange: { type: SourceType.ALL },
          }),
        ],
        customConfig: expect.objectContaining({
          source: expect.objectContaining({
            dataRange: { type: SourceType.ALL },
            viewId: undefined,
          }),
        }),
      }),
    );
  });

  it('normalizes a stale saved view to all data even when host ranges list another view first', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [
          {
            tableId: 'tbl1',
            dataRange: viewDataRange('view-stale', '旧视图'),
            groups: [{ fieldId: 'fld_a_review_id' }],
            series: 'COUNTA' as const,
          },
        ],
        customConfig: withSource({
          tableId: 'tbl1',
          viewId: 'view-stale',
          dataRange: viewDataRange('view-stale', '旧视图'),
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn(async () => [viewDataRange('view-a', '有效评论'), { type: SourceType.ALL }]),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument());
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalled());
    expect(runtime.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        dataConditions: [expect.objectContaining({ dataRange: { type: SourceType.ALL } })],
        customConfig: expect.objectContaining({
          source: expect.objectContaining({
            dataRange: { type: SourceType.ALL },
            viewId: undefined,
          }),
        }),
      }),
    );
  });

  it('blocks saving stale config while saved view normalization is still loading', async () => {
    const rangeLoad = deferred<unknown[]>();
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [
          {
            tableId: 'tbl1',
            dataRange: viewDataRange('view-stale', '旧视图'),
            groups: [{ fieldId: 'fld_a_review_id' }],
            series: 'COUNTA' as const,
          },
        ],
        customConfig: withSource({
          tableId: 'tbl1',
          viewId: 'view-stale',
          dataRange: viewDataRange('view-stale', '旧视图'),
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn(async () => rangeLoad.promise),
      getCategories: vi.fn(async () => optionCategories('a')),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('保存配置')).toBeDisabled());
    fireEvent.click(screen.getByText('保存配置'));
    expect(runtime.saveConfig).not.toHaveBeenCalled();

    await act(async () => {
      rangeLoad.resolve([]);
      await rangeLoad.promise;
    });
    await waitFor(() => expect(screen.getByText('保存配置')).not.toBeDisabled());
  });

  it('refreshes preview data when the data range changes on the same table', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableList: vi.fn(async () => [{ tableId: 'table-a', tableName: '表 A' }]),
      getTableDataRange: vi.fn(async () => [
        { type: SourceType.ALL },
        viewDataRange('view-a', '表 A 视图'),
      ]),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getPreviewData).toHaveBeenCalledTimes(1));
    vi.mocked(runtime.getPreviewData).mockClear();

    fireEvent.change(screen.getByDisplayValue('全部数据'), { target: { value: 'VIEW:view-a' } });

    await waitFor(() =>
      expect(runtime.getPreviewData).toHaveBeenCalledWith([
        {
          tableId: 'table-a',
          dataRange: { type: SourceType.VIEW, viewId: 'view-a', viewName: '表 A 视图' },
          groups: [{ fieldId: 'fld_a_review_id' }],
          series: 'COUNTA',
        },
      ]),
    );
  });

  it('does not expose browser warmup controls from the Config panel', async () => {
    const savedConfig = withSource({
      tableId: 'tbl1',
      fields: optionFieldMapping('a'),
    });
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...savedConfig,
          warmup: {
            endpointUrl: 'https://backend.example.com/api/hotel-review-ai/warmup',
            secret: 'warmup-secret',
          },
        },
      })),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('插件配置')).toBeInTheDocument());
    expect(screen.queryByText('缓存预热')).not.toBeInTheDocument();
    expect(screen.queryByText('初始化缓存')).not.toBeInTheDocument();
    expect(screen.queryByText('立即预热')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('hotel-review-ai-warmup-endpoint-url')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('hotel-review-ai-warmup-secret')).not.toBeInTheDocument();
  });

  it('persists dashboard filter selections when they change', async () => {
    const savedConfig = withSource({
      tableId: 'tbl1',
      fields: optionFieldMapping('a'),
    });
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: savedConfig,
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [
          optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00'),
          optionRecordWithReviewId('a', 'review-b', '表 B 酒店', '2026-06-01 00:00:00'),
        ],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('表 B 酒店')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('全部酒店'), { target: { value: '表 B 酒店' } });

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalled());
    expect(runtime.saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          filters: expect.objectContaining({
            hotelName: '表 B 酒店',
          }),
          source: expect.objectContaining({
            tableId: 'tbl1',
          }),
        }),
      }),
    );
  });

  it('shows date range inputs for preset periods', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    expect(await screen.findByPlaceholderText('开始日期')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('结束日期')).toBeInTheDocument();
  });

  it('fills and persists preset date ranges when selecting week', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;
    const expectedRange = getPeriodRange('week');

    render(<App />);

    await screen.findByPlaceholderText('开始日期');
    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalled());
    vi.mocked(runtime.saveConfig).mockClear();

    fireEvent.click(screen.getByText('本周'));

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledTimes(1));
    expect(screen.getByPlaceholderText('开始日期')).toHaveValue(expectedRange.startDate);
    expect(screen.getByPlaceholderText('结束日期')).toHaveValue(expectedRange.endDate);
    expect(runtime.saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          filters: expect.objectContaining({
            periodType: 'week',
            startDate: expectedRange.startDate,
            endDate: expectedRange.endDate,
          }),
        }),
      }),
    );
  });

  it('does not show the AI background update state when a filter config save triggers reload', async () => {
    let configChangeHandler: ((config: unknown) => void) | undefined;
    const savedConfig = {
      ...withSource({
        tableId: 'tbl1',
        fields: optionFieldMapping('a'),
      }),
      ai: {
        ...DEFAULT_CONFIG.ai,
        apiKey: 'sk-test',
      },
      analysisCache: {
        result: createAnalysisResult(1),
        scopeSnapshot: {
          filters: DEFAULT_CONFIG.filters,
          fields: optionFieldMapping('a'),
          model: DEFAULT_CONFIG.ai.model,
          analysisCopyVersion: 'v1.2-conversational-copy',
          totalReviews: 1,
          firstRecordId: 'rec-review-a',
          lastRecordId: 'rec-review-a',
          source: {
            tableId: 'tbl1',
            dataRange: undefined,
            hostDataSignal: 'host-visible-review-ids:review-a',
          },
        },
        sourceSnapshot: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }).source,
        model: DEFAULT_CONFIG.ai.model,
        generatedAt: '2026-06-17T00:00:00.000Z',
      },
    };
    const reloadGate = deferred<void>();
    let configReadCount = 0;
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => {
        configReadCount += 1;
        if (configReadCount > 1) {
          await reloadGate.promise;
        }
        return {
          dataConditions: [],
          customConfig: savedConfig,
        };
      }),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      onConfigChange: vi.fn((handler) => {
        configChangeHandler = handler as (config: unknown) => void;
        return () => undefined;
      }),
      readRecordsPage: vi.fn(async () => ({
        records: [
          optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00'),
        ],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText(/上次分析：/)).toBeInTheDocument());
    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalled());
    vi.mocked(runtime.saveConfig).mockClear();

    fireEvent.click(screen.getByText('本周'));
    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledTimes(1));
    act(() => {
      configChangeHandler?.({ dataConditions: [], customConfig: savedConfig });
    });

    await waitFor(() => expect(runtime.getConfig).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('正在后台更新 AI 聚合分析，当前结果会保留到新结果生成完成。')).not.toBeInTheDocument();
    expect(screen.getByText('更新分析')).not.toHaveAttribute('loading');

    await act(async () => {
      reloadGate.resolve();
      await reloadGate.promise;
    });
  });

  it('renders last analysis time in Beijing local time', async () => {
    backendAnalysisClientMock.client.getLatestResult.mockResolvedValueOnce({
      resultId: 'result-beijing',
      summary: {
        ...createAnalysisResult(1),
        generatedAt: '2026-06-17T00:00:00.000Z',
      },
    });
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText(/上次分析：/)).toBeInTheDocument());
    expect(screen.getByText('上次分析：2026-06-17 08:00')).toBeInTheDocument();
  });

  it('keeps the latest same-table preview when data range switches resolve out of order', async () => {
    const viewAPreview = deferred<unknown[][]>();
    const viewBPreview = deferred<unknown[][]>();
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableList: vi.fn(async () => [{ tableId: 'table-a', tableName: '表 A' }]),
      getTableDataRange: vi.fn(async () => [
        { type: SourceType.ALL },
        viewDataRange('view-a', '表 A 视图 A'),
        viewDataRange('view-b', '表 A 视图 B'),
      ]),
      getCategories: vi.fn(async () => optionCategories('a')),
      getPreviewData: vi.fn((conditions: IDataCondition[]) => {
        const dataRange = conditions[0]?.dataRange as { type: SourceType; viewId?: string } | undefined;
        if (dataRange?.type === SourceType.VIEW && dataRange.viewId === 'view-a') {
          return viewAPreview.promise;
        }
        if (dataRange?.type === SourceType.VIEW && dataRange.viewId === 'view-b') {
          return viewBPreview.promise;
        }
        return Promise.resolve([[{ value: 'ALL' }]]);
      }),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('全部数据'), { target: { value: 'VIEW:view-a' } });
    fireEvent.change(screen.getByDisplayValue('表 A 视图 A'), { target: { value: 'VIEW:view-b' } });

    await act(async () => {
      viewBPreview.resolve([[{ value: 'VIEW_B' }]]);
      await viewBPreview.promise;
    });

    await act(async () => {
      viewAPreview.resolve([[{ value: 'VIEW_A' }]]);
      await viewAPreview.promise;
    });

    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledTimes(1));
    expect(runtime.saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dataConditions: [
          expect.objectContaining({
            dataRange: viewDataRange('view-b', '表 A 视图 B'),
          }),
        ],
        customConfig: expect.objectContaining({
          source: expect.objectContaining({
            dataRange: viewDataRange('view-b', '表 A 视图 B'),
            viewId: 'view-b',
          }),
        }),
      }),
    );
  });

  it('refreshes preview data when a field mapping changes on the same table', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableList: vi.fn(async () => [{ tableId: 'table-a', tableName: '表 A' }]),
      getTableDataRange: vi.fn(async () => [{ type: SourceType.ALL }]),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getPreviewData).toHaveBeenCalledTimes(1));
    vi.mocked(runtime.getPreviewData).mockClear();

    fireEvent.change(screen.getByDisplayValue('评论ID'), { target: { value: 'fld_a_content' } });

    await waitFor(() =>
      expect(runtime.getPreviewData).toHaveBeenCalledWith([
        {
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          groups: [{ fieldId: 'fld_a_content' }],
          series: 'COUNTA',
        },
      ]),
    );
  });

  it('refreshes option records when same-table data range changes', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableList: vi.fn(async () => [{ tableId: 'table-a', tableName: '表 A' }]),
      getTableDataRange: vi.fn(async () => [
        { type: SourceType.ALL },
        viewDataRange('view-a', '表 A 视图'),
      ]),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async (_tableId, params) => ({
        records:
          params.viewId === 'view-a'
            ? [optionRecord('a', '视图酒店', '2026-06-01 00:00:00')]
            : [optionRecord('a', '全部数据酒店', '2026-05-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('全部数据酒店')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('全部数据'), { target: { value: 'VIEW:view-a' } });

    await waitFor(() => expect(screen.getByText('视图酒店')).toBeInTheDocument());
    expect(screen.queryByText('全部数据酒店')).not.toBeInTheDocument();
  });

  it('refreshes option records when same-table reviewId mapping changes', async () => {
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: { type: SourceType.ALL },
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableList: vi.fn(async () => [{ tableId: 'table-a', tableName: '表 A' }]),
      getTableDataRange: vi.fn(async () => [{ type: SourceType.ALL }]),
      getCategories: vi.fn(async () => [
        ...optionCategories('a'),
        { fieldId: 'fld_a_review_id_alt', fieldName: '评论ID备份', fieldType: 'text' },
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [
          {
            recordId: 'rec-a',
            fields: {
              fld_a_review_id_alt: 'review-alt',
              fld_a_content: '新映射评论',
              fld_a_hotel: '新映射酒店',
              fld_a_score: 5,
              fld_a_review_date: '2026-06-01 00:00:00',
              fld_a_checkin: '2026-06-01 00:00:00',
              fld_a_reply: '',
              fld_a_room: '大床房',
            },
          },
        ],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('新映射酒店')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('评论ID'), { target: { value: 'fld_a_review_id_alt' } });

    await waitFor(() => expect(runtime.readRecordsPage).toHaveBeenLastCalledWith('table-a', expect.objectContaining({ viewId: undefined })));
    expect(screen.getByText('新映射酒店')).toBeInTheDocument();
  });

  it('loads host data in View state and hides the config panel', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withAiKey(
          withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
        ),
      })),
      getData: vi.fn(async () => [[{ value: '1001', text: '1001', groupKey: '1001' }]]),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getData).toHaveBeenCalledTimes(1));

    expect(runtime.getPreviewData).not.toHaveBeenCalled();
    expect(screen.queryByText('插件配置')).not.toBeInTheDocument();
  });

  it('updates host data from Dashboard data change events and marks rendered', async () => {
    let dataChangeHandler: ((data: unknown[][]) => void) | undefined;
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withAiKey(
          withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
        ),
      })),
      getData: vi.fn(async () => [[{ value: 'initial', text: 'initial', groupKey: 'initial' }]]),
      onDataChange: vi.fn((handler) => {
        dataChangeHandler = handler;
        return () => undefined;
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.onDataChange).toHaveBeenCalledTimes(1));
    vi.mocked(runtime.setRendered).mockClear();

    act(() => {
      dataChangeHandler?.([[{ value: 'changed', text: 'changed', groupKey: 'changed' }]]);
    });

    expect(runtime.setRendered).toHaveBeenCalledTimes(1);
  });

  it('reloads saved config after Dashboard config change events outside Create state', async () => {
    let configChangeHandler: ((config: unknown) => void) | undefined;
    const runtime = fakeRuntime({
      getState: () => 'Config',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getCategories: vi.fn(async () => optionCategories('a')),
      onConfigChange: vi.fn((handler) => {
        configChangeHandler = handler as (config: unknown) => void;
        return () => undefined;
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getConfig).toHaveBeenCalledTimes(1));
    act(() => {
      configChangeHandler?.({ dataConditions: [], customConfig: DEFAULT_CONFIG });
    });
    await waitFor(() => expect(runtime.getConfig).toHaveBeenCalledTimes(2));
  });

  it('prefills missing field mapping from loaded table categories before saving', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'tbl1' }),
      })),
      getCategories: vi.fn(async () => aliasCategories),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('tbl1'));
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledTimes(1));
    expect(runtime.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        customConfig: expect.objectContaining({
          source: expect.objectContaining({
            fields: {
              reviewId: 'fld_id',
              content: 'fld_content',
              hotelName: 'fld_hotel',
              score: 'fld_score',
              reviewDate: 'fld_review_date',
              checkInMonth: 'fld_checkin',
              replyContent: 'fld_reply',
              roomType: 'fld_room',
            },
          }),
        }),
      }),
    );
  });

  it('blocks saving when required field mapping is missing', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'tbl1' }),
      })),
      getCategories: vi.fn(async () => []),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('tbl1'));
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(screen.getAllByText(/请先完成字段映射/).length).toBeGreaterThan(0));
    expect(runtime.saveConfig).not.toHaveBeenCalled();
  });

  it('blocks saving when no source table is selected', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: '',
          fields: optionFieldMapping('a'),
        }),
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getTableList).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(screen.getAllByText('请先选择数据表').length).toBeGreaterThan(0));
    expect(runtime.saveConfig).not.toHaveBeenCalled();
  });

  it('blocks saving when backend endpoint, Base Token, or model is blank', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getCategories: vi.fn(async () => optionCategories('a')),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('tbl1'));
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(runtime.saveConfig).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByLabelText('hotel-review-ai-backend-endpoint-url'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(screen.getAllByText('请先填写后端分析服务地址').length).toBeGreaterThan(0));
    expect(runtime.saveConfig).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByLabelText('hotel-review-ai-backend-endpoint-url'), { target: { value: 'https://backend.example.com' } });
    fireEvent.change(screen.getByLabelText('hotel-review-ai-base-token'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(screen.getAllByText('请先填写 Base Token').length).toBeGreaterThan(0));
    expect(runtime.saveConfig).toHaveBeenCalledTimes(2);

    fireEvent.change(screen.getByLabelText('hotel-review-ai-base-token'), { target: { value: 'base-token' } });
    fireEvent.change(screen.getByLabelText('hotel-review-ai-model'), { target: { value: '' } });
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(screen.getAllByText('请先填写后端 Model').length).toBeGreaterThan(0));
    expect(runtime.saveConfig).toHaveBeenCalledTimes(2);
  });

  it('starts backend-owned analysis without requiring API Key or running the browser pipeline', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getData).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByText('更新分析')[0]);

    await waitFor(() => expect(backendAnalysisClientMock.client.createAnalysisJob).toHaveBeenCalledTimes(1));
    expect(backendAnalysisClientMock.client.upsertConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantKey: 'fixture-tenant',
        baseUserId: 'fixture-user',
        pluginInstanceId: 'fixture-instance',
        baseToken: 'base-token',
        source: expect.objectContaining({
          kind: 'feishu_base',
          tableId: 'tbl1',
        }),
      }),
    );
    expect(backendAnalysisClientMock.client.createAnalysisJob).toHaveBeenCalledWith({
      tenantKey: 'fixture-tenant',
      baseUserId: 'fixture-user',
      pluginInstanceId: 'fixture-instance',
      configId: 'config-1',
      forceRefresh: true,
    });
    expect(analysisPipelineMock.runAnalysis).not.toHaveBeenCalled();
    expect(runtime.readRecordsPage).toHaveBeenCalledTimes(1);
    expect(Toast.error).not.toHaveBeenCalledWith('请先填写并保存 API Key');
  });

  it('does not rewrite Dashboard config during View restore when backend config metadata is unchanged', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
            configVersion: 1,
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(backendAnalysisClientMock.client.resolveScope).toHaveBeenCalledTimes(1));
    expect(runtime.saveConfig).not.toHaveBeenCalled();
  });

  it('exports the current backend result summary through the backend Base export API', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
            configVersion: 1,
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('导出摘要')).toBeInTheDocument());
    fireEvent.click(screen.getByText('导出摘要'));

    await waitFor(() => expect(backendAnalysisClientMock.client.exportBaseSummary).toHaveBeenCalledTimes(1));
    expect(backendAnalysisClientMock.client.exportBaseSummary).toHaveBeenCalledWith({
      tenantKey: 'fixture-tenant',
      baseUserId: 'fixture-user',
      pluginInstanceId: 'fixture-instance',
      resultId: 'result-1',
      scopeKey: 'scope-initial',
    });
    expect(Toast.success).toHaveBeenCalledWith('摘要已导出到 Base：tbl-summary / tbl-topic');
    expect(runtime.addTable).not.toHaveBeenCalled();
    expect(runtime.addRecords).not.toHaveBeenCalled();
  });

  it('surfaces backend export errors with stage and message', async () => {
    backendAnalysisClientMock.client.exportBaseSummary.mockRejectedValueOnce({
      stage: 'export_summary',
      message: 'LARK_BASE_AUTH_CODE is required for base summary export',
    });
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
            configVersion: 1,
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('导出摘要')).toBeInTheDocument());
    fireEvent.click(screen.getByText('导出摘要'));

    await waitFor(() => expect(screen.getByText('export_summary LARK_BASE_AUTH_CODE is required for base summary export')).toBeInTheDocument());
    expect(Toast.error).toHaveBeenCalledWith('导出摘要失败：export_summary LARK_BASE_AUTH_CODE is required for base summary export');
  });

  it('uses ownership query for job polling and latest result after backend updates scopeKey', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    backendAnalysisClientMock.client.createAnalysisJob.mockResolvedValueOnce({
      jobId: 'job-1',
      scopeKey: 'scope-preflight',
      status: 'running',
    });
    backendAnalysisClientMock.client.getJob.mockResolvedValueOnce({
      jobId: 'job-1',
      scopeKey: 'scope-actual',
      status: 'success',
      resultId: 'result-1',
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getData).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByText('更新分析')[0]);

    await waitFor(() => expect(backendAnalysisClientMock.client.getLatestResult).toHaveBeenCalledTimes(1));
    expect(backendAnalysisClientMock.client.getJob).toHaveBeenCalledWith('job-1', {
      tenantKey: 'fixture-tenant',
      baseUserId: 'fixture-user',
      pluginInstanceId: 'fixture-instance',
    });
    expect(backendAnalysisClientMock.client.getLatestResult).toHaveBeenCalledWith({
      tenantKey: 'fixture-tenant',
      baseUserId: 'fixture-user',
      pluginInstanceId: 'fixture-instance',
      scopeKey: 'scope-actual',
    });
  });

  it('keeps polling backend jobs beyond one minute instead of surfacing a local timeout', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    backendAnalysisClientMock.client.getJob.mockResolvedValue({
      jobId: 'job-1',
      scopeKey: 'scope-create',
      status: 'running',
      stage: 'extract_evidence',
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getData).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('更新分析')[0]).not.toBeDisabled());
    vi.useFakeTimers();
    fireEvent.click(screen.getAllByText('更新分析')[0]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(backendAnalysisClientMock.client.createAnalysisJob).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(screen.queryByText('extract_evidence 后端分析任务超时未完成')).not.toBeInTheDocument();
    expect(Toast.error).not.toHaveBeenCalledWith('更新分析失败：extract_evidence 后端分析任务超时未完成');
    expect(backendAnalysisClientMock.client.getJob.mock.calls.length).toBeGreaterThan(60);
  });

  it('loads the backend result when a long-running job eventually succeeds', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: {
          ...withSource({
            tableId: 'tbl1',
            fields: optionFieldMapping('a'),
          }),
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
          },
        },
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    const runningJob = {
      jobId: 'job-1',
      scopeKey: 'scope-create',
      status: 'running' as const,
      stage: 'extract_evidence' as const,
    };
    backendAnalysisClientMock.client.getJob
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce(runningJob)
      .mockResolvedValueOnce({
        jobId: 'job-1',
        scopeKey: 'scope-finished',
        status: 'success',
        resultId: 'result-long',
      });
    backendAnalysisClientMock.client.getLatestResult.mockResolvedValueOnce({
      resultId: 'result-long',
      summary: createAnalysisResult(3),
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getData).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('更新分析')[0]).not.toBeDisabled());
    vi.useFakeTimers();
    fireEvent.click(screen.getAllByText('更新分析')[0]);
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await Promise.resolve();
    });

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(backendAnalysisClientMock.client.getLatestResult).toHaveBeenCalledWith({
      tenantKey: 'fixture-tenant',
      baseUserId: 'fixture-user',
      pluginInstanceId: 'fixture-instance',
      scopeKey: 'scope-finished',
    });
  });

  it('surfaces failed restored jobs without loading stale latest result', async () => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    backendAnalysisClientMock.client.getCurrentJob.mockResolvedValueOnce({
      jobId: 'job-restored',
      scopeKey: 'scope-running',
      status: 'running',
      stage: 'read_reviews',
    });
    backendAnalysisClientMock.client.getJob.mockResolvedValueOnce({
      jobId: 'job-restored',
      scopeKey: 'scope-running',
      status: 'failed',
      stage: 'read_reviews',
      errorStage: 'read_reviews',
      errorMessage: 'Base read denied',
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('read_reviews Base read denied')).toBeInTheDocument());
    expect(backendAnalysisClientMock.client.getLatestResult).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', 'read_reviews', 'Base read denied', 'read_reviews Base read denied'],
    ['canceled', 'validate_request', 'analysis job canceled', 'validate_request analysis job canceled'],
  ] as const)('surfaces terminal %s current jobs without polling or loading stale latest result', async (
    status,
    errorStage,
    errorMessage,
    renderedMessage,
  ) => {
    const runtime = fakeRuntime({
      getState: () => 'View',
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getData: vi.fn(async () => [
        [{ value: '评论ID', text: '评论ID', groupKey: null }],
        [{ value: 'review-a', text: 'review-a', groupKey: 'review-a' }],
      ]),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecordWithReviewId('a', 'review-a', '表 A 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });
    backendAnalysisClientMock.client.getCurrentJob.mockResolvedValueOnce({
      jobId: `job-terminal-${status}`,
      scopeKey: 'scope-initial',
      status,
      stage: errorStage,
      errorStage,
      errorMessage,
    });
    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText(renderedMessage)).toBeInTheDocument());
    expect(backendAnalysisClientMock.client.getJob).not.toHaveBeenCalled();
    expect(backendAnalysisClientMock.client.getLatestResult).not.toHaveBeenCalled();
  });

  it('shows the real Dashboard save error when saving fails', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getCategories: vi.fn(async () => optionCategories('a')),
      saveConfig: vi.fn(async () => {
        throw new Error('host save exploded');
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('tbl1'));
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(screen.getAllByText('host save exploded').length).toBeGreaterThan(0));
    expect(Toast.error).toHaveBeenCalledWith('host save exploded');
  });

  it('surfaces filter option record read errors after saving config', async () => {
    let readCalls = 0;
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: optionFieldMapping('a'),
        }),
      })),
      getCategories: vi.fn(async () => optionCategories('a')),
      readRecordsPage: vi.fn(async () => {
        readCalls += 1;
        if (readCalls > 1) {
          throw new Error('筛选选项读取失败');
        }
        return {
          records: [optionRecord('a', '表 A 酒店', '2026-06-01 00:00:00')],
          hasMore: false,
        };
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('表 A 酒店')).toBeInTheDocument());
    fireEvent.click(screen.getByText('保存配置'));

    await waitFor(() => expect(screen.getByText('筛选选项读取失败')).toBeInTheDocument());
    expect(Toast.error).toHaveBeenCalledWith('筛选选项读取失败');
    expect(Toast.success).not.toHaveBeenCalledWith('配置已保存');
  });

  it('blocks analysis when required field mapping is missing', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'tbl1' }),
      })),
      getCategories: vi.fn(async () => []),
      readRecordsPage: vi.fn(async () => ({ records: [], hasMore: false })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('tbl1'));
    fireEvent.click(screen.getAllByText('更新分析')[0]);

    await waitFor(() => expect(screen.getAllByText(/请先完成字段映射/).length).toBeGreaterThan(0));
    expect(runtime.readRecordsPage).not.toHaveBeenCalled();
  });

  it('keeps the latest selected table when category requests resolve out of order', async () => {
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'table-a' }),
      })),
      getCategories: vi.fn((tableId: string) => {
        if (tableId === 'table-b') {
          return new Promise<RuntimeCategory[]>((resolve) => {
            setTimeout(() => resolve([{ fieldId: 'fld_b_content', fieldName: '评论内容', fieldType: 'text' }]), 20);
          });
        }
        if (tableId === 'table-c') {
          return Promise.resolve([{ fieldId: 'fld_c_content', fieldName: '评论内容', fieldType: 'text' }]);
        }
        return Promise.resolve([]);
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('table-a'));
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });
    fireEvent.change(screen.getByDisplayValue('表 B'), { target: { value: 'table-c' } });

    await waitFor(() => expect(screen.getByDisplayValue('表 C')).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(screen.getByDisplayValue('表 C')).toBeInTheDocument();
    expect(document.querySelector('option[value="fld_b_content"]')).not.toBeInTheDocument();
    expect(document.querySelector('option[value="fld_c_content"]')).toBeInTheDocument();
  });

  it('ignores stale initial categories after the user switches tables', async () => {
    const initialCategories = deferred<RuntimeCategory[]>();
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'table-a' }),
      })),
      getCategories: vi.fn((tableId: string) => {
        if (tableId === 'table-a') {
          return initialCategories.promise;
        }
        if (tableId === 'table-c') {
          return Promise.resolve([{ fieldId: 'fld_c_content', fieldName: '评论内容', fieldType: 'text' }]);
        }
        return Promise.resolve([]);
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('表 A')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-c' } });
    await waitFor(() => expect(screen.getByDisplayValue('表 C')).toBeInTheDocument());

    await act(async () => {
      initialCategories.resolve([{ fieldId: 'fld_a_content', fieldName: '评论内容', fieldType: 'text' }]);
      await initialCategories.promise;
    });

    expect(screen.getByDisplayValue('表 C')).toBeInTheDocument();
    expect(document.querySelector('option[value="fld_a_content"]')).not.toBeInTheDocument();
    expect(document.querySelector('option[value="fld_c_content"]')).toBeInTheDocument();
  });

  it('loads filter options when fields unrelated to options are missing', async () => {
    const runtime = fakeRuntime({
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'tbl1',
          fields: {
            reviewId: 'fld_id',
            content: 'fld_content',
            hotelName: 'fld_hotel',
            score: '',
            reviewDate: '',
            checkInMonth: 'fld_checkin',
            replyContent: '',
            roomType: '',
          },
        }),
      })),
      getCategories: vi.fn(async () => []),
      readRecordsPage: vi.fn(async () => ({
        records: [
          {
            recordId: 'rec1',
            fields: {
              fld_id: '1001',
              fld_content: '位置很好',
              fld_hotel: '昆明中维翠湖宾馆',
              fld_checkin: '2026-05-01 00:00:00',
            },
          },
        ],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.readRecordsPage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('昆明中维翠湖宾馆')).toBeInTheDocument());
    expect(screen.getByText('2026-05')).toBeInTheDocument();
  });

  it('ignores stale option records when an older table read finishes later', async () => {
    const tableBPage = deferred<RecordsPage>();
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'table-a' }),
      })),
      getCategories: vi.fn(async (tableId: string) => {
        if (tableId === 'table-b') {
          return optionCategories('b');
        }
        if (tableId === 'table-c') {
          return optionCategories('c');
        }
        return [];
      }),
      readRecordsPage: vi.fn((tableId: string) => {
        if (tableId === 'table-b') {
          return tableBPage.promise;
        }
        return Promise.resolve({
          records: [optionRecord('c', '表 C 酒店', '2026-06-01 00:00:00')],
          hasMore: false,
        });
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('table-a'));
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });
    await waitFor(() => expect(runtime.readRecordsPage).toHaveBeenCalledWith('table-b', expect.any(Object)));
    fireEvent.change(screen.getByDisplayValue('表 B'), { target: { value: 'table-c' } });

    await waitFor(() => expect(screen.getByText('表 C 酒店')).toBeInTheDocument());
    await act(async () => {
      tableBPage.resolve({
        records: [optionRecord('b', '表 B 酒店', '2026-05-01 00:00:00')],
        hasMore: false,
      });
      await tableBPage.promise;
    });

    expect(screen.getByText('表 C 酒店')).toBeInTheDocument();
    expect(screen.queryByText('表 B 酒店')).not.toBeInTheDocument();
  });

  it('ignores stale category errors after a newer table selection succeeds', async () => {
    const tableBError = deferred<RuntimeCategory[]>();
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'table-a' }),
      })),
      getCategories: vi.fn((tableId: string) => {
        if (tableId === 'table-b') {
          return tableBError.promise;
        }
        if (tableId === 'table-c') {
          return Promise.resolve(optionCategories('c'));
        }
        return Promise.resolve([]);
      }),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('c', '表 C 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getCategories).toHaveBeenCalledWith('table-a'));
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });
    fireEvent.change(screen.getByDisplayValue('表 B'), { target: { value: 'table-c' } });
    await waitFor(() => expect(screen.getByDisplayValue('表 C')).toBeInTheDocument());

    await act(async () => {
      tableBError.reject(new Error('表 B 字段读取失败'));
      await tableBError.promise.catch(() => undefined);
    });

    expect(screen.queryByText('表 B 字段读取失败')).not.toBeInTheDocument();
    expect(screen.queryByText('读取字段配置失败')).not.toBeInTheDocument();
  });

  it('ignores stale option records from a save refresh after switching tables', async () => {
    const saveRefreshPage = deferred<RecordsPage>();
    let tableACalls = 0;
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          fields: optionFieldMapping('a'),
        }),
      })),
      getCategories: vi.fn(async (tableId: string) => {
        if (tableId === 'table-a') {
          return optionCategories('a');
        }
        if (tableId === 'table-c') {
          return optionCategories('c');
        }
        return [];
      }),
      readRecordsPage: vi.fn((tableId: string) => {
        if (tableId === 'table-a') {
          tableACalls += 1;
          if (tableACalls === 1) {
            return Promise.resolve({
              records: [optionRecord('a', '表 A 酒店', '2026-04-01 00:00:00')],
              hasMore: false,
            });
          }
          return saveRefreshPage.promise;
        }
        return Promise.resolve({
          records: [optionRecord('c', '表 C 酒店', '2026-06-01 00:00:00')],
          hasMore: false,
        });
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByText('表 A 酒店')).toBeInTheDocument());
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(tableACalls).toBe(2));
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-c' } });

    await waitFor(() => expect(screen.getByText('表 C 酒店')).toBeInTheDocument());
    await act(async () => {
      saveRefreshPage.resolve({
        records: [optionRecord('a', '表 A 保存后酒店', '2026-05-01 00:00:00')],
        hasMore: false,
      });
      await saveRefreshPage.promise;
    });

    expect(screen.getByText('表 C 酒店')).toBeInTheDocument();
    expect(screen.queryByText('表 A 保存后酒店')).not.toBeInTheDocument();
  });

  it('clears existing source errors after selecting a valid table or an empty table', async () => {
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
        { tableId: 'table-c', tableName: '表 C' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({ tableId: 'table-a' }),
      })),
      getCategories: vi.fn((tableId: string) => {
        if (tableId === 'table-b') {
          return Promise.reject(new Error('表 B 字段读取失败'));
        }
        if (tableId === 'table-c') {
          return Promise.resolve(optionCategories('c'));
        }
        return Promise.resolve([]);
      }),
      readRecordsPage: vi.fn(async () => ({
        records: [optionRecord('c', '表 C 酒店', '2026-06-01 00:00:00')],
        hasMore: false,
      })),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('表 A')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });
    await waitFor(() => expect(screen.getByText('表 B 字段读取失败')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('表 B'), { target: { value: 'table-c' } });
    await waitFor(() => expect(screen.getByDisplayValue('表 C')).toBeInTheDocument());
    expect(screen.queryByText('表 B 字段读取失败')).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('表 C'), { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('表 B 字段读取失败')).not.toBeInTheDocument());
  });

  it('refreshes data ranges and preview data after switching source tables', async () => {
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: viewDataRange('view-a', '表 A 视图'),
          viewId: 'view-a',
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn(async (tableId: string) => {
        if (tableId === 'table-a') {
          return [{ type: SourceType.ALL }, viewDataRange('view-a', '表 A 视图')];
        }
        return [{ type: SourceType.ALL }, viewDataRange('view-b', '表 B 视图')];
      }),
      getCategories: vi.fn(async (tableId: string) => (tableId === 'table-a' ? optionCategories('a') : optionCategories('b'))),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('表 A 视图')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });

    await waitFor(() => expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument());
    expect(screen.queryByText('表 A 视图')).not.toBeInTheDocument();
    expect(screen.getByText('表 B 视图')).toBeInTheDocument();
    expect(runtime.getTableDataRange).toHaveBeenCalledWith('table-b');
    expect(runtime.getPreviewData).toHaveBeenLastCalledWith([
      {
        tableId: 'table-b',
        dataRange: { type: SourceType.ALL },
        groups: [{ fieldId: 'fld_b_review_id' }],
        series: 'COUNTA',
      },
    ]);
  });

  it('clears stale data range options immediately when switching source tables', async () => {
    const tableBRanges = deferred<unknown[]>();
    const runtime = fakeRuntime({
      getTableList: vi.fn(async () => [
        { tableId: 'table-a', tableName: '表 A' },
        { tableId: 'table-b', tableName: '表 B' },
      ]),
      getConfig: vi.fn(async () => ({
        dataConditions: [],
        customConfig: withSource({
          tableId: 'table-a',
          dataRange: viewDataRange('view-a', '表 A 视图'),
          viewId: 'view-a',
          fields: optionFieldMapping('a'),
        }),
      })),
      getTableDataRange: vi.fn((tableId: string) => {
        if (tableId === 'table-a') {
          return Promise.resolve([{ type: SourceType.ALL }, viewDataRange('view-a', '表 A 视图')]);
        }
        return tableBRanges.promise;
      }),
      getCategories: vi.fn(async (tableId: string) => (tableId === 'table-a' ? optionCategories('a') : optionCategories('b'))),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(screen.getByDisplayValue('表 A 视图')).toBeInTheDocument());
    fireEvent.change(screen.getByDisplayValue('表 A'), { target: { value: 'table-b' } });

    expect(screen.getByDisplayValue('全部数据')).toBeInTheDocument();
    expect(screen.queryByText('表 A 视图')).not.toBeInTheDocument();

    await act(async () => {
      tableBRanges.resolve([{ type: SourceType.ALL }, viewDataRange('view-b', '表 B 视图')]);
      await tableBRanges.promise;
    });
    await waitFor(() => expect(screen.getByText('表 B 视图')).toBeInTheDocument());
  });
});

function fakeRuntime(overrides: Partial<DashboardRuntime> = {}): DashboardRuntime {
  return {
    isFixture: false,
    getState: () => 'Config',
    getTheme: vi.fn(async () => ({
      theme: 'LIGHT' as const,
      chartBgColor: '#ffffff',
      labelColorTokenList: ['#111827', '#6b7280'],
      themePalette: ['#2563eb', '#16a34a', '#dc2626'],
    })),
    onThemeChange: vi.fn(() => () => undefined),
    getConfig: vi.fn(async () => ({ dataConditions: [], customConfig: DEFAULT_CONFIG })),
    getPreviewData: vi.fn(async () => []),
    getData: vi.fn(async () => []),
    saveConfig: vi.fn(async () => true),
    onDataChange: vi.fn(() => () => undefined),
    onConfigChange: vi.fn(() => () => undefined),
    getTableList: vi.fn(async () => [{ tableId: 'tbl1', tableName: '酒店评论' }]),
    getFieldMetaList: vi.fn(async () => []),
    getTableDataRange: vi.fn(async () => [{ type: SourceType.ALL }]),
    getCategories: vi.fn(async () => []),
    readRecordsPage: vi.fn(),
    readRecordsByIds: vi.fn(),
    canEditBase: vi.fn(),
    addTable: vi.fn(async () => ({ tableId: 'cache-table' })),
    addRecords: vi.fn(async (_tableId, records) => records.map((_, index) => `write-${index}`)),
    setRecords: vi.fn(async (_tableId, records) => records.map((record) => ({ recordId: record.recordId }))),
    setRendered: vi.fn(async () => true),
    getTenantKey: vi.fn(async () => 'fixture-tenant'),
    getBaseUserId: vi.fn(async () => 'fixture-user'),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
    ...overrides,
  };
}

function withSource(source: Partial<PluginConfig['source']>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
    backend: {
      ...DEFAULT_CONFIG.backend,
      endpointUrl: 'https://backend.example.com',
      baseToken: 'base-token',
    },
    source: {
      ...DEFAULT_CONFIG.source,
      ...source,
      fields: {
        ...DEFAULT_CONFIG.source.fields,
        ...source.fields,
      },
    },
  };
}

function withAiKey(config: PluginConfig): PluginConfig {
  return {
    ...config,
    ai: {
      ...config.ai,
      apiKey: 'sk-test',
    },
  };
}

const aliasCategories: RuntimeCategory[] = [
  { fieldId: 'fld_id', fieldName: '评论ID', fieldType: 'number' },
  { fieldId: 'fld_content', fieldName: 'comment', fieldType: 'text' },
  { fieldId: 'fld_hotel', fieldName: '酒店', fieldType: 'text' },
  { fieldId: 'fld_score', fieldName: 'rating', fieldType: 'number' },
  { fieldId: 'fld_review_date', fieldName: '评论日期', fieldType: 'text' },
  { fieldId: 'fld_checkin', fieldName: '入住月份', fieldType: 'text' },
  { fieldId: 'fld_reply', fieldName: '回复内容', fieldType: 'text' },
  { fieldId: 'fld_room', fieldName: 'room_type', fieldType: 'text' },
];

function optionCategories(prefix: string): RuntimeCategory[] {
  return [
    { fieldId: `fld_${prefix}_review_id`, fieldName: '评论ID', fieldType: 'text' },
    { fieldId: `fld_${prefix}_content`, fieldName: '评论内容', fieldType: 'text' },
    { fieldId: `fld_${prefix}_hotel`, fieldName: '酒店名称', fieldType: 'text' },
    { fieldId: `fld_${prefix}_score`, fieldName: '评分', fieldType: 'number' },
    { fieldId: `fld_${prefix}_review_date`, fieldName: '评论日期', fieldType: 'text' },
    { fieldId: `fld_${prefix}_checkin`, fieldName: '入住月份', fieldType: 'text' },
    { fieldId: `fld_${prefix}_reply`, fieldName: '回复内容', fieldType: 'text' },
    { fieldId: `fld_${prefix}_room`, fieldName: '房型', fieldType: 'text' },
  ];
}

function optionRecord(prefix: string, hotelName: string, checkInMonth: string) {
  return optionRecordWithReviewId(prefix, `review-${prefix}`, hotelName, checkInMonth);
}

function optionRecordWithReviewId(prefix: string, reviewId: string, hotelName: string, checkInMonth: string) {
  return {
    recordId: `rec-${reviewId}`,
    fields: {
      [`fld_${prefix}_review_id`]: reviewId,
      [`fld_${prefix}_content`]: `${hotelName} 评论`,
      [`fld_${prefix}_hotel`]: hotelName,
      [`fld_${prefix}_score`]: 5,
      [`fld_${prefix}_review_date`]: '2026-06-01 00:00:00',
      [`fld_${prefix}_checkin`]: checkInMonth,
      [`fld_${prefix}_reply`]: '',
      [`fld_${prefix}_room`]: '大床房',
    },
  };
}

function optionFieldMapping(prefix: string): PluginConfig['source']['fields'] {
  return {
    ...DEFAULT_CONFIG.source.fields,
    reviewId: `fld_${prefix}_review_id`,
    content: `fld_${prefix}_content`,
    hotelName: `fld_${prefix}_hotel`,
    score: `fld_${prefix}_score`,
    reviewDate: `fld_${prefix}_review_date`,
    checkInMonth: `fld_${prefix}_checkin`,
    replyContent: `fld_${prefix}_reply`,
    roomType: `fld_${prefix}_room`,
  };
}

function viewDataRange(viewId: string, viewName: string) {
  return { type: SourceType.VIEW, viewId, viewName } as const;
}

function createAnalysisResult(totalReviews: number) {
  return {
    analysisId: 'analysis-1',
    generatedAt: '2026-06-16T00:00:00.000Z',
    model: DEFAULT_CONFIG.ai.model,
    status: 'complete' as const,
    scope: {
      hotelName: 'all',
      periodType: 'month',
      startDate: '',
      endDate: '',
    },
    overview: {
      totalReviews,
      positiveReviews: 0,
      negativeOrRiskReviews: 0,
      mixedReviews: 0,
      neutralReviews: 0,
      averageScore: null,
      replyRate: 0,
    },
    positiveTopics: [],
    negativeTopics: [],
    actionItems: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
