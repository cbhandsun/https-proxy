'use strict';

function collectCustomToolNamesFromTools(tools, names) {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const type = String(tool.type || '').toLowerCase();
    if (type === 'namespace') {
      collectCustomToolNamesFromTools(tool.tools || tool.functions, names);
    } else if (type === 'custom' && typeof tool.name === 'string' && tool.name) {
      names.add(tool.name);
    }
  }
}

function collectCustomToolNames(request) {
  const names = new Set();
  if (!request || typeof request !== 'object') return names;
  collectCustomToolNamesFromTools(request.tools, names);
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if (item && item.type === 'additional_tools') {
        collectCustomToolNamesFromTools(item.tools, names);
      }
    }
  }
  return names;
}

function hasCustomToolName(source, name) {
  const names = source && source.customToolNames ? source.customToolNames : source;
  if (!name || !names) return false;
  if (typeof names.has === 'function') return names.has(name);
  return Array.isArray(names) && names.includes(name);
}

function customToolInputFromArguments(args, parsedArgs) {
  if (parsedArgs && typeof parsedArgs.input === 'string') return parsedArgs.input;
  if (parsedArgs && typeof parsedArgs.source === 'string') return parsedArgs.source;
  if (parsedArgs && typeof parsedArgs.code === 'string') return parsedArgs.code;
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed.input === 'string') return parsed.input;
    } catch (err) {
      return args;
    }
  }
  return JSON.stringify(parsedArgs || {});
}

function responsesCustomToolCallItemId(sourceId, seed, fallbackId) {
  if (typeof sourceId === 'string' && sourceId.indexOf('ctc_') === 0) return sourceId;
  return fallbackId('ctc', { source_id: sourceId || null, seed });
}

function prepareToolCall(toolCall, inferToolNameFromArguments, seedBase = {}) {
  const fn = (toolCall && toolCall.function) || {};
  const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
  let parsedArgs = {};
  if (typeof args === 'string' && args.trim()) {
    try {
      parsedArgs = JSON.parse(args);
    } catch (err) {}
  }
  const name = fn.name || (toolCall && toolCall.name) || inferToolNameFromArguments(parsedArgs);
  if (!name) return null;
  return { fn, args, parsedArgs, name, seed: { ...seedBase, name, arguments: args } };
}

function createCustomToolCallItem({
  customToolNames,
  sourceId,
  seed,
  fallbackId,
  callId,
  name,
  args,
  parsedArgs,
  status = 'completed',
}) {
  if (!hasCustomToolName(customToolNames, name)) return null;
  return {
    id: responsesCustomToolCallItemId(sourceId, seed, fallbackId),
    type: 'custom_tool_call',
    status,
    call_id: callId,
    name,
    input: customToolInputFromArguments(args, parsedArgs),
  };
}

function appendChatToolCallsAsResponses({
  output,
  toolCalls,
  customToolNames,
  fallbackId,
  inferToolNameFromArguments,
  functionCallItemId,
  functionCallCallId,
}) {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    const prepared = prepareToolCall(call, inferToolNameFromArguments);
    if (!prepared) continue;
    const { args, parsedArgs, name, seed } = prepared;
    const callId = functionCallCallId(call.id, seed);
    const customItem = createCustomToolCallItem({
      customToolNames,
      sourceId: call.id,
      seed,
      fallbackId,
      callId,
      name,
      args,
      parsedArgs,
    });
    output.push(
      customItem || {
        id: functionCallItemId(call.id, seed),
        type: 'function_call',
        call_id: callId,
        name,
        arguments: args || '{}',
      }
    );
  }
}

function writeCustomToolCallResponsesEvents({
  clientRes,
  state,
  toolCall,
  name,
  args,
  parsedArgs,
  seed,
  fallbackId,
  callId,
  writeEvent,
}) {
  if (!hasCustomToolName(state, name)) return false;
  const item = createCustomToolCallItem({
    customToolNames: state,
    sourceId: toolCall.id,
    seed,
    fallbackId,
    callId,
    name,
    args,
    parsedArgs,
    status: 'in_progress',
  });
  const addedItem = { ...item, input: '' };
  writeEvent(clientRes, 'response.output_item.added', {
    type: 'response.output_item.added',
    response_id: state.id,
    output_index: state.outputIndex,
    item: addedItem,
  });
  const completedItem = { ...item, status: 'completed' };
  writeEvent(clientRes, 'response.output_item.done', {
    type: 'response.output_item.done',
    response_id: state.id,
    output_index: state.outputIndex,
    item: completedItem,
  });
  if (!Array.isArray(state.completedOutputItems)) state.completedOutputItems = [];
  state.completedOutputItems.push(completedItem);
  state.toolCalls.push(completedItem);
  state.outputIndex += 1;
  return true;
}

module.exports = {
  appendChatToolCallsAsResponses,
  collectCustomToolNames,
  collectCustomToolNamesFromTools,
  createCustomToolCallItem,
  hasCustomToolName,
  prepareToolCall,
  writeCustomToolCallResponsesEvents,
};
