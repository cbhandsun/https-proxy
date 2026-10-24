'use strict';

const { createHash } = require('node:crypto');
const {
  parseStoredEvidenceSource,
  parseStoredEvidencePage,
} = require('../../lib/proxy/context-evidence-stored-page');
const fail = () => new Error('nsis_codex_upstream_failed');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const exact = (value, keys) => {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join(',') !== keys.slice().sort().join(',')
  )
    throw fail();
};
const tagged = (value) => {
  if (value.observation !== 'client_reported' || value.verification !== 'not_verified')
    throw fail();
  const { observation: _observation, verification: _verification, ...body } = value;
  return body;
};

function originalCodexWire(output, original) {
  if (output === original) return original;
  const value = typeof output === 'string' ? JSON.parse(output) : output;
  if (!Array.isArray(value) || value.length !== 1) throw fail();
  exact(value[0], ['type', 'text']);
  if (!['input_text', 'inputText', 'text'].includes(value[0].type) || value[0].text !== original)
    throw fail();
  return typeof output === 'string' ? output : JSON.stringify(output);
}

function retainedSource(value, original) {
  const body = tagged(value);
  exact(body, ['ok', 'sources', 'nextAfterSourceId']);
  if (
    body.ok !== true ||
    body.nextAfterSourceId !== null ||
    !Array.isArray(body.sources) ||
    body.sources.length !== 1
  )
    throw fail();
  const source = parseStoredEvidenceSource(body.sources[0]);
  if (source.digest !== hash(original) || source.bytes !== Buffer.byteLength(original))
    throw fail();
  return source;
}

function retainedPage(value, source, args, original, offset) {
  const body = parseStoredEvidencePage(tagged(value), source, args, 16384);
  const page = body.page,
    bytes = Buffer.from(original);
  if (
    !body.ok ||
    page.offsetBytes !== offset ||
    bytes.subarray(offset, page.endOffsetBytes).toString('utf8') !== page.text
  )
    throw fail();
  return page;
}

function publicEvidence(body, original) {
  const last = body.input.at(-1);
  const text =
    typeof last?.content === 'string'
      ? last.content
      : last?.content?.length === 1 && last.content[0]?.type === 'input_text'
        ? last.content[0].text
        : null;
  if (
    typeof text !== 'string' ||
    !text.startsWith('The following JSON contains') ||
    !text.includes('\n')
  )
    throw fail();
  const pages = JSON.parse(text.slice(text.indexOf('\n') + 1)),
    bytes = Buffer.from(original);
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 16) throw fail();
  let offset = 0;
  for (const page of pages) {
    exact(page, ['text', 'encoding', 'digest', 'offsetBytes', 'endOffsetBytes', 'totalBytes']);
    if (
      page.encoding !== 'utf8' ||
      page.digest !== hash(original) ||
      page.totalBytes !== bytes.length ||
      page.offsetBytes !== offset ||
      !Number.isSafeInteger(page.endOffsetBytes) ||
      page.endOffsetBytes <= offset ||
      page.endOffsetBytes > bytes.length ||
      typeof page.text !== 'string' ||
      Buffer.from(page.text).toString('utf8') !== page.text ||
      Buffer.byteLength(page.text) !== page.endOffsetBytes - offset ||
      bytes.subarray(offset, page.endOffsetBytes).toString('utf8') !== page.text
    )
      throw fail();
    offset = page.endOffsetBytes;
  }
  if (offset !== bytes.length) throw fail();
  return pages.length;
}

module.exports = { originalCodexWire, retainedSource, retainedPage, publicEvidence };
