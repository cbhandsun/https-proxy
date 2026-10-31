'use strict';

// Pure, bounded span construction. Only the registered source capability in
// context-task-state may turn these spans into provenance. IDs carry no role,
// authority, digest or completion attestation supplied by a model.
const MAX_CITATION_SPANS = 2048;
const MAX_CITATION_CHARACTERS = 1024;
const MAX_CACHED_CITATION_TEXTS = 16384;
const citationSpanCache = new Map();

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isImmediateSentenceEnd(code) {
  return (
    code === 0x0a ||
    code === 0x3b ||
    code === 0x3002 ||
    code === 0xff01 ||
    code === 0xff1f ||
    code === 0xff1b
  );
}

function isPunctuationSentenceEnd(code) {
  return code === 0x2e || code === 0x21 || code === 0x3f;
}

function taskCitationSpans(text) {
  if (typeof text !== 'string') return null;
  if (text.length <= 65536 && citationSpanCache.has(text)) {
    return citationSpanCache.get(text);
  }
  if (Buffer.byteLength(text) > 192 * 1024) return null;
  const spans = [];
  // Fine-grained short instructions get sentence citations. Long narration is
  // grouped into bounded paragraphs instead of repeating an ID for every tiny
  // sentence: the menu must not consume the original summary request budget.
  const minimumSentenceSpan = text.length > 128 ? 512 : 1;
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    const code = text.charCodeAt(cursor);
    // Advance over a complete code point before choosing an exclusive end.
    if (
      isHighSurrogate(code) &&
      cursor + 1 < text.length &&
      isLowSurrogate(text.charCodeAt(cursor + 1))
    ) {
      if (cursor - start === MAX_CITATION_CHARACTERS - 1) {
        if (!append(cursor)) return null;
      }
      cursor++;
    }
    const end = cursor + 1;
    const currentCode = text.charCodeAt(cursor);
    const sentenceEnd =
      isImmediateSentenceEnd(currentCode) ||
      (isPunctuationSentenceEnd(currentCode) && (end === text.length || /\s/.test(text[end])));
    if (
      (sentenceEnd && end - start >= minimumSentenceSpan) ||
      end - start >= MAX_CITATION_CHARACTERS ||
      end === text.length
    )
      if (!append(end)) return null;
  }
  function append(end) {
    const quote = text.slice(start, end);
    if (quote.trim()) {
      if (spans.length === MAX_CITATION_SPANS) return false;
      spans.push(Object.freeze({ start, end, quote }));
    }
    start = end;
    return true;
  }
  const frozen = Object.freeze(spans);
  if (text.length <= 65536) {
    if (citationSpanCache.size >= MAX_CACHED_CITATION_TEXTS) {
      citationSpanCache.delete(citationSpanCache.keys().next().value);
    }
    citationSpanCache.set(text, frozen);
  }
  return frozen;
}

module.exports = { MAX_CITATION_SPANS, taskCitationSpans };
