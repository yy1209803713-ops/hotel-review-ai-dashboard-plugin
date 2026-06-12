export type EvidenceSnippet = {
  text: string;
  phrase: string | null;
  hasMatch: boolean;
};

const SENTENCE_END = /[。！？!?；;]/;
const CLOSING_PUNCTUATION = /[”’）)】》」』]/;
const MAX_FALLBACK_LENGTH = 180;
const MAX_SNIPPET_LENGTH = 260;

export function extractEvidenceSnippet(content: string, phrases: string[], contextSentences = 1): EvidenceSnippet {
  const normalizedContent = normalizeContent(content);
  if (!normalizedContent) {
    return {
      text: '',
      phrase: null,
      hasMatch: false,
    };
  }

  const phrase = phrases.map((item) => item.trim()).filter(Boolean).find((item) => normalizedContent.includes(item));
  if (!phrase) {
    return {
      text: trimWithEllipsis(normalizedContent, MAX_FALLBACK_LENGTH),
      phrase: null,
      hasMatch: false,
    };
  }

  const matchIndex = normalizedContent.indexOf(phrase);
  const sentences = splitSentences(normalizedContent);
  const matchedSentenceIndex = sentences.findIndex((sentence) => matchIndex >= sentence.start && matchIndex < sentence.end);

  if (matchedSentenceIndex === -1) {
    return {
      text: trimAroundMatch(normalizedContent, matchIndex, phrase.length),
      phrase,
      hasMatch: true,
    };
  }

  const startIndex = Math.max(0, matchedSentenceIndex - contextSentences);
  const endIndex = Math.min(sentences.length - 1, matchedSentenceIndex + contextSentences);
  const text = sentences.slice(startIndex, endIndex + 1).map((sentence) => sentence.text).join('');

  return {
    text: text.length > MAX_SNIPPET_LENGTH ? trimAroundMatch(text, text.indexOf(phrase), phrase.length) : text,
    phrase,
    hasMatch: true,
  };
}

type SentenceSpan = {
  start: number;
  end: number;
  text: string;
};

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): SentenceSpan[] {
  const sentences: SentenceSpan[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!SENTENCE_END.test(text[index])) {
      continue;
    }

    let end = index + 1;
    while (end < text.length && CLOSING_PUNCTUATION.test(text[end])) {
      end += 1;
    }
    pushSentence(sentences, text, start, end);
    start = end;
    index = end - 1;
  }

  pushSentence(sentences, text, start, text.length);
  return sentences.length ? sentences : [{ start: 0, end: text.length, text }];
}

function pushSentence(sentences: SentenceSpan[], text: string, start: number, end: number) {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  const leadingSpace = raw.indexOf(trimmed[0]);
  const sentenceStart = start + Math.max(0, leadingSpace);
  sentences.push({
    start: sentenceStart,
    end,
    text: trimmed,
  });
}

function trimWithEllipsis(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}...`;
}

function trimAroundMatch(text: string, matchIndex: number, matchLength: number): string {
  if (text.length <= MAX_SNIPPET_LENGTH) {
    return text;
  }

  const sideLength = Math.max(40, Math.floor((MAX_SNIPPET_LENGTH - matchLength) / 2));
  const start = Math.max(0, matchIndex - sideLength);
  const end = Math.min(text.length, matchIndex + matchLength + sideLength);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).trim()}${end < text.length ? '...' : ''}`;
}
