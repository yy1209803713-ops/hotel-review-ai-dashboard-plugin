import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './constants/defaults';
import type { DashboardRuntime, RuntimeCategory } from './runtime/sdk';
import type { PluginConfig } from './types/config';

const runtimeRef = vi.hoisted(() => ({
  current: undefined as DashboardRuntime | undefined,
}));

vi.mock('./runtime/sdk', () => ({
  runtime: new Proxy(
    {},
    {
      get: (_target, prop: keyof DashboardRuntime) => runtimeRef.current?.[prop],
    },
  ),
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

describe('App initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeRef.current = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('loads table list without calling table-bound SDK methods before a table is selected', async () => {
    const runtime = fakeRuntime({
      getCategories: vi.fn(async () => {
        throw new Error('empty tableId rejected');
      }),
      readRecordsPage: vi.fn(async () => {
        throw new Error('readRecordsPage should not run without tableId');
      }),
    });

    runtimeRef.current = runtime;

    render(<App />);

    await waitFor(() => expect(runtime.getTableList).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(runtime.setRendered).toHaveBeenCalled());

    expect(runtime.getCategories).not.toHaveBeenCalled();
    expect(runtime.readRecordsPage).not.toHaveBeenCalled();
    expect(screen.getByText('插件配置')).toBeInTheDocument();
    expect(screen.queryByText('empty tableId rejected')).not.toBeInTheDocument();
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
});

function fakeRuntime(overrides: Partial<DashboardRuntime> = {}): DashboardRuntime {
  return {
    isFixture: false,
    getState: () => 'Create',
    getTheme: vi.fn(),
    onThemeChange: vi.fn(() => () => undefined),
    getConfig: vi.fn(async () => ({ dataConditions: [], customConfig: DEFAULT_CONFIG })),
    saveConfig: vi.fn(async () => true),
    onConfigChange: vi.fn(() => () => undefined),
    getTableList: vi.fn(async () => [{ tableId: 'tbl1', tableName: '酒店评论' }]),
    getFieldMetaList: vi.fn(),
    getTableDataRange: vi.fn(),
    getCategories: vi.fn(async () => []),
    readRecordsPage: vi.fn(),
    readRecordsByIds: vi.fn(),
    canEditBase: vi.fn(),
    addTable: vi.fn(),
    addRecords: vi.fn(),
    setRendered: vi.fn(async () => true),
    getInstanceId: vi.fn(async () => 'fixture-instance'),
    ...overrides,
  };
}

function withSource(source: Partial<PluginConfig['source']>): PluginConfig {
  return {
    ...DEFAULT_CONFIG,
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
