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
  Input: (props: { name?: string; value?: string; onChange?: (value: string) => void }) => (
    <input
      aria-label={props.name}
      name={props.name}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value)}
    />
  ),
  InputNumber: (props: { value?: number | null; min?: number; max?: number; onChange?: (value: number) => void }) => (
    <input
      type="number"
      min={props.min}
      max={props.max}
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
        onChange={onChange}
        onSave={vi.fn()}
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
        onChange={onChange}
        onSave={vi.fn()}
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
        onChange={vi.fn()}
        onSave={vi.fn()}
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
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText('缺少字段映射：评分、评论日期、入住日期、回复内容、房型')).toBeInTheDocument();
  });

  it('does not expose browser-owned AI runtime knobs or warmup controls', () => {
    render(
      <ConfigPanel
        config={DEFAULT_CONFIG}
        tables={[{ tableId: 'table-1', tableName: '酒店评论' }]}
        categories={[]}
        dataRanges={[{ type: SourceType.ALL }]}
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryByText('Temperature')).not.toBeInTheDocument();
    expect(screen.queryByText('Top N')).not.toBeInTheDocument();
    expect(screen.queryByText('批次大小')).not.toBeInTheDocument();
    expect(screen.queryByText('并发数')).not.toBeInTheDocument();
    expect(screen.queryByText('请求超时秒数')).not.toBeInTheDocument();
    expect(screen.queryByText('缓存预热')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('hotel-review-ai-warmup-endpoint-url')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('hotel-review-ai-warmup-secret')).not.toBeInTheDocument();
    expect(screen.queryByText('初始化缓存')).not.toBeInTheDocument();
    expect(screen.queryByText('立即预热')).not.toBeInTheDocument();
  });

  it('shows backend config fields instead of browser AI key controls', () => {
    const onChange = vi.fn();
    render(
      <ConfigPanel
        config={{
          ...DEFAULT_CONFIG,
          backend: {
            endpointUrl: 'https://backend.example.com',
            baseToken: 'base-token',
            configId: 'config-1',
            configVersion: 1,
          },
        }}
        tables={[{ tableId: 'table-1', tableName: '酒店评论' }]}
        categories={[]}
        dataRanges={[{ type: SourceType.ALL }]}
        saving={false}
        onChange={onChange}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText('后端分析服务')).toBeInTheDocument();
    expect(screen.getByLabelText('hotel-review-ai-backend-endpoint-url')).toHaveValue('https://backend.example.com');
    expect(screen.getByLabelText('hotel-review-ai-base-token')).toHaveValue('base-token');
    expect(screen.getByLabelText('hotel-review-ai-model')).toHaveValue(DEFAULT_CONFIG.ai.model);
    expect(screen.queryByLabelText('hotel-review-ai-api-key')).not.toBeInTheDocument();
    expect(screen.queryByText('测试连接')).not.toBeInTheDocument();
    expect(screen.queryByText('AI API')).not.toBeInTheDocument();
    expect(screen.queryByText('写回 Base 聚合结果')).not.toBeInTheDocument();
    expect(screen.queryByText('首次写回会创建「AI分析批次」和「AI主题汇总」两张表。')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('hotel-review-ai-model'), { target: { value: 'qwen-max' } });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      ai: expect.objectContaining({ model: 'qwen-max' }),
    }));
  });
});
