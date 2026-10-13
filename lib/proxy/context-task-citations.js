'use strict';

// Pure, bounded span construction. Only the registered source capability in
// context-task-state may turn these spans into provenance. IDs carry no role,
// authority, digest or completion attestation supplied by a model.
const MAX_CITATION_SPANS = 2048;
const MAX_CITATION_CHARACTERS = 1024;

function taskCitationSpans(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 192 * 1024) return null;
  const spans = [];
  // Fine-grained short instructions get sentence citations. Long narration is
  // grouped into bounded paragraphs instead of repeating an ID for every tiny
  // sentence: the menu must not consume the original summary request budget.
  const minimumSentenceSpan = text.length > 128 ? 512 : 1;
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    // Advance over a complete code point before choosing an exclusive end.
    if (/[\uD800-\uDBFF]/.test(text[cursor]) && /[\uDC00-\uDFFF]/.test(text[cursor + 1] ?? '')) {
      if (cursor - start === MAX_CITATION_CHARACTERS - 1) {
        if (!append(cursor)) return null;
      }
      cursor++;
    }
    const end = cursor + 1;
    const sentenceEnd =
      /[\n。！？；;]/.test(text[cursor]) ||
      (/[.!?]/.test(text[cursor]) && (end === text.length || /\s/.test(text[end])));
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
  return Object.freeze(spans);
}

module.exports = { MAX_CITATION_SPANS, taskCitationSpans };
