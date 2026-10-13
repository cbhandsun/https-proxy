'use strict';

const http = require('node:http');
const { inspectNativeCheckpointReuse } = require('./native-checkpoint-reuse');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { createNativeEvidenceV2Response } = require('./native-evidence-v2-response');
const { nativeEvidenceV2Options } = require('./native-evidence-v2-options');

function createNativeEvidenceV2Gateway(input) {
  const { report, workload, budget, upstreamPort, ingressKey, testKey, prefix, onFailure } =
    nativeEvidenceV2Options(input, [
      'report',
      'workload',
      'budget',
      'upstreamPort',
      'ingressKey',
      'testKey',
      'prefix',
      'onFailure',
    ]);
  if (
    !Number.isSafeInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535 ||
    typeof ingressKey !== 'string' ||
    !/^[a-f0-9]{48}$/.test(ingressKey) ||
    typeof testKey !== 'string' ||
    !/^[a-f0-9]{48}$/.test(testKey) ||
    typeof prefix !== 'string' ||
    !/^hpm-v2-[a-f0-9]{12}$/.test(prefix) ||
    typeof onFailure !== 'function'
  )
    throw new TypeError('Invalid native gateway');
  if (
    !Array.isArray(report?.transport) ||
    !Array.isArray(report.compactionChainReuseChecks) ||
    typeof report.model !== 'string' ||
    typeof workload?.inspectInput !== 'function' ||
    typeof workload.inspectReadbackInput !== 'function' ||
    typeof budget?.admit !== 'function'
  )
    throw new TypeError('Invalid native gateway capabilities');
  let checkpoint = null;
  let everyCheckpointItemEqual = true;
  let stopped = false;
  const noteFailure = (code) => {
    stopped = true;
    onFailure(code);
  };
  const evidence = new Set();
  const server = http.createServer((req, res) => {
    const refuse = (status, code) => {
      noteFailure(code);
      req.resume();
      res.writeHead(status, { connection: 'close' });
      res.end();
    };
    if (stopped) {
      req.resume();
      res.writeHead(503, { connection: 'close' });
      res.end();
      return;
    }
    if (
      req.method !== 'POST' ||
      req.socket.remoteAddress !== '127.0.0.1' ||
      Object.hasOwn(req.headers, 'origin') ||
      req.headers.authorization !== 'Bearer ' + testKey ||
      !['/backend-api/codex/responses', '/backend-api/codex/responses/compact'].includes(req.url)
    )
      return refuse(403, 'native_v2_ingress_refused');
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        oversized = true;
        noteFailure('native_v2_request_too_large');
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('error', () => noteFailure('native_v2_ingress_failed'));
    req.on('end', () => {
      if (oversized) return;
      if (stopped) {
        res.writeHead(503);
        res.end();
        return;
      }
      const buffer = Buffer.concat(chunks);
      let body;
      try {
        body = normalizeCompactionData(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)),
          2 * 1024 * 1024
        );
      } catch {
        return refuse(400, 'native_v2_request_invalid');
      }
      if (body?.model !== report.model || !Array.isArray(body.input))
        return refuse(409, 'native_v2_model_or_input_refused');
      if (!budget.admit().ok) return refuse(429, 'native_v2_request_limit');
      const compact =
        req.url.endsWith('/compact') ||
        body.input.some((item) => item?.type === 'compaction_trigger');
      const outputs = body.input.filter((item) =>
        ['function_call_output', 'custom_tool_call_output'].includes(item?.type)
      );
      const row = {
        compact,
        standalone: req.url.endsWith('/compact'),
        requestBytes: bytes,
        inputItems: body.input.length,
        toolOutputBytes: outputs.reduce(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item.output ?? '')),
          0
        ),
        exactToolEvidence: workload.inspectInput(body.input),
        exactRetainedEvidence: workload.inspectReadbackInput(body.input),
        maxRetainedPagesPerCodeModeOutput: Math.max(
          0,
          ...outputs
            .filter((item) => item.type === 'custom_tool_call_output')
            .map(
              (item) =>
                workload.inspectReadbackInput([item]).filter((receipt) => receipt.observed).length
            )
        ),
        status: null,
        responseCompletedEvents: 0,
        responseFailedEvents: 0,
      };
      for (const receipt of row.exactToolEvidence)
        if (receipt.observed) evidence.add(receipt.index);
      if (checkpoint) {
        const observation = inspectNativeCheckpointReuse(body.input, checkpoint);
        row.checkpointReuse = observation;
        report.nativeCheckpointReused ||= observation.opaqueReused;
        if (compact) report.compactionChainReuseChecks.push(observation.opaqueReused);
        everyCheckpointItemEqual &&= observation.exactItemEqual;
        report.nativeCheckpointItemEqual = everyCheckpointItemEqual;
        report.checkpointChangedFieldNames = [
          ...new Set([
            ...(report.checkpointChangedFieldNames ?? []),
            ...observation.changedKnownFields,
          ]),
        ];
      }
      report.transport.push(row);
      report.realProviderRequests = true;
      const headers = {
        ...req.headers,
        authorization: 'Bearer ' + ingressKey,
        host: '127.0.0.1:' + upstreamPort,
        'content-length': buffer.length,
        'x-request-id': prefix + '-' + report.transport.length,
      };
      delete headers['transfer-encoding'];
      delete headers.connection;
      const forwarded = http.request(
        {
          hostname: '127.0.0.1',
          port: upstreamPort,
          method: 'POST',
          path: req.url,
          headers,
          agent: false,
        },
        (upstream) => {
          row.status = upstream.statusCode;
          const contentType = upstream.headers['content-type'];
          row.responseMediaType =
            typeof contentType === 'string' && /^text\/event-stream(?:;|$)/i.test(contentType)
              ? 'event-stream'
              : typeof contentType === 'string' && /^application\/json(?:;|$)/i.test(contentType)
                ? 'json'
                : 'other-or-missing';
          const encoding = upstream.headers['content-encoding'] ?? 'identity';
          row.responseEncoding = ['identity', 'gzip', 'deflate', 'br'].includes(encoding)
            ? encoding
            : 'other';
          const observer = createNativeEvidenceV2Response({
            compact,
            standalone: row.standalone,
            status: upstream.statusCode,
          });
          let terminal = false;
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.on('data', (chunk) => {
            try {
              observer.push(chunk);
              res.write(chunk);
            } catch {
              Object.assign(row, observer.inspect());
              noteFailure('native_v2_stream_invalid');
              upstream.destroy();
              res.destroy();
            }
          });
          upstream.on('end', () => {
            try {
              Object.assign(row, observer.finish());
              terminal = true;
              if (row.validNativeWindow && observer.getCheckpoint()) {
                checkpoint = observer.getCheckpoint();
                report.nativeCompactionCycles++;
              }
              if (
                row.status !== 200 ||
                row.responseFailedEvents > 0 ||
                (!row.standalone && row.responseCompletedEvents !== 1)
              )
                noteFailure('native_v2_upstream_terminal_failed');
              res.end();
            } catch {
              Object.assign(row, observer.inspect());
              noteFailure('native_v2_stream_invalid');
              res.destroy();
            }
          });
          upstream.on('error', () => {
            noteFailure('native_v2_upstream_failed');
            res.destroy();
          });
          upstream.on('close', () => {
            if (!terminal) noteFailure('native_v2_upstream_incomplete');
          });
        }
      );
      forwarded.setTimeout(90000, () => forwarded.destroy());
      forwarded.on('error', () => {
        noteFailure('native_v2_forward_failed');
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.once('close', () => {
        if (!res.writableEnded) forwarded.destroy();
      });
      forwarded.end(buffer); // Native body is forwarded byte-for-byte, without field injection.
    });
  });
  return { server, inspect: () => ({ exactEvidenceInputReplies: evidence.size }) };
}

module.exports = { createNativeEvidenceV2Gateway };
