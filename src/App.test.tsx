import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from './constants/defaults';
import type { DashboardRuntime } from './runtime/sdk';

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
