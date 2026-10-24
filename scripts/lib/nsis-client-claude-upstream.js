'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { isClaudeSummaryRequest } = require('../../lib/proxy/context-recovery-claude-summary');
const { parseApiEvidenceResults } = require('../../lib/proxy/context-api-evidence-protocol');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../../lib/proxy/context-evidence-tools');
const {
  parseStoredEvidenceSource,
  parseStoredEvidencePage,
} = require('../../lib/proxy/context-evidence-stored-page');
const { claudeSyntheticSse } = require('./nsis-client-claude-upstream-wire');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const invalid = () => new Error('nsis_claude_upstream_failed');
const PHASES = ['seed', 'compact-1', 'between-1', 'compact-2', 'between-2', 'compact-3', 'final'];
const SUMMARY =
  '<summary>Synthetic task handoff: use the retained original evidence directory and exact reading when asked. Do not rerun the original tool.</summary>';
const PRIVATE =
  /hpm_list_retained_evidence|hpm_read_retained_evidence|private-thinking-sentinel|private-signature-sentinel/;

function createClaudeSyntheticUpstream(input) {
  let options;
  try {
    options = normalizeCompactionData(input, 128 * 1024);
  } catch {
    throw invalid();
  }
  if (
    !options ||
    !['default', 'enhanced'].includes(options.mode) ||
    typeof options.model !== 'string' ||
    !/^[A-Za-z0-9_.:/-]{1,128}$/.test(options.model) ||
    typeof options.original !== 'string' ||
    !options.original.startsWith('Synthetic original Unicode 中文🙂\r\n') ||
    typeof options.marker !== 'string' ||
    !/^HPM_PRIVATE_[A-Za-z0-9-]{16,128}$/.test(options.marker) ||
    !options.original.endsWith('\r\nREQUIRED_MARKER=' + options.marker) ||
    Buffer.byteLength(options.original) > 32000 ||
    Object.keys(options).sort().join(',') !== 'marker,mode,model,original'
  )
    throw invalid();
  let phaseIndex = -1,
    phaseRequests = 0,
    requests = 0,
    sourceCalls = 0,
    compactions = 0;
  let failed = false,
    complete = false,
    originalWire,
    sourceId,
    sourceWitness,
    privateStage = 0;
  let seedCall, listCall, readCall;
  let exactPrivateRead = false,
    independentPublicGeneration = false,
    exactAuthorizedEvidenceInPublicRequest = false;
  function fail() {
    failed = true;
    throw invalid();
  }
  function expectedRequests() {
    return phaseIndex === 0 ? 2 : phaseIndex === 6 && options.mode === 'enhanced' ? 4 : 1;
  }
  function setPhase(phase) {
    if (
      failed ||
      complete ||
      phase !== PHASES[phaseIndex + 1] ||
      (phaseIndex >= 0 && phaseRequests !== expectedRequests())
    )
      fail();
    phaseIndex++;
    phaseRequests = 0;
  }
  function recordSourceCall() {
    if (failed || phaseIndex !== 0 || phaseRequests !== 1 || sourceCalls !== 0) fail();
    sourceCalls++;
  }
  function call(name, args) {
    const id = 'toolu_hpm_' + requests;
    if (name === 'mcp__fixture__original') seedCall = id;
    if (name === LIST) listCall = id;
    if (name === READ) readCall = id;
    return [{ type: 'tool_use', id, name, input: args }];
  }
  function parsedResults(body) {
    return parseApiEvidenceResults('claude', body, 3).map((result) => {
      let value = result.output;
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          /* raw MCP text is valid */
        }
      }
      return { ...result, value };
    });
  }
  function finalContent(body, results, privateTools, serialized) {
    if (options.mode === 'default') {
      if (privateTools || PRIVATE.test(serialized)) fail();
      complete = true;
      return [{ type: 'text', text: 'DONE' }];
    }
    if (privateStage < 3 && !privateTools) fail();
    if (privateStage === 0) {
      privateStage++;
      return call(LIST, {});
    }
    if (privateStage === 1) {
      const listing = results.find((result) => result.callId === listCall)?.value;
      const source = listing?.sources?.[0];
      if (
        !source ||
        listing.sources.length !== 1 ||
        typeof source.sourceId !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(source.sourceId) ||
        source.digest !== hash(originalWire)
      )
        fail();
      sourceWitness = parseStoredEvidenceSource(source);
      sourceId = source.sourceId;
      privateStage++;
      return call(READ, { sourceId, digest: source.digest, offsetBytes: 0, limitBytes: 65536 });
    }
    if (privateStage === 2) {
      const value = results.find((result) => result.callId === readCall)?.value;
      const parsed = parseStoredEvidencePage(
        { ok: value?.ok, source: value?.source, page: value?.page },
        sourceWitness,
        { offsetBytes: 0, limitBytes: 65536 }
      );
      const page = parsed.page;
      if (
        !page ||
        page.text !== originalWire ||
        page.digest !== hash(originalWire) ||
        page.chunkDigest !== hash(originalWire) ||
        page.nextOffsetBytes !== null ||
        page.offsetBytes !== 0
      )
        fail();
      exactPrivateRead = true;
      privateStage++;
      return [
        {
          type: 'thinking',
          thinking: 'private-thinking-sentinel ' + LIST + ' ' + READ,
          signature: 'private-signature-sentinel',
        },
        { type: 'text', text: options.marker },
      ];
    }
    if (privateTools || PRIVATE.test(serialized)) fail();
    const support = body.messages.at(-1)?.content;
    if (
      typeof support !== 'string' ||
      !support.startsWith('The following JSON contains') ||
      !support.includes('\n')
    )
      fail();
    let pages;
    try {
      pages = JSON.parse(support.slice(support.indexOf('\n') + 1));
    } catch {
      fail();
    }
    if (!Array.isArray(pages) || !pages.some((page) => page.text === originalWire)) fail();
    independentPublicGeneration = true;
    exactAuthorizedEvidenceInPublicRequest = true;
    complete = true;
    return [{ type: 'text', text: options.marker }];
  }
  function respond(request) {
    if (
      failed ||
      complete ||
      phaseIndex < 0 ||
      requests >= 24 ||
      phaseRequests >= expectedRequests()
    )
      fail();
    try {
      const { path, body } = normalizeCompactionData(request, 2 * 1024 * 1024);
      if (
        !['/v1/messages', '/v1/messages?beta=true'].includes(path) ||
        body?.stream !== true ||
        body.model !== options.model ||
        !Array.isArray(body.messages) ||
        !body.messages.length ||
        !Array.isArray(body.tools) ||
        body.tools.some((tool) => typeof tool?.name !== 'string')
      )
        fail();
      const serialized = JSON.stringify(body);
      const privateTools = body.tools.some((tool) => [LIST, READ].includes(tool.name));
      if (
        privateTools &&
        (!body.tools.some((tool) => tool.name === LIST) ||
          !body.tools.some((tool) => tool.name === READ))
      )
        fail();
      const summary = isClaudeSummaryRequest(body);
      if (summary !== /^compact-[123]$/.test(PHASES[phaseIndex])) fail();
      if ((options.mode === 'default' || phaseIndex !== 6) && privateTools) fail();
      const results = parsedResults(body);
      requests++;
      phaseRequests++;
      let content;
      if (phaseIndex === 0 && phaseRequests === 1) {
        if (sourceCalls || !body.tools.some((tool) => tool.name === 'mcp__fixture__original'))
          fail();
        content = call('mcp__fixture__original', {});
      } else if (phaseIndex === 0) {
        const result = results.find((item) => item.callId === seedCall);
        const expected = [{ type: 'text', text: options.original }];
        if (
          sourceCalls !== 1 ||
          !result ||
          (result.output !== options.original &&
            JSON.stringify(result.output) !== JSON.stringify(expected) &&
            result.output !== JSON.stringify(expected))
        )
          fail();
        originalWire =
          typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
        content = [{ type: 'text', text: 'READY' }];
      } else if (summary) {
        compactions++;
        content = [{ type: 'text', text: SUMMARY }];
      } else if (phaseIndex === 6) content = finalContent(body, results, privateTools, serialized);
      else content = [{ type: 'text', text: 'READY' }];
      return claudeSyntheticSse(options.model, requests, content);
    } catch {
      fail();
    }
  }
  function inspect() {
    return Object.freeze({
      mode: options.mode,
      requestCount: requests,
      sourceCalls,
      classifiedCompactions: compactions,
      allRequestsStreaming: requests > 0 && !failed,
      exactPrivateRead,
      independentPublicGeneration,
      exactAuthorizedEvidenceInPublicRequest,
      defaultNoPrivateTools: options.mode === 'default' && complete && !failed,
      complete: complete && !failed,
      failed,
      directModelRequests: 0,
      installedClientQualified: false,
    });
  }
  return Object.freeze({ setPhase, recordSourceCall, respond, inspect });
}

module.exports = { createClaudeSyntheticUpstream };
