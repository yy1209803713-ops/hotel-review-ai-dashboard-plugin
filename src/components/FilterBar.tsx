import { Button, Input, InputNumber, Select } from '@douyinfe/semi-ui';
import type { FilterState, PeriodType } from '../types/config';

export function FilterBar(props: {
  filters: FilterState;
  hotelOptions: string[];
  checkInMonthOptions: string[];
  loading: boolean;
  lastGeneratedAt?: string;
  onChange: (filters: FilterState) => void;
  onPeriodChange: (periodType: PeriodType) => void;
  onUpdate: () => void;
}) {
  const update = (patch: Partial<FilterState>) => props.onChange({ ...props.filters, ...patch });

  return (
    <div className="toolbar">
      <Select
        filter
        value={props.filters.hotelName}
        style={{ width: 180 }}
        optionList={[{ label: '全部酒店', value: 'all' }, ...props.hotelOptions.map((hotel) => ({ label: hotel, value: hotel }))]}
        onChange={(value) => update({ hotelName: String(value) })}
      />
      <div className="segmented">
        {(['today', 'week', 'month', 'custom'] as const).map((period) => (
          <button
            className={props.filters.periodType === period ? 'active' : ''}
            type="button"
            key={period}
            onClick={() => props.onPeriodChange(period)}
          >
            {periodLabel[period]}
          </button>
        ))}
      </div>
      {props.filters.periodType === 'custom' ? (
        <>
          <Input
            value={props.filters.startDate}
            placeholder="开始日期"
            style={{ width: 118 }}
            onChange={(value) => update({ startDate: value })}
          />
          <Input
            value={props.filters.endDate}
            placeholder="结束日期"
            style={{ width: 118 }}
            onChange={(value) => update({ endDate: value })}
          />
        </>
      ) : null}
      <Select
        filter
        value={props.filters.checkInMonth}
        style={{ width: 170 }}
        optionList={[{ label: '全部入住月份', value: 'all' }, ...props.checkInMonthOptions.map((month) => ({ label: month.slice(0, 7), value: month }))]}
        onChange={(value) => update({ checkInMonth: String(value) })}
      />
      <InputNumber
        value={props.filters.minScore ?? undefined}
        placeholder="最低分"
        min={0}
        max={5}
        style={{ width: 88 }}
        onChange={(value) => update({ minScore: typeof value === 'number' ? value : null })}
      />
      <InputNumber
        value={props.filters.maxScore ?? undefined}
        placeholder="最高分"
        min={0}
        max={5}
        style={{ width: 88 }}
        onChange={(value) => update({ maxScore: typeof value === 'number' ? value : null })}
      />
      <Input
        value={props.filters.keyword}
        placeholder="关键词"
        style={{ width: 150 }}
        onChange={(value) => update({ keyword: value })}
      />
      <Button theme="solid" loading={props.loading} onClick={props.onUpdate}>
        更新分析
      </Button>
      <span className="last-run">{props.lastGeneratedAt ? `上次分析：${formatDate(props.lastGeneratedAt)}` : '尚未分析'}</span>
    </div>
  );
}

const periodLabel: Record<PeriodType, string> = {
  today: '今天',
  week: '本周',
  month: '本月',
  custom: '自定义',
};

function formatDate(value: string): string {
  return value.replace('T', ' ').slice(0, 16);
}
