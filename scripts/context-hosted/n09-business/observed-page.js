'use strict';

const { normalizeCompactionData } = require('../../../lib/proxy/context-compaction-envelope');
const { parseStoredEvidencePage } = require('../../../lib/proxy/context-evidence-stored-page');
const { exact } = require('../shared/boundary');
const fail = () => new Error('n09_observed_page_rejected');
const sourceFields = [
  'sourceId',
  'callId',
  'toolName',
  'argumentsDigest',
  'digest',
  'bytes',
  'expiresAt',
  'trust',
];
function scalarRecord(input, fields) {
  const value = exact(input, fields);
  if (
    Object.values(value).some(
      (item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item)
    )
  )
    throw fail();
  return value;
}

// Model-facing session replies carry provenance that internal storage pages do
// not. Authenticate that outer contract before applying the strict page parser.
function parseObservedPage(input, source, args) {
  try {
    const outer = exact(input, ['observation', 'ok', 'page', 'source', 'verification']);
    outer.page = scalarRecord(outer.page, [
      'chunkDigest',
      'digest',
      'encoding',
      'endOffsetBytes',
      'nextOffsetBytes',
      'offsetBytes',
      'text',
      'totalBytes',
    ]);
    outer.source = scalarRecord(outer.source, sourceFields);
    if (
      [outer.observation, outer.ok, outer.verification].some(
        (item) => !['string', 'boolean'].includes(typeof item)
      )
    )
      throw fail();
    const expected = scalarRecord(source, sourceFields);
    const range = scalarRecord(args, ['offsetBytes', 'limitBytes']);
    if (
      !Number.isSafeInteger(range.offsetBytes) ||
      range.offsetBytes < 0 ||
      !Number.isSafeInteger(range.limitBytes) ||
      range.limitBytes < 1 ||
      range.limitBytes > 65536
    )
      throw fail();
    const value = normalizeCompactionData(outer, 128 * 1024);
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'observation,ok,page,source,verification' ||
      value.ok !== true ||
      value.observation !== 'client_reported' ||
      value.verification !== 'not_verified'
    )
      throw fail();
    return parseStoredEvidencePage(
      { ok: value.ok, page: value.page, source: value.source },
      expected,
      range
    );
  } catch {
    throw fail();
  }
}

module.exports = { parseObservedPage };
