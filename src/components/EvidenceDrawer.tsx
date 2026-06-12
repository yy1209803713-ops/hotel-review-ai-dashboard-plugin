import type { ReviewRecord, TopicSummary } from '../types/analysis';

export function EvidenceDrawer(props: {
  topic: TopicSummary | null;
  records: ReviewRecord[];
  loading: boolean;
  onClose: () => void;
}) {
  if (!props.topic) {
    return (
      <aside className="section-panel evidence-panel">
        <div className="section-head">
          <span>主题下钻</span>
          <small>点击主题查看证据</small>
        </div>
        <div className="drawer-empty">选择一个好评点或差评点后，这里会展示关联评论证据。</div>
      </aside>
    );
  }
  const topic = props.topic;

  return (
    <aside className="section-panel evidence-panel active">
      <div className="section-head">
        <span>{topic.displayTopic}</span>
        <button className="text-button" type="button" onClick={props.onClose}>
          关闭
        </button>
      </div>
      <div className="drawer-summary">
        <strong>{topic.count} 条命中评论</strong>
        <span>{topic.summary}</span>
      </div>
      {props.loading ? (
        <div className="drawer-empty">正在读取关联评论...</div>
      ) : (
        <div className="comment-list">
          {props.records.map((record) => (
            <article className="comment-item" key={record.recordId}>
              <div className="comment-meta">
                {record.reviewDate ?? '-'} · 评分 {record.score ?? '-'} · {record.hotelName} · {record.hasReply ? '已回复' : '未回复'}
              </div>
              <div className="comment-room">{record.roomType}</div>
              <p>{highlightEvidence(record.content, evidencePhrasesForRecord(topic, record.recordId))}</p>
            </article>
          ))}
        </div>
      )}
    </aside>
  );
}

function evidencePhrasesForRecord(topic: TopicSummary, recordId: string): string[] {
  const recordPhrases = topic.evidenceItems
    ?.filter((item) => item.recordId === recordId)
    .map((item) => item.quote)
    .filter(Boolean);
  return recordPhrases?.length ? recordPhrases : topic.evidencePhrases;
}

function highlightEvidence(content: string, phrases: string[]) {
  const phrase = phrases.find((item) => item && content.includes(item));
  if (!phrase) {
    return content;
  }
  const [before, after] = content.split(phrase);
  return (
    <>
      {before}
      <mark>{phrase}</mark>
      {after}
    </>
  );
}
