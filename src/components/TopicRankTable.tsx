import type { TopicSummary } from '../types/analysis';

export function TopicRankTable(props: {
  title: string;
  subtitle: string;
  topics: TopicSummary[];
  totalReviews: number;
  tone: 'positive' | 'negative';
  onSelect: (topic: TopicSummary) => void;
}) {
  return (
    <section className={`section-panel ${props.tone}`}>
      <div className="section-head">
        <span>{props.title}</span>
        <small>{props.subtitle}</small>
      </div>
      <table className="rank-table">
        <thead>
          <tr>
            <th className="rank-cell">排名</th>
            <th>主题与代表短语</th>
            <th className="count-cell">提及评论</th>
          </tr>
        </thead>
        <tbody>
          {props.topics.map((topic, index) => (
            <tr key={`${topic.sentiment}-${topic.mergeKey}`} onClick={() => props.onSelect(topic)}>
              <td className="rank-cell">{index + 1}</td>
              <td>
                <button className={`topic-pill ${props.tone}`} type="button">
                  {topic.displayTopic}
                </button>
                <div className="phrase-row">
                  {topic.evidencePhrases.slice(0, 3).map((phrase) => (
                    <span className="phrase" key={phrase}>
                      {phrase}
                    </span>
                  ))}
                </div>
              </td>
              <td className="count-cell">
                <strong>{topic.count}</strong>
                <span>{formatPercent(topic.count, props.totalReviews)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function formatPercent(count: number, total: number): string {
  if (!total) {
    return '0%';
  }
  return `${Math.round((count / total) * 1000) / 10}%`;
}
