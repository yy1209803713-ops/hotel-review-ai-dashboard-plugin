import type { AnalysisCacheDiagnostics } from '../types/analysis';

export function CacheDiagnosticsPanel({ diagnostics }: { diagnostics: AnalysisCacheDiagnostics }) {
  return (
    <section className="cache-diagnostics-panel">
      <div className="section-head">
        <span>缓存诊断</span>
        <small>{diagnostics.triggered ? '本次分析已读取缓存层' : '本次分析未读取缓存层'}</small>
      </div>
      <div className="cache-diagnostics-list">
        <div>{formatLayer('证据缓存', diagnostics.evidenceCache)}</div>
        <div>{formatLayer('主题映射缓存', diagnostics.topicMappingCache)}</div>
        <div>本次触发层：{diagnostics.layers.length ? diagnostics.layers.join(', ') : '-'}</div>
        <div>
          本次是否调用 AI：证据抽取 {diagnostics.aiTriggered.evidenceExtraction ? '是' : '否'}；主题归并{' '}
          {diagnostics.aiTriggered.topicMapping ? '是' : '否'}
        </div>
      </div>
    </section>
  );
}

function formatLayer(label: string, layer: { requested: number; hits: number; hitRate: number }): string {
  return `${label}：命中 ${layer.hits} / ${layer.requested}，命中率 ${formatPercent(layer.hitRate)}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
