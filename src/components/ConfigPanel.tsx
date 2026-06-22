import { Banner, Button, Input, Select } from '@douyinfe/semi-ui';
import { SourceType, type IDataRange } from '@lark-base-open/js-sdk';
import { DEFAULT_CONFIG, FIELD_LABELS } from '../constants/defaults';
import type { RuntimeCategory, RuntimeTable } from '../runtime/sdk';
import { getMissingRequiredFields } from '../services/fieldMapping';
import type { PluginConfig } from '../types/config';

export function ConfigPanel(props: {
  config: PluginConfig;
  tables: RuntimeTable[];
  categories: RuntimeCategory[];
  dataRanges: IDataRange[];
  saving: boolean;
  disabled?: boolean;
  onChange: (config: PluginConfig) => void;
  onSave: () => void;
}) {
  const update = (patch: Partial<PluginConfig>) => props.onChange({ ...props.config, ...patch });
  const updateAi = (patch: Partial<PluginConfig['ai']>) => update({ ai: { ...props.config.ai, ...patch } });
  const updateSource = (patch: Partial<PluginConfig['source']>) => update({ source: { ...props.config.source, ...patch } });
  const updateFields = (key: keyof PluginConfig['source']['fields'], value: string) =>
    updateSource({ fields: { ...props.config.source.fields, [key]: value } });
  const missingFields = getMissingRequiredFields(props.config.source.fields);
  const dataRangeOptions = buildDataRangeOptions(props.dataRanges);
  const currentDataRangeValue = getDataRangeValue(props.config.source.dataRange);
  const selectedDataRangeValue =
    currentDataRangeValue && dataRangeOptions.some((option) => option.value === currentDataRangeValue)
      ? currentDataRangeValue
      : dataRangeOptions[0]?.value ?? '';

  return (
    <aside className="config-panel">
      <div className="config-scroll">
        <h2>插件配置</h2>
        <section className="config-section">
          <div className="config-section-head">
            <h3>数据源</h3>
          </div>
          <Field label="数据表">
            <ConfigSelect
              value={props.config.source.tableId}
              optionList={props.tables.map((table) => ({ label: table.tableName, value: table.tableId }))}
              onChange={(value) =>
                updateSource({
                  tableId: String(value),
                  viewId: undefined,
                  dataRange: undefined,
                  fields: { ...DEFAULT_CONFIG.source.fields },
                })
              }
            />
          </Field>
          <Field label="数据范围">
            <ConfigSelect
              value={selectedDataRangeValue}
              optionList={dataRangeOptions}
              onChange={(value) => {
                const dataRange = dataRangeOptions.find((option) => option.value === value)?.dataRange;
                updateSource({
                  dataRange,
                  viewId: getViewIdFromDataRange(dataRange),
                });
              }}
            />
          </Field>
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <h3>字段映射</h3>
          </div>
          {missingFields.length ? (
            <Banner
              type="warning"
              closeIcon={null}
              description={`缺少字段映射：${missingFields.map((key) => FIELD_LABELS[key]).join('、')}`}
            />
          ) : null}
          {fieldRows.map((row) => (
            <Field label={row.label} key={row.key}>
              <ConfigSelect
                value={props.config.source.fields[row.key]}
                optionList={props.categories.map((field) => ({ label: field.fieldName, value: field.fieldId }))}
                onChange={(value) => updateFields(row.key, String(value))}
              />
            </Field>
          ))}
        </section>

        <section className="config-section">
          <div className="config-section-head">
            <h3>后端分析服务</h3>
          </div>
          <Banner
            type="warning"
            closeIcon={null}
            description="分析任务由后端拥有，前端只保存后端地址和 Base token。"
          />
          <Field label="Backend Endpoint">
            <Input
              name="hotel-review-ai-backend-endpoint-url"
              autoComplete="off"
              spellCheck={false}
              value={props.config.backend.endpointUrl}
              onChange={(value) => update({ backend: { ...props.config.backend, endpointUrl: value } })}
            />
          </Field>
          <Field label="Base Token">
            <Input
              name="hotel-review-ai-base-token"
              autoComplete="new-password"
              mode="password"
              spellCheck={false}
              value={props.config.backend.baseToken}
              onChange={(value) => update({ backend: { ...props.config.backend, baseToken: value } })}
            />
          </Field>
          <Field label="Model">
            <Input name="hotel-review-ai-model" autoComplete="off" spellCheck={false} value={props.config.ai.model} onChange={(value) => updateAi({ model: value })} />
          </Field>
        </section>

      </div>
      <div className="config-actions">
        <Button theme="solid" disabled={props.disabled} loading={props.saving} onClick={props.onSave}>
          保存配置
        </Button>
      </div>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

function ConfigSelect(props: {
  value: string;
  optionList: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      style={{ width: '100%' }}
      optionList={props.optionList}
      dropdownMatchSelectWidth
      zIndex={9999}
      onChange={(value) => props.onChange(String(value))}
    />
  );
}

function buildDataRangeOptions(dataRanges: IDataRange[]) {
  const ranges = dataRanges.length ? dataRanges : [{ type: SourceType.ALL } as IDataRange];
  return ranges.map((dataRange) => ({
    label: getDataRangeLabel(dataRange),
    value: getDataRangeValue(dataRange) ?? '',
    dataRange,
  }));
}

function getDataRangeLabel(dataRange: IDataRange): string {
  if (dataRange.type === SourceType.VIEW) {
    return dataRange.viewName || '未命名视图';
  }
  return '全部数据';
}

function getDataRangeValue(dataRange?: IDataRange): string | undefined {
  if (!dataRange) {
    return undefined;
  }
  if (dataRange.type === SourceType.VIEW) {
    return `${SourceType.VIEW}:${dataRange.viewId}`;
  }
  return SourceType.ALL;
}

function getViewIdFromDataRange(dataRange?: IDataRange): string | undefined {
  return dataRange?.type === SourceType.VIEW ? dataRange.viewId : undefined;
}

const fieldRows: Array<{ key: keyof PluginConfig['source']['fields']; label: string }> = [
  { key: 'reviewId', label: '评论 ID' },
  { key: 'content', label: '评论内容' },
  { key: 'hotelName', label: '酒店名称' },
  { key: 'score', label: '评分' },
  { key: 'reviewDate', label: '评论日期' },
  { key: 'checkInMonth', label: '入住日期' },
  { key: 'replyContent', label: '回复内容' },
  { key: 'roomType', label: '房型' },
];
