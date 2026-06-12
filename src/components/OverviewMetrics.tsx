import type { OverviewMetrics as OverviewMetricsType } from '../types/analysis';

export function OverviewMetrics({ overview }: { overview: OverviewMetricsType }) {
  const positiveRate = overview.totalReviews ? overview.positiveReviews / overview.totalReviews : 0;
  const riskRate = overview.totalReviews ? overview.negativeOrRiskReviews / overview.totalReviews : 0;

  return (
    <section className="overview-grid">
      <MetricCard tone="blue" label="总评论" value={formatNumber(overview.totalReviews)} foot="当前筛选范围内可分析评论" />
      <MetricCard
        tone="green"
        label="AI 判定好评"
        value={formatNumber(overview.positiveReviews)}
        foot={`占比 ${formatPercent(positiveRate)}`}
      />
      <MetricCard
        tone="red"
        label="差评 / 风险"
        value={formatNumber(overview.negativeOrRiskReviews)}
        foot={`占比 ${formatPercent(riskRate)}，含混合评价风险点`}
      />
      <MetricCard label="平均评分" value={overview.averageScore === null ? '-' : overview.averageScore.toFixed(2)} foot="评分仅辅助展示" />
      <MetricCard label="回复率" value={formatPercent(overview.replyRate)} foot="基于酒店回复内容字段" />
    </section>
  );
}

function MetricCard(props: { label: string; value: string; foot: string; tone?: 'blue' | 'green' | 'red' }) {
  return (
    <div className={`metric-card ${props.tone ?? ''}`}>
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      <div className="metric-foot">{props.foot}</div>
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
