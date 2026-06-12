import { Banner, Button, Input, InputNumber, Select, Switch } from '@douyinfe/semi-ui';
import type { RuntimeCategory, RuntimeTable } from '../runtime/sdk';
import type { PluginConfig } from '../types/config';

export function ConfigPanel(props: {
  config: PluginConfig;
  tables: RuntimeTable[];
  categories: RuntimeCategory[];
  saving: boolean;
  testingConnection: boolean;
  onChange: (config: PluginConfig) => void;
  onSave: () => void;
  onTestConnection: () => void;
}) {
  const update = (patch: Partial<PluginConfig>) => props.onChange({ ...props.config, ...patch });
  const updateAi = (patch: Partial<PluginConfig['ai']>) => update({ ai: { ...props.config.ai, ...patch } });
  const updateSource = (patch: Partial<PluginConfig['source']>) => update({ source: { ...props.config.source, ...patch } });
  const updateFields = (key: keyof PluginConfig['source']['fields'], value: string) =>
    updateSource({ fields: { ...props.config.source.fields, [key]: value } });

  return (
    <aside className="config-panel">
      <div className="config-scroll">
        <h2>插件配置</h2>
        <Banner
          type="warning"
          closeIcon={null}
          description="API Key 直连仅适合自用阶段；公开上架前需要迁移到后端代理。"
        />
        <Field label="数据表">
          <ConfigSelect
            value={props.config.source.tableId}
            optionList={props.tables.map((table) => ({ label: table.tableName, value: table.tableId }))}
            onChange={(value) => updateSource({ tableId: String(value) })}
          />
        </Field>
        <div className="config-group-title">字段映射</div>
        {fieldRows.map((row) => (
          <Field label={row.label} key={row.key}>
            <ConfigSelect
              value={props.config.source.fields[row.key]}
              optionList={props.categories.map((field) => ({ label: field.fieldName, value: field.fieldId }))}
              onChange={(value) => updateFields(row.key, String(value))}
            />
          </Field>
        ))}
        <div className="config-group-title">AI API</div>
        <Field label="API Base URL">
          <Input
            name="hotel-review-ai-api-base-url"
            autoComplete="off"
            spellCheck={false}
            value={props.config.ai.apiBaseUrl}
            onChange={(value) => updateAi({ apiBaseUrl: value })}
          />
        </Field>
        <Field label="API Key">
          <Input
            name="hotel-review-ai-api-key"
            autoComplete="new-password"
            mode="password"
            spellCheck={false}
            value={props.config.ai.apiKey}
            onChange={(value) => updateAi({ apiKey: value })}
          />
        </Field>
        <Field label="Model">
          <Input
            name="hotel-review-ai-model"
            autoComplete="off"
            spellCheck={false}
            value={props.config.ai.model}
            onChange={(value) => updateAi({ model: value })}
          />
        </Field>
        <div className="config-inline">
          <Field label="Temperature">
            <InputNumber
              value={props.config.ai.temperature}
              min={0}
              max={2}
              step={0.1}
              onChange={(value) => updateAi({ temperature: typeof value === 'number' ? value : 0.2 })}
            />
          </Field>
          <Field label="Top N">
            <InputNumber
              value={props.config.ai.topN}
              min={3}
              max={20}
              onChange={(value) => updateAi({ topN: typeof value === 'number' ? value : 10 })}
            />
          </Field>
        </div>
        <Field label="批次大小">
          <InputNumber
            value={props.config.ai.maxBatchSize}
            min={10}
            max={200}
            onChange={(value) => updateAi({ maxBatchSize: typeof value === 'number' ? value : 10 })}
          />
        </Field>
        <Field label="并发数">
          <InputNumber
            value={props.config.ai.batchConcurrency ?? 3}
            min={1}
            max={20}
            onChange={(value) => updateAi({ batchConcurrency: typeof value === 'number' ? value : 3 })}
          />
        </Field>
        <div className="config-switch">
          <span>写回 Base 聚合结果</span>
          <Switch
            checked={props.config.writeback.enabled}
            onChange={(checked) =>
              update({
                writeback: {
                  ...props.config.writeback,
                  enabled: Boolean(checked),
                  confirmed: Boolean(checked) ? props.config.writeback.confirmed : false,
                },
              })
            }
          />
        </div>
        {props.config.writeback.enabled && !props.config.writeback.confirmed ? (
          <div className="writeback-confirm">
            <span>首次写回会创建「AI分析批次」和「AI主题汇总」两张表。</span>
            <Button
              size="small"
              onClick={() => update({ writeback: { ...props.config.writeback, confirmed: true } })}
            >
              确认创建
            </Button>
          </div>
        ) : null}
      </div>
      <div className="config-actions">
        <Button loading={props.testingConnection} onClick={props.onTestConnection}>
          测试连接
        </Button>
        <Button theme="solid" loading={props.saving} onClick={props.onSave}>
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
