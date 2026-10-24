'use strict';

const { createHash } = require('node:crypto');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { isCodexSummaryRequest } = require('../../lib/proxy/context-recovery-codex-summary');
const {
  originalCodexWire,
  retainedSource,
  retainedPage,
  publicEvidence,
} = require('./nsis-client-codex-upstream-evidence');
const { syntheticCodexWire } = require('./nsis-client-codex-upstream-wire');
const LIST = 'hpm_list_retained_evidence',
  READ = 'hpm_read_retained_evidence';
const ORIGINAL = 'hpm_fixture_original',
  SENTINEL = 'private-thinking-sentinel';
const phases = ['seed', 'compact-1', 'compact-2', 'compact-3', 'final'];
const fail = () => new Error('nsis_codex_upstream_failed');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const privateText = (value) =>
  [LIST, READ, SENTINEL].some((name) => JSON.stringify(value).includes(name));

function createCodexSyntheticUpstream(input) {
  try {
    const options = normalizeCompactionData(input, 512 * 1024);
    if (
      !options ||
      Array.isArray(options) ||
      Object.keys(options).sort().join(',') !== 'marker,mode,model,original' ||
      !['default', 'enhanced'].includes(options.mode) ||
      typeof options.model !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.model) ||
      typeof options.original !== 'string' ||
      Buffer.byteLength(options.original) < 1 ||
      Buffer.byteLength(options.original) > 65536 ||
      Buffer.from(options.original).toString('utf8') !== options.original ||
      typeof options.marker !== 'string' ||
      !/^HPM_SYNTHETIC_[a-f0-9]{32}$/.test(options.marker) ||
      !options.original.endsWith('REQUIRED_MARKER=' + options.marker)
    )
      throw fail();
    let failed = false,
      phase = -1,
      complete = true,
      requests = 0,
      streams = 0,
      json = 0,
      summaries = 0,
      compactions = 0,
      originalWire,
      seedState = 0,
      privateSeed = false,
      pending,
      source,
      offset = 0,
      readPages = 0,
      exactRead = false,
      publicVerified = false,
      finalState = 0,
      privateSummary = false;
    const seen = new Set();
    const guarded = (action) => {
      if (failed) throw fail();
      try {
        return action();
      } catch {
        failed = true;
        throw fail();
      }
    };
    const outputFor = (body, callId) => {
      const found = body.input.filter(
        (item) =>
          ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
          item.call_id === callId
      );
      if (found.length !== 1) throw fail();
      return found[0].output;
    };
    const response = (body, text, call, compact = false) => {
      if (body.stream === true) streams++;
      else json++;
      return syntheticCodexWire({
        model: options.model,
        sequence: requests,
        text,
        call,
        compact,
        stream: body.stream === true,
      });
    };
    const call = (body, name, args) => {
      pending = { id: 'call_fixture_' + requests, name, args };
      return response(body, null, pending);
    };
    return Object.freeze({
      setPhase(value) {
        return guarded(() => {
          if (typeof value !== 'string' || phases[phase + 1] !== value || !complete) throw fail();
          phase++;
          complete = false;
          privateSummary = false;
        });
      },
      respond(inputRequest) {
        return guarded(() => {
          const request = normalizeCompactionData(inputRequest, 2 * 1024 * 1024);
          if (
            !request ||
            Array.isArray(request) ||
            Object.keys(request).sort().join(',') !== 'body,path' ||
            !['/v1/responses', '/v1/responses/compact'].includes(request.path) ||
            phase < 0 ||
            complete ||
            requests >= 24
          )
            throw fail();
          const { body } = request;
          if (
            !body ||
            Array.isArray(body) ||
            body.model !== options.model ||
            !Array.isArray(body.input) ||
            !body.input.length ||
            !body.input.every((item) => item && typeof item === 'object' && !Array.isArray(item)) ||
            (body.tools !== undefined && !Array.isArray(body.tools))
          )
            throw fail();
          const fingerprint = hash(phase + ':' + JSON.stringify(request));
          if (seen.has(fingerprint)) throw fail();
          seen.add(fingerprint);
          requests++;
          const names = (body.tools ?? []).map((tool) => tool?.name ?? tool?.function?.name);
          const privateTools = names.includes(LIST) && names.includes(READ);
          if (
            names.includes(LIST) !== names.includes(READ) ||
            names.filter((name) => name === LIST).length > 1 ||
            names.filter((name) => name === READ).length > 1 ||
            (options.mode === 'default' && privateText(body))
          )
            throw fail();
          if (request.path.endsWith('/compact')) {
            if (
              phase < 1 ||
              phase > 3 ||
              (body.stream != null && body.stream !== false) ||
              (body.store != null && body.store !== false) ||
              body.context_management != null ||
              body.previous_response_id != null ||
              body.conversation != null ||
              privateText(body)
            )
              throw fail();
            compactions++;
            complete = true;
            return response({ ...body, stream: false }, null, null, true);
          }
          if (typeof body.stream !== 'boolean' || (!privateTools && body.stream !== true))
            throw fail();
          if (phase === 0) {
            if (seedState === 0) {
              if (privateTools || !names.includes(ORIGINAL)) throw fail();
              seedState++;
              return call(body, ORIGINAL, {});
            }
            if (pending.name !== ORIGINAL || (!privateTools && privateText(body))) throw fail();
            const observed = originalCodexWire(outputFor(body, pending.id), options.original);
            if (seedState === 1) {
              originalWire = observed;
              seedState++;
              if (privateTools) {
                privateSeed = true;
                return response(body, SENTINEL + ' ' + LIST + ' ' + READ);
              }
            } else if (seedState !== 2 || !privateSeed || privateTools || observed !== originalWire)
              throw fail();
            privateSeed = false;
            complete = true;
            return response(body, 'READY');
          }
          if (phase < 4) {
            if (
              !isCodexSummaryRequest({
                ...body,
                tools: (body.tools ?? []).filter((tool) => ![LIST, READ].includes(tool.name)),
              })
            )
              throw fail();
            const summary =
              'Synthetic handoff: retain the completed original evidence pointer; recover it on demand.';
            if (privateTools) {
              if (privateSummary) throw fail();
              privateSummary = true;
              return response(body, summary + ' ' + SENTINEL + ' ' + LIST + ' ' + READ);
            }
            if (privateText(body)) throw fail();
            summaries++;
            complete = true;
            return response(body, summary);
          }
          if (options.mode === 'default') {
            complete = true;
            return response(body, 'DONE');
          }
          if (!privateTools) {
            if (finalState !== 3 || privateText(body)) throw fail();
            publicEvidence(body, originalWire);
            publicVerified = true;
            complete = true;
            return response(body, options.marker);
          }
          if (finalState === 0) {
            finalState = 1;
            return call(body, LIST, {});
          }
          const reply = outputFor(body, pending.id);
          if (typeof reply !== 'string') throw fail();
          const value = JSON.parse(reply);
          if (JSON.stringify(value) !== reply) throw fail();
          if (finalState === 1) {
            source = retainedSource(value, originalWire);
            finalState = 2;
          } else if (finalState === 2) {
            const page = retainedPage(value, source, pending.args, originalWire, offset);
            offset = page.endOffsetBytes;
            readPages++;
            if (page.nextOffsetBytes === null) {
              exactRead = true;
              finalState = 3;
              return response(body, SENTINEL + ' ' + LIST + ' ' + READ);
            }
          } else throw fail();
          return call(body, READ, {
            sourceId: source.sourceId,
            digest: source.digest,
            offsetBytes: offset,
            limitBytes: 65536,
          });
        });
      },
      inspect() {
        return Object.freeze({
          schemaVersion: 1,
          scope: 'synthetic_codex_upstream',
          phase: phase + 1,
          failed,
          requests,
          streams,
          json,
          summaries,
          compactions,
          sourceCalls: seedState > 0 ? 1 : 0,
          sourceObserved: seedState === 2,
          readPages,
          exactRead,
          publicEvidence: publicVerified,
          completed: phase === 4 && complete && !failed,
          directModelRequests: 0,
          cliQualified: false,
          installedRuntimeQualified: false,
        });
      },
    });
  } catch {
    throw fail();
  }
}

module.exports = { createCodexSyntheticUpstream };
