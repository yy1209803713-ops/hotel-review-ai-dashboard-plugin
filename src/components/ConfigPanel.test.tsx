import { fireEvent, render, screen } from '@testing-library/react';
import { SourceType } from '@lark-base-open/js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import type { PluginConfig } from '../types/config';
import { ConfigPanel } from './ConfigPanel';

vi.mock('@douyinfe/semi-ui', () => ({
  Banner: (props: { description?: React.ReactNode }) => <div role="alert">{props.description}</div>,
  Button: (props: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {props.children}
    </button>
  ),
  Input: (props: { value?: string; onChange?: (value: string) => void }) => (
    <input value={props.value ?? ''} onChange={(event) => props.onChange?.(event.target.value)} />
  ),
  InputNumber: (props: { value?: number | null; onChange?: (value: number) => void }) => (
    <input
      type="number"
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(Number(event.target.value))}
    />
  ),
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
  Switch: (props: { checked?: boolean; onChange?: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      checked={props.checked ?? false}
      onChange={(event) => props.onChange?.(event.target.checked)}
    />
  ),
}));

describe('ConfigPanel', () => {
  it('clears stale data range and view id when changing the selected table', () => {
    const onChange = vi.fn();
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      source: {
        ...DEFAULT_CONFIG.source,
        tableId: 'old-table',
        viewId: 'old-view',
        dataRange: { type: SourceType.VIEW, viewId: 'old-view', viewName: '旧视图' },
      },
    };

    render(
      <ConfigPanel
        config={config}
        tables={[
          { tableId: 'old-table', tableName: '旧数据表' },
          { tableId: 'new-table', tableName: '新数据表' },
        ]}
        categories={[]}
        dataRanges={[{ type: SourceType.ALL }]}
        saving={false}
        testingConnection={false}
        onChange={onChange}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('旧数据表'), { target: { value: 'new-table' } });

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      source: {
        ...config.source,
        tableId: 'new-table',
        viewId: undefined,
        dataRange: undefined,
        fields: DEFAULT_CONFIG.source.fields,
      },
    });
  });

  it('emits data range and view id updates when selecting a view range', () => {
    const onChange = vi.fn();
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      source: {
        ...DEFAULT_CONFIG.source,
        tableId: 'table-1',
        dataRange: { type: SourceType.ALL },
      },
    };

    render(
      <ConfigPanel
        config={config}
        tables={[{ tableId: 'table-1', tableName: '酒店评论' }]}
        categories={[]}
        dataRanges={[
          { type: SourceType.ALL },
          { type: SourceType.VIEW, viewId: 'view-a', viewName: '有效评论' },
        ]}
        saving={false}
        testingConnection={false}
        onChange={onChange}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('全部数据'), { target: { value: 'VIEW:view-a' } });

    expect(onChange).toHaveBeenCalledWith({
      ...config,
      source: {
        ...config.source,
        dataRange: { type: SourceType.VIEW, viewId: 'view-a', viewName: '有效评论' },
        viewId: 'view-a',
      },
    });
  });

  it('does not fall back to an old view range when no data ranges are available', () => {
    render(
      <ConfigPanel
        config={{
          ...DEFAULT_CONFIG,
          source: {
            ...DEFAULT_CONFIG.source,
            tableId: 'table-a',
            viewId: 'old-view',
            dataRange: { type: SourceType.VIEW, viewId: 'old-view', viewName: '旧视图' },
          },
        }}
        tables={[{ tableId: 'table-a', tableName: '表 A' }]}
        categories={[]}
        dataRanges={[]}
        saving={false}
        testingConnection={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(screen.queryByDisplayValue('旧视图')).not.toBeInTheDocument();
    expect(screen.getAllByRole('combobox')[1]).toHaveValue('ALL');
  });

  it('shows a missing field mapping list', () => {
    const config: PluginConfig = {
      ...DEFAULT_CONFIG,
      source: {
        ...DEFAULT_CONFIG.source,
        tableId: 'table-1',
        fields: {
          ...DEFAULT_CONFIG.source.fields,
          reviewId: 'fld_id',
          content: 'fld_content',
          hotelName: 'fld_hotel',
        },
      },
    };

    render(
      <ConfigPanel
        config={config}
        tables={[{ tableId: 'table-1', tableName: '酒店评论' }]}
        categories={[]}
        dataRanges={[{ type: SourceType.ALL }]}
        saving={false}
        testingConnection={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        onTestConnection={vi.fn()}
      />,
    );

    expect(screen.getByText('缺少字段映射：评分、评论日期、入住日期、回复内容、房型')).toBeInTheDocument();
  });
});
