'use strict';
const { toolArgumentsComplete, writeIncompleteToolCall } = require('./protocol-tool-completion');
const { chatIncompleteReason } = require('./protocol-terminal');
const { assertJsonObjectCompletion } = require('./json-object-output-contract');
const { prepareToolCall, writeCustomToolCallResponsesEvents } = require('./responses-custom-tools');

function createResponsesStreamEmitter({
  fallbackId,
  resolveToolNameInference,
  responsesFunctionCallItemId,
  responsesFunctionCallCallId,
  streamBudget,
  boundOutput = false,
}) {
  const outputBudgetState = {};
  let failureOutput = false;
  function writeResponsesSseEvent(clientRes, eventName, payload) {
    const wire = 'event: ' + eventName + '\ndata: ' + JSON.stringify(payload) + '\n\n';
    if (boundOutput && !failureOutput) streamBudget.consume(outputBudgetState, wire);
    clientRes.write(wire);
  }

  function ensureResponsesStreamStarted(clientRes, state) {
    if (state.started) return;
    state.started = true;
    writeResponsesSseEvent(clientRes, 'response.created', {
      type: 'response.created',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: 'in_progress',
        model: state.model,
        output: [],
      },
    });
    writeResponsesSseEvent(clientRes, 'response.in_progress', {
      type: 'response.in_progress',
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: 'in_progress',
        model: state.model,
        output: [],
      },
    });
  }

  function ensureResponsesReasoningItem(clientRes, state) {
    ensureResponsesStreamStarted(clientRes, state);
    if (state.reasoningItemStarted) return;
    state.reasoningItemStarted = true;
    state.reasoningItemDone = false;
    state.reasoningId =
      state.reasoningId ||
      fallbackId('rsn', { response: state.id, model: state.model, outputIndex: state.outputIndex });
    state.reasoningText = '';
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item: {
        id: state.reasoningId,
        type: 'reasoning',
        status: 'in_progress',
        content: [],
      },
    });
  }

  function finishResponsesReasoningItem(clientRes, state) {
    if (!state.reasoningItemStarted || state.reasoningItemDone) return;
    state.reasoningItemDone = true;
    const completedItem = {
      id: state.reasoningId,
      type: 'reasoning',
      status: 'completed',
      summary: state.reasoningText || '',
    };
    writeResponsesSseEvent(clientRes, 'response.reasoning.done', {
      type: 'response.reasoning.done',
      response_id: state.id,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      text: state.reasoningText || '',
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: completedItem,
    });
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.outputIndex += 1;
    state.reasoningId = null;
    state.reasoningItemStarted = false;
    state.reasoningItemDone = false;
    state.reasoningText = '';
  }

  function ensureResponsesTextItem(clientRes, state) {
    ensureResponsesStreamStarted(clientRes, state);
    if (state.textItemStarted) return;
    state.textItemStarted = true;
    state.textItemDone = false;
    state.messageId =
      state.messageId ||
      fallbackId('msg', { response: state.id, model: state.model, outputIndex: state.outputIndex });
    state.text = '';
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item: {
        id: state.messageId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    writeResponsesSseEvent(clientRes, 'response.content_part.added', {
      type: 'response.content_part.added',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      part:
        state.textKind === 'refusal'
          ? { type: 'refusal', refusal: '' }
          : { type: 'output_text', text: '', annotations: [] },
    });
  }

  function finishResponsesTextItem(clientRes, state) {
    if (!state.textItemStarted || state.textItemDone) return;
    state.textItemDone = true;
    const refused = state.textKind === 'refusal';
    const part = refused
      ? { type: 'refusal', refusal: state.text || '' }
      : { type: 'output_text', text: state.text || '', annotations: [] };
    const completedItem = {
      id: state.messageId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [part],
    };
    const doneType = refused ? 'response.refusal.done' : 'response.output_text.done';
    writeResponsesSseEvent(clientRes, doneType, {
      type: doneType,
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      ...(refused ? { refusal: state.text || '' } : { text: state.text || '' }),
    });
    writeResponsesSseEvent(clientRes, 'response.content_part.done', {
      type: 'response.content_part.done',
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      part,
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: completedItem,
    });
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.outputIndex += 1;
    state.messageId = null;
    state.textItemStarted = false;
    state.textItemDone = false;
    state.text = '';
  }

  function emitResponsesToolCall(clientRes, state, toolCall, incomplete = false) {
    ensureResponsesStreamStarted(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    const prepared = prepareToolCall(toolCall, resolveToolNameInference, {
      index: state.outputIndex,
    });
    if (!prepared) return;
    const { args, parsedArgs, name, seed } = prepared;
    if (!incomplete && !toolArgumentsComplete(toolCall, state.customToolNames)) {
      failResponsesStream(clientRes, state, 'upstream_stream_invalid_tool_arguments');
      return;
    }
    if (incomplete) {
      writeIncompleteToolCall({
        clientRes,
        state,
        prepared,
        toolCall,
        itemId: fallbackId(state.customToolNames?.has(name) ? 'ctc' : 'fc', seed),
        callId: responsesFunctionCallCallId(toolCall.id, seed),
        writeEvent: writeResponsesSseEvent,
      });
      return;
    }
    if (
      writeCustomToolCallResponsesEvents({
        clientRes,
        state,
        toolCall,
        name,
        args,
        parsedArgs,
        seed,
        fallbackId,
        callId: responsesFunctionCallCallId(toolCall.id, seed),
        writeEvent: writeResponsesSseEvent,
      })
    ) {
      return;
    }
    const itemId = responsesFunctionCallItemId(toolCall.id, seed);
    const callId = responsesFunctionCallCallId(toolCall.id, seed);
    const item = {
      id: itemId,
      type: 'function_call',
      status: 'in_progress',
      call_id: callId,
      name,
      arguments: '',
    };
    writeResponsesSseEvent(clientRes, 'response.output_item.added', {
      type: 'response.output_item.added',
      response_id: state.id,
      output_index: state.outputIndex,
      item,
    });
    if (args) {
      writeResponsesSseEvent(clientRes, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        response_id: state.id,
        item_id: itemId,
        output_index: state.outputIndex,
        delta: args,
      });
    }
    writeResponsesSseEvent(clientRes, 'response.function_call_arguments.done', {
      type: 'response.function_call_arguments.done',
      response_id: state.id,
      item_id: itemId,
      output_index: state.outputIndex,
      arguments: args || '{}',
    });
    writeResponsesSseEvent(clientRes, 'response.output_item.done', {
      type: 'response.output_item.done',
      response_id: state.id,
      output_index: state.outputIndex,
      item: { ...item, status: 'completed', arguments: args || '{}' },
    });
    const completedItem = { ...item, status: 'completed', arguments: args || '{}' };
    if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
    state.completedOutputItems.push(completedItem);
    state.toolCalls.push(completedItem);
    state.outputIndex += 1;
  }

  function bufferResponsesToolCallDelta(state, toolCall) {
    if (!toolCall) return;
    const index = toolCall.index != null ? toolCall.index : 0;
    if (!state.pendingToolCalls[index]) {
      streamBudget.addTool(state);
      state.pendingToolCalls[index] = {
        index,
        id: null,
        type: 'function',
        function: { name: '', arguments: '' },
      };
    }
    const pending = state.pendingToolCalls[index];
    if (toolCall.id) pending.id = toolCall.id;
    if (toolCall.type) pending.type = toolCall.type;
    const fn = toolCall.function || {};
    if (fn.name) pending.function.name = fn.name;
    if (fn.arguments != null)
      pending.function.arguments = streamBudget.appendArguments(pending.function, fn.arguments);
  }

  function flushResponsesToolCalls(clientRes, state, incomplete = false) {
    if (!Array.isArray(state.pendingToolCalls)) return;
    for (const pending of state.pendingToolCalls) {
      if (!pending || pending.flushed) continue;
      emitResponsesToolCall(clientRes, state, pending, incomplete);
      if (state.done) return;
      pending.flushed = true;
    }
    state.pendingToolCalls = [];
  }

  function failResponsesStream(clientRes, state, code) {
    if (state.done) return;
    if (boundOutput) failureOutput = true;
    ensureResponsesStreamStarted(clientRes, state);
    state.pendingToolCalls = [];
    finishResponsesReasoningItem(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    state.done = true;
    state.failed = true;
    state.failure = {
      code,
      message: boundOutput
        ? 'Upstream response could not be completed safely'
        : 'Upstream Chat stream could not be completed safely',
    };
    writeResponsesSseEvent(clientRes, 'response.failed', {
      type: 'response.failed',
      response: {
        id: state.id,
        object: 'response',
        status: 'failed',
        model: state.model,
        error: state.failure,
        output: Array.isArray(state.completedOutputItems) ? state.completedOutputItems : [],
        usage: state.usage,
      },
    });
  }

  function finishResponsesStream(clientRes, state) {
    if (state.done) return;
    ensureResponsesStreamStarted(clientRes, state);
    flushResponsesToolCalls(clientRes, state, Boolean(chatIncompleteReason(state.finishReason)));
    if (state.done) return;
    finishResponsesReasoningItem(clientRes, state);
    finishResponsesTextItem(clientRes, state);
    const output = Array.isArray(state.completedOutputItems) ? state.completedOutputItems : [];
    const reason = chatIncompleteReason(state.finishReason);
    if (state.jsonObjectOutput && !reason) {
      try {
        assertJsonObjectCompletion({ status: 'completed', output }, 'responses', {
          text: { format: { type: 'json_object' } },
        });
      } catch (error) {
        if (error.code !== 'upstream_invalid_json_object') throw error;
        failResponsesStream(clientRes, state, error.code);
        return;
      }
    }
    const terminalType = reason ? 'response.incomplete' : 'response.completed';
    writeResponsesSseEvent(clientRes, terminalType, {
      type: terminalType,
      response: {
        id: state.id,
        object: 'response',
        created_at: state.created_at,
        status: reason ? 'incomplete' : 'completed',
        ...(reason ? { incomplete_details: { reason } } : {}),
        model: state.model,
        output,
        usage: state.usage,
      },
    });
    clientRes.write('data: [DONE]\n\n');
    state.done = true;
  }

  function appendText(clientRes, state, value, kind) {
    if (state.done || !value) return;
    if (state.textItemStarted && state.textKind !== kind) finishResponsesTextItem(clientRes, state);
    state.textKind = kind;
    finishResponsesReasoningItem(clientRes, state);
    flushResponsesToolCalls(clientRes, state);
    if (state.done) return;
    ensureResponsesTextItem(clientRes, state);
    state.text = (state.text || '') + value;
    const deltaType = kind === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta';
    writeResponsesSseEvent(clientRes, deltaType, {
      type: deltaType,
      response_id: state.id,
      item_id: state.messageId,
      output_index: state.outputIndex,
      content_index: 0,
      delta: value,
    });
  }
  function reasoning(clientRes, state, value) {
    if (state.done || !value) return;
    flushResponsesToolCalls(clientRes, state);
    if (state.done) return;
    ensureResponsesReasoningItem(clientRes, state);
    state.reasoningText = (state.reasoningText || '') + value;
    writeResponsesSseEvent(clientRes, 'response.reasoning.delta', {
      type: 'response.reasoning.delta',
      response_id: state.id,
      item_id: state.reasoningId,
      output_index: state.outputIndex,
      delta: value,
    });
  }
  return {
    text: (clientRes, state, value) => appendText(clientRes, state, value, 'output_text'),
    refusal: (clientRes, state, value) => appendText(clientRes, state, value, 'refusal'),
    reasoning,
    finishResponsesStream,
    failResponsesStream,
    finishResponsesReasoningItem,
    finishResponsesTextItem,
    bufferResponsesToolCallDelta,
    flushResponsesToolCalls,
  };
}
module.exports = { createResponsesStreamEmitter };
