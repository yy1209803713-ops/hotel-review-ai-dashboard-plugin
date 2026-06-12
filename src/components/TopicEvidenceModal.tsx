import { Modal, Pagination } from '@douyinfe/semi-ui';
import type { ReactNode } from 'react';
import { extractEvidenceSnippet } from '../services/evidenceSnippet';
import type { ReviewRecord, TopicSummary } from '../types/analysis';

export function TopicEvidenceModal(props: {
  topic: TopicSummary | null;
  records: ReviewRecord[];
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
}) {
  const topic = props.topic;
  const total = topic?.commentRecordIds.length ?? 0;
  const startIndex = (props.page - 1) * props.pageSize;

  return (
    <Modal
      visible={Boolean(topic)}
      title={topic ? <EvidenceTitle topic={topic} total={total} /> : null}
      footer={null}
      centered
      maskClosable
      closeOnEsc
      width="min(920px, calc(100vw - 32px))"
      className="topic-evidence-modal"
      bodyStyle={{ padding: 0 }}
      onCancel={() => props.onClose()}
    >
      {topic ? (
        <div className="evidence-modal-body">
          <div className="evidence-topic-summary">
            <span>{topic.summary}</span>
            <span>{topic.category} · {topic.sentiment === 'positive' ? '好评主题' : '风险主题'}</span>
          </div>
          <div className="evidence-list" aria-busy={props.loading}>
            {props.loading ? (
              <div className="evidence-loading">正在读取本页原始评论...</div>
            ) : props.records.length ? (
              props.records.map((record, index) => (
                <EvidenceRecordItem
                  index={startIndex + index + 1}
                  key={record.recordId}
                  record={record}
                  topic={topic}
                />
              ))
            ) : (
              <div className="evidence-loading">当前页没有可展示的原始评论。</div>
            )}
          </div>
          <div className="evidence-pagination">
            <span>
              第 {props.page} 页 · 共 {total} 条原始评论
            </span>
            <Pagination
              currentPage={props.page}
              pageSize={props.pageSize}
              total={total}
              size="small"
              showSizeChanger={false}
              showQuickJumper={total > props.pageSize * 3}
              hideOnSinglePage={false}
              onPageChange={props.onPageChange}
            />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function EvidenceTitle({ topic, total }: { topic: TopicSummary; total: number }) {
  return (
    <div className="evidence-title">
      <div>
        <span className={`evidence-sentiment ${topic.sentiment}`}>{topic.sentiment === 'positive' ? '好评' : '风险'}</span>
        <strong>{topic.displayTopic}</strong>
      </div>
      <small>{topic.count} 条命中评论 · 当前可翻阅 {total} 条原始评论</small>
    </div>
  );
}

function EvidenceRecordItem({ index, record, topic }: { index: number; record: ReviewRecord; topic: TopicSummary }) {
  const phrases = evidencePhrasesForRecord(topic, record.recordId);
  const snippet = extractEvidenceSnippet(record.content, phrases);

  return (
    <article className="evidence-record">
      <div className="evidence-record-head">
        <div>
          <span className="evidence-index">#{index}</span>
          <strong>{record.hotelName}</strong>
        </div>
        <span>{record.reviewDate ?? '-'} · 评分 {record.score ?? '-'}</span>
      </div>
      <div className="evidence-meta">
        <span>{record.roomType ?? '未知房型'}</span>
        <span>{record.hasReply ? '已回复' : '未回复'}</span>
      </div>
      <p className={snippet.hasMatch ? 'evidence-snippet' : 'evidence-snippet missing-match'}>
        {renderHighlightedSnippet(snippet.text, snippet.phrase)}
      </p>
    </article>
  );
}

function evidencePhrasesForRecord(topic: TopicSummary, recordId: string): string[] {
  const recordPhrases = topic.evidenceItems
    ?.filter((item) => item.recordId === recordId)
    .map((item) => item.quote)
    .filter(Boolean);
  return recordPhrases?.length ? recordPhrases : topic.evidencePhrases;
}

function renderHighlightedSnippet(text: string, phrase: string | null): ReactNode {
  if (!phrase || !text.includes(phrase)) {
    return text;
  }

  return text.split(phrase).map((part, index, parts) => (
    <span key={`${part}-${index}`}>
      {part}
      {index < parts.length - 1 ? <mark>{phrase}</mark> : null}
    </span>
  ));
}
