'use strict';
const { randomUUID } = require('node:crypto');
const { sdkModel } = require('./tianxi-sdk-models');
function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length > 1024) throw new Error('tianxi_sdk_input_invalid');
  return content
    .map((b) => {
      if (
        !b ||
        !['text', 'input_text', 'output_text'].includes(b.type) ||
        typeof b.text !== 'string'
      )
        throw new Error('tianxi_sdk_input_invalid');
      return b.text;
    })
    .join('\n');
}
function parseSdkInput(payload) {
  const modelId = payload?.metadata?.tianxi?.sdk_model;
  if (!sdkModel(modelId)) throw new Error('tianxi_sdk_model_invalid');
  let prompt;
  if (typeof payload.input === 'string') prompt = payload.input;
  else if (Array.isArray(payload.input) && payload.input.length <= 256)
    prompt = payload.input
      .map((m) => {
        if (
          !m ||
          !['user', 'assistant', 'system', 'developer'].includes(m.role) ||
          (m.type && m.type !== 'message')
        )
          throw new Error('tianxi_sdk_input_invalid');
        const text = textContent(m.content);
        if (!text.trim()) throw new Error('tianxi_sdk_input_invalid');
        return `[${m.role}]\n${text}`;
      })
      .join('\n\n');
  else throw new Error('tianxi_sdk_input_invalid');
  const instructions = payload.instructions === undefined ? '' : payload.instructions;
  if (
    !prompt.trim() ||
    prompt.length > 128000 ||
    typeof instructions !== 'string' ||
    instructions.length > 32768 ||
    prompt.includes('\0') ||
    instructions.includes('\0')
  )
    throw new Error('tianxi_sdk_input_invalid');
  return { modelId, prompt, instructions };
}
function createSdkProtocol({
  modelId,
  prompt,
  instructions,
  token,
  sameAccount,
  workerArgs,
  cwd,
  uuid = randomUUID,
  maxAuthRequests = 4,
  allowExtendedLimits = false,
}) {
  const model = sdkModel(modelId);
  if (
    !model ||
    typeof token !== 'string' ||
    !/^sat-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
    token.length > 16384
  )
    throw new Error('tianxi_sdk_auth_invalid');
  const daemonId = uuid(),
    openId = uuid(),
    initId = uuid();
  let stage = 'daemon',
    sessionId,
    output = '',
    delta = false,
    done = false,
    authRequests = 0;
  const control = (id, request, session) => ({
    type: 'control_request',
    request_id: id,
    ...(session ? { session_id: session } : {}),
    request,
  });
  function observe(name) {
    if (
      name !== undefined &&
      (typeof name !== 'string' ||
        (!allowExtendedLimits && modelId !== 'auto' && name !== modelId && name !== model.name))
    )
      throw new Error('tianxi_sdk_model_mismatch');
  }
  function accept(v) {
    const outbound = [],
      frames = [];
    if (done) return { outbound, frames, done };
    if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.type !== 'string')
      throw new Error('tianxi_sdk_frame_invalid');
    if (
      v.session_id !== undefined &&
      (typeof v.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(v.session_id))
    )
      throw new Error('tianxi_sdk_frame_invalid');
    if (v.session_id && sessionId && v.session_id !== sessionId)
      throw new Error('tianxi_sdk_session_mismatch');
    const emit = (text) => {
      if (typeof text !== 'string' || output.length + text.length > 1024 * 1024)
        throw new Error('tianxi_sdk_output_limit');
      if (text) {
        output += text;
        frames.push({ type: 'task_output', data: { content_type: 'text', content: text } });
      }
    };
    if (v.type === 'control_request') {
      if (typeof v.request_id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(v.request_id))
        throw new Error('tianxi_sdk_frame_invalid');
      const type = v.request?.type || v.request?.subtype;
      if (
        ['fetch_service_account_token', 'daemon.auth.fetch_service_account_token'].includes(type)
      ) {
        if (++authRequests > maxAuthRequests || !sameAccount())
          throw new Error('tianxi_sdk_account_changed');
        outbound.push({
          type: 'control_response',
          ...(v.session_id ? { session_id: v.session_id } : {}),
          response: { subtype: 'success', request_id: v.request_id, response: { token } },
        });
      } else
        outbound.push({
          type: 'control_response',
          ...(v.session_id ? { session_id: v.session_id } : {}),
          response: {
            subtype: 'error',
            request_id: v.request_id,
            error: 'tianxi_sdk_callback_denied',
          },
        });
    } else if (v.type === 'control_response') {
      const id = v.response?.request_id;
      if (![daemonId, openId, initId].includes(id)) throw new Error('tianxi_sdk_frame_invalid');
      if (v.response?.subtype !== 'success') throw new Error('tianxi_sdk_initialize_failed');
      if (id === daemonId && stage === 'daemon') {
        stage = 'open';
        outbound.push(
          control(openId, { type: 'daemon.open_session', worker_args: workerArgs, cwd })
        );
      } else if (id === openId && stage === 'open') {
        sessionId = v.session_id || v.response.response?.session_id;
        if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))
          throw new Error('tianxi_sdk_session_invalid');
        stage = 'initialize';
        outbound.push(
          control(
            initId,
            {
              type: 'initialize',
              supportsCatalogReadyInitialize: true,
              initializeTimeoutMs: 30000,
              ...(instructions ? { appendSystemPrompt: instructions } : {}),
            },
            sessionId
          )
        );
      } else if (id === initId && stage === 'initialize') {
        stage = 'query';
        if (!sameAccount()) throw new Error('tianxi_sdk_account_changed');
        outbound.push({
          type: 'user',
          session_id: sessionId,
          message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          parent_tool_use_id: null,
        });
      } else throw new Error('tianxi_sdk_frame_invalid');
    } else if (
      v.type === 'status_event' &&
      v.status === 'daemon.session_updated' &&
      v.data?.state === 'failed'
    )
      throw new Error('tianxi_sdk_session_failed');
    else if (v.type === 'system') observe(v.model);
    else if (v.type === 'stream_event') {
      if (stage !== 'query') throw new Error('tianxi_sdk_frame_invalid');
      if (v.event?.type === 'content_block_delta' && v.event.delta?.type === 'text_delta') {
        delta = true;
        emit(v.event.delta.text);
      }
    } else if (v.type === 'assistant') {
      if (stage !== 'query' || v.error) throw new Error('tianxi_sdk_generation_failed');
      observe(v.message?.model);
      const blocks = v.message?.content;
      if (!Array.isArray(blocks) || blocks.length > 1024)
        throw new Error('tianxi_sdk_frame_invalid');
      if (
        blocks.some(
          (b) => !b || typeof b !== 'object' || Array.isArray(b) || typeof b.type !== 'string'
        )
      )
        throw new Error('tianxi_sdk_frame_invalid');
      if (blocks.some((b) => b.type === 'tool_use'))
        throw new Error('tianxi_sdk_tools_unsupported');
      if (!delta) for (const b of blocks) if (b.type === 'text') emit(b.text);
    } else if (v.type === 'result') {
      if (stage !== 'query' || v.subtype !== 'success' || v.is_error === true)
        throw new Error('tianxi_sdk_generation_failed');
      if (
        v.modelUsage !== undefined &&
        (!v.modelUsage || typeof v.modelUsage !== 'object' || Array.isArray(v.modelUsage))
      )
        throw new Error('tianxi_sdk_frame_invalid');
      for (const name of Object.keys(v.modelUsage || {})) observe(name);
      if (!output && typeof v.result === 'string') emit(v.result);
      if (!output.trim() && allowExtendedLimits) emit('Done.');
      if (!output.trim()) throw new Error('tianxi_sdk_output_empty');
      if (!sameAccount()) throw new Error('tianxi_sdk_account_changed');
      done = true;
      frames.push({ type: 'task_status', data: { status: 'COMPLETED' } });
    }
    return { outbound, frames, done };
  }
  return {
    start: () =>
      control(daemonId, {
        type: 'daemon.initialize',
        daemon_protocol_version: 2,
        sdk_version: 'tianxi-proxy/0.1',
        capabilities: ['multi_session_v2'],
        auth: { type: 'serviceAccount', serviceAccountTokenProvider: 'host' },
      }),
    accept,
  };
}
module.exports = { parseSdkInput, createSdkProtocol };
