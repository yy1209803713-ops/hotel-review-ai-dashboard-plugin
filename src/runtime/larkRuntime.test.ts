import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMock = vi.hoisted(() => ({
  getTableById: vi.fn(),
  getRecordsByIds: vi.fn(),
}));

vi.mock('@lark-base-open/js-sdk', () => ({
  bitable: {
    base: {
      getTableById: sdkMock.getTableById,
      getTableList: vi.fn(),
      getPermission: vi.fn(),
      addTable: vi.fn(),
    },
  },
  bridge: {
    getInstanceId: vi.fn(async () => 'test-instance'),
  },
  dashboard: {
    state: 'View',
    getTheme: vi.fn(),
    onThemeChange: vi.fn(),
    getConfig: vi.fn(),
    getPreviewData: vi.fn(),
    getData: vi.fn(),
    saveConfig: vi.fn(),
    onDataChange: vi.fn(),
    onConfigChange: vi.fn(),
    getTableDataRange: vi.fn(),
    getCategories: vi.fn(),
    setRendered: vi.fn(),
  },
  DashboardState: {
    Create: 'Create',
  },
  FieldType: {
    Number: 2,
    SingleSelect: 3,
    Text: 1,
  },
  OperationType: {
    Editable: 'Editable',
  },
  PermissionEntity: {
    Base: 'Base',
  },
  SourceType: {
    ALL: 'ALL',
    VIEW: 'VIEW',
  },
}));

const { createLarkRuntime } = await import('./sdk');

describe('createLarkRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getTableById.mockResolvedValue({
      getRecordsByIds: sdkMock.getRecordsByIds,
    });
  });

  it('preserves requested recordIds when the SDK returns record values without ids', async () => {
    sdkMock.getRecordsByIds.mockResolvedValueOnce([
      { fields: { fld_content: '第一条评论' } },
      { fields: { fld_content: '第二条评论' } },
    ]);

    const runtime = createLarkRuntime();
    const records = await runtime.readRecordsByIds('tbl1', ['rec1', 'rec2']);

    expect(records).toEqual([
      { recordId: 'rec1', fields: { fld_content: '第一条评论' } },
      { recordId: 'rec2', fields: { fld_content: '第二条评论' } },
    ]);
  });
});
