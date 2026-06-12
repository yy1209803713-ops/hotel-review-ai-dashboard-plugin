import { describe, expect, it } from 'vitest';
import { extractEvidenceSnippet } from './evidenceSnippet';

describe('extractEvidenceSnippet', () => {
  it('returns the matched sentence with one sentence before and after', () => {
    const snippet = extractEvidenceSnippet(
      '第一句是背景。第二句提到位置没得说。第三句继续说明出行方便。第四句无关。',
      ['位置没得说'],
    );

    expect(snippet).toEqual({
      text: '第一句是背景。第二句提到位置没得说。第三句继续说明出行方便。',
      phrase: '位置没得说',
      hasMatch: true,
    });
  });

  it('supports risk phrases in the first sentence', () => {
    const snippet = extractEvidenceSnippet('莲蓬老化，洗漱不方便。服务人员后来有解释。其他体验一般。', ['莲蓬老化']);

    expect(snippet.text).toBe('莲蓬老化，洗漱不方便。服务人员后来有解释。');
    expect(snippet.phrase).toBe('莲蓬老化');
    expect(snippet.hasMatch).toBe(true);
  });

  it('falls back to a compact excerpt when no phrase matches', () => {
    const snippet = extractEvidenceSnippet('这是一条没有精确证据短语但仍来自主题关联记录的评论。', ['不存在']);

    expect(snippet.text).toBe('这是一条没有精确证据短语但仍来自主题关联记录的评论。');
    expect(snippet.phrase).toBeNull();
    expect(snippet.hasMatch).toBe(false);
  });
});
