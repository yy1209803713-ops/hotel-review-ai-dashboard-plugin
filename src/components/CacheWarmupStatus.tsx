import type { WarmupResponse } from '../services/warmup';

export function CacheWarmupStatus(props: { response: WarmupResponse; triggeredAt: string }) {
  const { response } = props;
  return (
    <section className="section-panel warmup-status-panel">
      <div className="section-head">
        <span>缓存预热状态</span>
        <small>{statusLabel(response.status)} · {formatTime(props.triggeredAt)}</small>
      </div>
      <div className="warmup-status-grid">
        <StatusMetric label="证据缓存覆盖" value={coverage(response.summary.evidenceCacheHits, response.summary.totalReviews)} />
        <StatusMetric label="待补评论" value={`${response.summary.evidenceCacheMisses}`} />
        <StatusMetric
          label="主题映射覆盖"
          value={coverage(
            response.summary.topicMappingHits,
            response.summary.topicMappingHits + response.summary.topicMappingMisses,
          )}
        />
        <StatusMetric label="新增缓存" value={`${response.summary.evidenceRecordsSaved + response.summary.topicMappingsSaved}`} />
      </div>
      {response.errors.length ? (
        <div className="warmup-status-error">
          {response.errors[0].stage} {response.errors[0].message}
        </div>
      ) : null}
    </section>
  );
}

function StatusMetric(props: { label: string; value: string }) {
  return (
    <div className="warmup-status-metric">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function coverage(hitCount: number, totalCount: number): string {
  if (!totalCount) {
    return '0%';
  }
  return `${Math.round((hitCount / totalCount) * 100)}%`;
}

function statusLabel(status: WarmupResponse['status']): string {
  if (status === 'success') {
    return '成功';
  }
  if (status === 'skipped') {
    return '已跳过';
  }
  if (status === 'failed') {
    return '失败';
  }
  if (status === 'partial_success') {
    return '部分成功';
  }
  if (status === 'running') {
    return '运行中';
  }
  return '已接收';
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
