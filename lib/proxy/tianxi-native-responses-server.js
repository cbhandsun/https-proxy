'use strict';

const http = require('node:http');
const { timingSafeEqual, createHash } = require('node:crypto');
const { createTianxiNativeSession } = require('./tianxi-native-responses-session');
const {
  writeResponsesSseEvent,
  writeTianxiResultCall,
} = require('./tianxi-responses');

function writeResult(res, value, stream) {
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
    return;
  }
  const emit = (type, payload) => writeResponsesSseEvent(res, type, { type, ...payload });
  const base = { ...value, status: 'in_progress', output: [], output_text: '', error: null };
  emit('response.created', { response: base });
  emit('response.in_progress', { response: base });
  const state = { id: value.id, outputIndex: 0 };
  for (const item of value.output) {
    if (['function_call', 'custom_tool_call'].includes(item.type))
      writeTianxiResultCall(res, state, item);
    else if (item.type === 'compaction') {
      const output_index = state.outputIndex++;
      emit('response.output_item.added', {
        response_id: value.id,
        output_index,
        item,
      });
      emit('response.output_item.done', {
        response_id: value.id,
        output_index,
        item,
      });
    } else {
      const meta = {
        response_id: value.id,
        item_id: item.id,
        output_index: state.outputIndex++,
        content_index: 0,
      };
      emit('response.output_item.added', {
        response_id: value.id,
        output_index: meta.output_index,
        item: { ...item, status: 'in_progress', content: [] },
      });
      emit('response.content_part.added', { ...meta, part: { ...item.content[0], text: '' } });
      emit('response.output_text.delta', { ...meta, delta: item.content[0].text, logprobs: [] });
      emit('response.output_text.done', { ...meta, text: item.content[0].text, logprobs: [] });
      emit('response.content_part.done', { ...meta, part: item.content[0] });
      emit('response.output_item.done', {
        response_id: value.id,
        output_index: meta.output_index,
        item,
      });
    }
  }
  emit('response.' + value.status, { response: value });
  res.end('data: [DONE]\n\n');
}
function createTianxiNativeProbeServer({ token, model, run, onCall, onOutput }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || typeof model !== 'string')
    throw new Error('tianxi_native_server_invalid');
  let session,
    requests = 0,
    closing;
  const outputShapes = [],
    failureCodes = [],
    contextShapes = [],
    initialContext = new Set();
  const expected = Buffer.from('Bearer ' + token);
  const server = http.createServer(async (req, res) => {
    const authorization =
      typeof req.headers.authorization === 'string'
        ? Buffer.from(req.headers.authorization)
        : Buffer.alloc(0);
    if (
      authorization.length !== expected.length ||
      !timingSafeEqual(authorization, expected) ||
      req.headers.origin
    ) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('body_limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || body.model !== model || typeof body.stream !== 'boolean')
        throw new Error('model_invalid');
      requests++;
      if (requests > 40) throw new Error('request_limit');
      for (const item of Array.isArray(body.input) ? body.input : []) {
        if (item?.role === 'developer' && contextShapes.length < 128) {
          const parts =
            typeof item.content === 'string'
              ? [item.content]
              : Array.isArray(item.content)
                ? item.content
                    .map((part) => part?.text)
                    .filter((value) => typeof value === 'string')
                : [];
          const value = parts.join('\n');
          const digest = createHash('sha256').update(value).digest('hex');
          if (requests === 1) initialContext.add(digest);
          contextShapes.push({
            request: requests,
            type: item.type === 'additional_tools' ? 'additional_tools' : 'message',
            parts: parts.length,
            chars: value.length,
            matchesFirst: initialContext.has(digest),
            knownTerms: [
              'permissions',
              'read-only',
              'workspace-write',
              'sandbox',
              'tools',
              'exec',
              'reminder',
              'loaded',
              'approval',
            ].filter((term) => value.includes(term)),
            partTypes: Array.isArray(item.content)
              ? item.content.map((part) =>
                  ['input_text', 'output_text', 'text'].includes(part?.type) ? part.type : 'other'
                )
              : [],
            knownTags: [
              'current_time',
              'environment_context',
              'permissions',
              'turn_metadata',
              'session_context',
              'tool_instructions',
              'budget',
              'token_budget',
              'time_budget',
            ].filter((tag) => value.includes('<' + tag)),
          });
        }
        if (
          outputShapes.length < 128 &&
          ['function_call_output', 'custom_tool_call_output'].includes(item?.type)
        )
          outputShapes.push({
            type: item.type,
            outputType: typeof item.output,
            array: Array.isArray(item.output),
            textParts: Array.isArray(item.output)
              ? item.output.filter((part) => part?.type === 'input_text').length
              : 0,
          });
      }
      const first = !session;
      if (first)
        session = createTianxiNativeSession({
          body,
          owner: token,
          ...(run ? { run } : {}),
          onCall,
          onOutput,
        });
      const close = () => {
        if (!res.writableEnded) session.cancel();
      };
      res.once('close', close);
      const value = first
        ? await session.next()
        : await session.resume(body.input, token, body.model);
      if (value.error && failureCodes.length < 40) failureCodes.push(value.error.code);
      res.removeListener('close', close);
      if (body.stream && !res.destroyed) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      }
      if (!res.destroyed) writeResult(res, value, body.stream);
    } catch (error) {
      const code =
        error instanceof Error
          ? Object.getOwnPropertyDescriptor(error, 'message')?.value
          : undefined;
      const allowed = [
        'tianxi_native_history_unsupported',
        'tianxi_native_history_call_invalid',
        'tianxi_native_developer_history_unsupported',
        'tianxi_native_tool_history_unsupported',
        'tianxi_native_output_invalid',
        'tianxi_native_owner_mismatch',
        'tianxi_native_new_turn_unsupported',
      ];
      if (failureCodes.length < 40)
        failureCodes.push(allowed.includes(code) ? code : 'tianxi_native_request_invalid');
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"tianxi_native_request_invalid"}}');
      } else res.destroy();
    }
  });
  server.requestTimeout = 150000;
  return {
    server,
    get requests() {
      return requests;
    },
    get outputShapes() {
      return outputShapes;
    },
    get failureCodes() {
      return failureCodes;
    },
    get contextShapes() {
      return contextShapes;
    },
    close() {
      closing ??= (async () => {
        const stopped = new Promise((resolve) => server.close(resolve));
        // Closing this isolated probe cancels every outstanding request. Idle
        // cleanup alone can leave a client connection holding teardown open.
        server.closeAllConnections();
        session?.cancel();
        await session?.done;
        await stopped;
      })();
      return closing;
    },
  };
}

module.exports = { createTianxiNativeProbeServer, writeResult };
