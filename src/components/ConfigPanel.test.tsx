import { fireEvent, render, screen } from '@testing-library/react';
import { SourceType } from '@lark-base-open/js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../constants/defaults';
import type { PluginConfig } from '../types/config';
import { ConfigPanel } from './ConfigPanel';

vi.mock('@douyinfe/semi-ui', () => ({
  Banner: () => null,
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
});
