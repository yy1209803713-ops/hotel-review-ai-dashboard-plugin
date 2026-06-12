import type { ActionItem } from '../types/analysis';

export function ActionItems({ items }: { items: ActionItem[] }) {
  return (
    <section className="section-panel">
      <div className="section-head">
        <span>经营改进建议</span>
        <small>根据影响评论数和风险程度排序</small>
      </div>
      <div className="advice-list">
        {items.map((item, index) => (
          <div className="advice-item" key={item.id}>
            <div className="advice-level">{index + 1}</div>
            <div>
              <div className="advice-title">{item.title.replace('优先处理：', '')}</div>
              <div className="advice-copy">{item.description}</div>
            </div>
            <div className="impact">影响 {item.impactCount} 条</div>
          </div>
        ))}
      </div>
    </section>
  );
}
