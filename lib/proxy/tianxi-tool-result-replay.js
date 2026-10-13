'use strict';

const { randomUUID } = require('node:crypto');
const { writeResponsesSseEvent, writeTianxiResultCall } = require('./tianxi-responses');
const { isTianxiFinalResponse } = require('./tianxi-tool-result-cache');
const { isTianxiResultCall } = require('./tianxi-tool-result-continuation');

function unavailableTianxiResultResponse(status, model) {
  if (
    !['canceled', 'failed', 'incomplete', 'completed'].includes(status) ||
    typeof model !== 'string' ||
    model.length === 0 ||
    model.length > 256 ||
    Array.from(model).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new TypeError('Invalid Tianxi result termination');
  return {
    id: 'resp_' + randomUUID().replace(/-/g, ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'failed',
    output: [],
    output_text: '',
    error: {
      // A terminal local result cannot recover through transport retries.
      code: 'invalid_prompt',
      message:
        status === 'canceled'
          ? 'The previous Tianxi request disconnected before its final result was retained. Start a new request to retry.'
          : 'The previous Tianxi request has ended, but its final result is unavailable. Start a new request to retry.',
    },
    incomplete_details: null,
    usage: null,
  };
}

function replayTianxiResultCall(response, call, clientRes, stream) {
  if (!isTianxiFinalResponse(response) || !isTianxiResultCall(call))
    throw new TypeError('Invalid cached Tianxi result call');
  const id = 'resp_' + randomUUID().replace(/-/g, '');
  const replay = {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: response.model,
    status: 'completed',
    output: [call],
    output_text: '',
    parallel_tool_calls: false,
    error: null,
    incomplete_details: null,
    usage: null,
  };
  if (!stream) return replay;
  if (!clientRes.headersSent)
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
  for (const type of ['response.created', 'response.in_progress'])
    writeResponsesSseEvent(clientRes, type, {
      type,
      response: { ...replay, status: 'in_progress', output: [] },
    });
  writeTianxiResultCall(clientRes, { id, outputIndex: 0 }, call);
  writeResponsesSseEvent(clientRes, 'response.completed', {
    type: 'response.completed',
    response: replay,
  });
  clientRes.write('data: [DONE]\n\n');
  clientRes.end();
  return replay;
}

function replayTianxiResult(response, clientRes, stream) {
  if (!isTianxiFinalResponse(response)) throw new TypeError('Invalid cached Tianxi response');
  const id = 'resp_' + randomUUID().replace(/-/g, '');
  const replay = {
    ...response,
    id,
    created_at: Math.floor(Date.now() / 1000),
    output: response.output.map((item, index) => ({ ...item, id: 'msg_' + id + '_' + index })),
    output_text: response.output
      .flatMap((item) => item.content)
      .map((part) => part.text)
      .join(''),
  };
  if (!stream) return replay;
  if (!clientRes.headersSent)
    clientRes.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
  for (const type of ['response.created', 'response.in_progress']) {
    writeResponsesSseEvent(clientRes, type, {
      type,
      response: {
        ...replay,
        status: 'in_progress',
        output: [],
        output_text: '',
        error: null,
        incomplete_details: null,
        usage: null,
      },
    });
  }
  replay.output.forEach((item, output_index) => {
    const meta = { response_id: id, item_id: item.id, output_index };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: id,
      output_index,
      item: { ...item, status: 'in_progress', content: [] },
    });
    item.content.forEach((part, content_index) => {
      const contentMeta = { ...meta, content_index };
      writeResponsesSseEvent(clientRes, 'response.content_part.added', {
        type: 'response.content_part.added',
        ...contentMeta,
        part: { ...part, text: '' },
      });
      writeResponsesSseEvent(clientRes, 'response.output_text.delta', {
        type: 'response.output_text.delta',
        ...contentMeta,
        delta: part.text,
        logprobs: [],
      });
      writeResponsesSseEvent(clientRes, 'response.output_text.done', {
        type: 'response.output_text.done',
        ...contentMeta,
        text: part.text,
        logprobs: [],
      });
      writeResponsesSseEvent(clientRes, 'response.content_part.done', {
        type: 'response.content_part.done',
        ...contentMeta,
        part,
      });
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: id,
      output_index,
      item,
    });
  });
  const type = 'response.' + replay.status;
  writeResponsesSseEvent(clientRes, type, { type, response: replay });
  clientRes.write('data: [DONE]\n\n');
  clientRes.end();
  return replay;
}

module.exports = { replayTianxiResult, replayTianxiResultCall, unavailableTianxiResultResponse };
