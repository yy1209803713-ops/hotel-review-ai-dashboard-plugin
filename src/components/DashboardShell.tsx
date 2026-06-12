import type { AnalysisResult, ReviewRecord, TopicSummary } from '../types/analysis';
import type { FilterState, PeriodType } from '../types/config';
import { ActionItems } from './ActionItems';
import { EmptyState, ErrorBanner, LoadingPanel, StaleBanner } from './StateViews';
import { FilterBar } from './FilterBar';
import { OverviewMetrics } from './OverviewMetrics';
import { TopicEvidenceModal } from './TopicEvidenceModal';
import { TopicRankTable } from './TopicRankTable';

export function DashboardShell(props: {
  analysis: AnalysisResult | null;
  filters: FilterState;
  hotelOptions: string[];
  checkInMonthOptions: string[];
  selectedTopic: TopicSummary | null;
  evidenceRecords: ReviewRecord[];
  evidencePage: number;
  evidencePageSize: number;
  evidenceLoading: boolean;
  loading: boolean;
  error: string | null;
  stale: boolean;
  onFilterChange: (filters: FilterState) => void;
  onPeriodChange: (periodType: PeriodType) => void;
  onUpdate: () => void;
  onSelectTopic: (topic: TopicSummary) => void;
  onEvidencePageChange: (page: number) => void;
  onCloseTopic: () => void;
}) {
  return (
    <main className="dashboard-page">
      <section className="dashboard-shell">
        <header className="app-header">
          <div>
            <div className="app-title-row">
              <h1>酒店评论 AI 分析</h1>
              <span className="version-badge">V1.2</span>
            </div>
            <p>按酒店和周期做整体聚合分析，更新按钮只刷新缓存，不在每次打开时消耗 AI token。</p>
          </div>
        </header>
        <FilterBar
          filters={props.filters}
          hotelOptions={props.hotelOptions}
          checkInMonthOptions={props.checkInMonthOptions}
          loading={props.loading}
          lastGeneratedAt={props.analysis?.generatedAt}
          onChange={props.onFilterChange}
          onPeriodChange={props.onPeriodChange}
          onUpdate={props.onUpdate}
        />
        <div className="content">
          {props.error ? <ErrorBanner message={props.error} /> : null}
          {props.stale ? <StaleBanner /> : null}
          {props.loading ? <LoadingPanel message="正在读取评论并进行 AI 聚合分析..." /> : null}
          {!props.loading && !props.analysis ? <EmptyState onUpdate={props.onUpdate} /> : null}
          {!props.loading && props.analysis ? (
            <>
              <OverviewMetrics overview={props.analysis.overview} />
              <section className="topic-grid">
                <TopicRankTable
                  title="好评点 Top 10"
                  subtitle="按命中评论数排序"
                  topics={props.analysis.positiveTopics}
                  totalReviews={props.analysis.overview.totalReviews}
                  tone="positive"
                  onSelect={props.onSelectTopic}
                />
                <TopicRankTable
                  title="差评点 Top 10"
                  subtitle="高分评论中的负面细节也计入"
                  topics={props.analysis.negativeTopics}
                  totalReviews={props.analysis.overview.totalReviews}
                  tone="negative"
                  onSelect={props.onSelectTopic}
                />
              </section>
              <section className="bottom-grid">
                <ActionItems items={props.analysis.actionItems} />
              </section>
              <TopicEvidenceModal
                topic={props.selectedTopic}
                records={props.evidenceRecords}
                loading={props.evidenceLoading}
                page={props.evidencePage}
                pageSize={props.evidencePageSize}
                onPageChange={props.onEvidencePageChange}
                onClose={props.onCloseTopic}
              />
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
