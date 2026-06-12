import { Banner, Button, Spin } from '@douyinfe/semi-ui';

export function LoadingPanel({ message }: { message: string }) {
  return (
    <div className="state-panel">
      <Spin size="large" />
      <div className="state-title">{message}</div>
    </div>
  );
}

export function EmptyState({ onUpdate }: { onUpdate: () => void }) {
  return (
    <div className="state-panel">
      <div className="state-title">还没有分析缓存</div>
      <div className="state-copy">点击更新分析后，将对当前筛选范围内的评论做一次整体 AI 聚合。</div>
      <Button theme="solid" onClick={onUpdate}>
        更新分析
      </Button>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return <Banner type="danger" description={message} closeIcon={null} />;
}

export function StaleBanner() {
  return <Banner type="warning" description="当前结果基于上次分析条件，点击更新分析生成新结果。" closeIcon={null} />;
}
