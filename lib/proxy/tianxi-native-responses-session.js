'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { AbortController } = globalThis;
const {
  createTianxiNativeCatalog,
  snapshot,
  stableJson,
} = require('./tianxi-native-responses-catalog');
const { runTianxiSdkMcpExperiment } = require('./tianxi-sdk-mcp-runtime');
const { tianxiSdkRoutes } = require('./tianxi-sdk-models');
const { buildTianxiUsage } = require('./tianxi-compaction');

const fail = (code) => {
  throw new Error(code);
};
const sha = (s) => createHash('sha256').update(s).digest('hex');
function parseNativeOutput(item, allowHistory = false) {
  let value =
    item.output !== undefined
      ? item.output
      : item.error !== undefined
        ? item.error
        : item.content !== undefined
          ? item.content
          : '';
  if (Array.isArray(value)) {
    if (
      value.length > 1024 ||
      (!allowHistory &&
        value.some(
          (part) =>
            !part ||
            typeof part !== 'object' ||
            Array.isArray(part) ||
            part.type !== 'input_text' ||
            typeof part.text !== 'string' ||
            Object.keys(part).some((key) => !['type', 'text'].includes(key))
        ))
    )
      fail('tianxi_native_output_invalid', 'output_array_parts_invalid');
    if (!allowHistory) {
      value = value.map((part) => part.text).join('\n');
    } else {
      value = value
        .map((part) =>
          typeof part === 'string'
            ? part
            : part?.text ?? part?.content ?? part?.message ?? part?.error ?? ''
        )
        .filter(Boolean)
        .join('\n');
    }
  }
  if (typeof value !== 'string') {
    if (allowHistory) {
      value = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
    } else {
      fail('tianxi_native_output_invalid', 'output_not_string');
    }
  }
  if (!allowHistory) {
    if (Buffer.byteLength(value) > 60000) {
      fail('tianxi_native_output_invalid', 'output_too_large');
    }
  } else if (value.length > 24000 || Buffer.byteLength(value) > 48000) {
    const marker = '\n... [output truncated] ...\n';
    if (value.length > 18000) {
      value = value.slice(0, 11000) + marker + value.slice(-6000);
    } else {
      const half = Math.max(1000, Math.floor(value.length * 0.4));
      value = value.slice(0, half) + marker + value.slice(-half);
    }
    while (Buffer.byteLength(JSON.stringify(value)) > 56000 && value.length > 1000) {
      const keep = Math.max(500, Math.floor(value.length * 0.35));
      value = value.slice(0, keep) + marker + value.slice(-keep);
    }
  }
  return { text: value, hash: sha(stableJson([item.type, item.output])) };
}
function historyKey(item) {
  if (item?.type === 'additional_tools' && item.role === 'developer')
    return sha(
      stableJson(
        createTianxiNativeCatalog(
          {
            input: [item, { role: 'user', content: 'catalog identity' }],
          },
          { allowPagedDocs: true }
        ).historyDefinitions.sort((left, right) => left.name.localeCompare(right.name))
      )
    );
  if (
    item &&
    (!item.type || item.type === 'message') &&
    ['system', 'developer', 'user'].includes(item.role)
  ) {
    const content =
      typeof item.content === 'string'
        ? item.content
        : Array.isArray(item.content) &&
            item.content.every(
              (part) =>
                ['input_text', 'output_text', 'text'].includes(part?.type) &&
                typeof part.text === 'string'
            )
          ? item.content.map((part) => part.text).join('\n')
          : undefined;
    if (content !== undefined) return sha(JSON.stringify([item.role, content]));
  }
  return sha(stableJson(item));
}
function response(model, output, error, usage = null) {
  return {
    id: 'resp_' + randomUUID().replaceAll('-', ''),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: error ? 'failed' : 'completed',
    output,
    output_text: output
      .filter((i) => i.type === 'message')
      .flatMap((i) => i.content)
      .map((i) => i.text)
      .join(''),
    usage: error ? null : usage,
    error: error ? { code: error, message: 'Tianxi native session failed.' } : null,
    incomplete_details: null,
    parallel_tool_calls: false,
  };
}
function createTianxiNativeSession({
  body,
  owner,
  run = runTianxiSdkMcpExperiment,
  onCall,
  onOutput,
  allowHistory = false,
  onCatalog,
}) {
  const request = snapshot(body);
  const route = tianxiSdkRoutes().find(
    (r) => r.from === request.model && r.exposeInModels !== false
  );
  if (!owner || typeof owner !== 'string' || !owner.length || owner.length > 256)
    fail('tianxi_native_owner_invalid');
  const catalog = createTianxiNativeCatalog(request, {
    allowHistory,
    allowPagedDocs: allowHistory,
  });
  onCatalog?.({
    tools: catalog.definitions.length,
    catalogBytes: Buffer.byteLength(JSON.stringify(catalog.definitions)),
    systemPromptBytes: Buffer.byteLength(catalog.systemPrompt),
    userPromptBytes: Buffer.byteLength(catalog.prompt),
  });
  const controller = new AbortController();
  let pending, terminal, waiter, waitResolve;
  const consumed = new Map();
  let consumedTextAccumulator = catalog.prompt;
  let emittedTextAccumulator = '';
  const computeSessionUsage = (currentOutputText) => {
    if (!allowHistory) return null;
    emittedTextAccumulator += '\n' + String(currentOutputText || '');
    return buildTianxiUsage(consumedTextAccumulator, emittedTextAccumulator);
  };
  const initialItems = new Set(request.input.map(historyKey));
  const initialOutputCallIds = new Set(
    request.input
      .filter((i) =>
        ['custom_tool_call_output', 'function_call_output', 'tool_call_output'].includes(i?.type)
      )
      .map((i) => i?.call_id)
      .filter((id) => typeof id === 'string')
  );
  const emittedCalls = new Map();
  const signal = () => {
    waitResolve?.();
    waitResolve = undefined;
    waiter = undefined;
  };
  async function next() {
    while (!pending && !terminal) {
      waiter ??= new Promise((resolve) => {
        waitResolve = resolve;
      });
      await waiter;
    }
    return pending ? pending.response : terminal;
  }
  const done = Promise.resolve()
    .then(() =>
      run({
        modelId: route ? route.tianxiSdkModel : 'qfmodel',
        prompt: catalog.prompt,
        systemPrompt: catalog.systemPrompt,
        tools: catalog.definitions,
        timeoutMs: allowHistory ? 300000 : 180000,
        toolTimeoutMs: allowHistory ? 600000 : 120000,
        allowExtendedLimits: allowHistory,
        signal: controller.signal,
        onCall: async (name, args, context) => {
          if (pending || controller.signal.aborted) fail('tianxi_native_pending_invalid');
          const local = catalog.localCall(name, args);
          if (local) return local;
          const call = catalog.call(name, args);
          onCall?.(call);
          emittedCalls.set(call.call_id, call);
          return new Promise((resolve, reject) => {
            const abort = () => {
              pending = undefined;
              reject(new Error('tianxi_native_cancelled'));
              signal();
            };
            const callPayloadText = call.input || call.arguments || call.name || '';
            pending = {
              call,
              response: response(request.model, [call], null, computeSessionUsage(callPayloadText)),
              resolve(value) {
                context.signal.removeEventListener('abort', abort);
                resolve(value);
              },
            };
            context.signal.addEventListener('abort', abort, { once: true });
            if (context.signal.aborted) abort();
            signal();
          });
        },
      })
    )
    .then((result) => {
      if (pending) fail('tianxi_native_terminal_pending');
      const value = result.finalText ?? result.output;
      if (typeof value !== 'string' || !value.trim()) fail('tianxi_native_final_invalid');
      terminal = response(
        request.model,
        [
          {
            id: 'msg_' + randomUUID().replaceAll('-', ''),
            type: 'message',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: value, annotations: [], logprobs: [] }],
          },
        ],
        null,
        computeSessionUsage(value)
      );
    })
    .catch((error) => {
      console.error('[TianxiNativeSessionFail]', error?.stack || error);
      const code =
        error instanceof Error
          ? Object.getOwnPropertyDescriptor(error, 'message')?.value
          : undefined;
      const allowed = [
        'tianxi_sdk_auth_failed',
        'tianxi_sdk_launch_failed',
        'tianxi_sdk_mcp_protocol_failed',
        'tianxi_sdk_incomplete',
        'tianxi_sdk_cleanup_failed',
        'tianxi_sdk_output_limit',
        'tianxi_sdk_mcp_invalid',
        'tianxi_sdk_mcp_aborted',
        'tianxi_sdk_mcp_exit_unconfirmed',
        'tianxi_native_final_invalid',
      ];
      terminal = response(
        request.model,
        [],
        allowed.includes(code) ? code : 'tianxi_native_session_failed'
      );
      pending = undefined;
    })
    .finally(signal);
  return {
    next,
    done,
    async resume(input, caller, model) {
      if (caller !== owner || model !== request.model) fail('tianxi_native_owner_mismatch');
      const items = snapshot(input, 1024 * 1024);
      if (!Array.isArray(items) || items.length > 4096) fail('tianxi_native_output_invalid');
      const outputs = items.filter(
        (i) =>
          ['custom_tool_call_output', 'function_call_output', 'tool_call_output'].includes(i?.type) &&
          !(
            allowHistory &&
            (initialItems.has(historyKey(i)) ||
              (typeof i?.call_id === 'string' &&
                initialOutputCallIds.has(i.call_id) &&
                !emittedCalls.has(i.call_id)))
          )
      );
      if (!allowHistory) {
        for (const item of items) {
          if (outputs.includes(item) || initialItems.has(historyKey(item)))
            continue;
          const call = emittedCalls.get(item?.call_id);
          if (!call)
            fail(
              item?.type === 'additional_tools'
                ? 'tianxi_native_tool_history_unsupported'
                : item?.role === 'developer'
                  ? 'tianxi_native_developer_history_unsupported'
                  : 'tianxi_native_history_unsupported'
            );
          const qualified =
            item.namespace === undefined && item.name === `${call.namespace}.${call.name}`;
          if (
            (!qualified && (item.name !== call.name || item.namespace !== call.namespace)) ||
            ['type', 'input', 'arguments'].some((key) => item[key] !== call[key])
          )
            fail('tianxi_native_history_call_invalid');
        }
      }
      const seen = new Set();
      for (const item of outputs) {
        if (typeof item.call_id !== 'string')
          fail('tianxi_native_output_invalid', 'call_id_not_string');
        if (!allowHistory && seen.has(item.call_id))
          fail('tianxi_native_output_invalid', 'duplicate_call_id');
        seen.add(item.call_id);
        const parsed = parseNativeOutput(item, allowHistory),
          previous = consumed.get(item.call_id);
        if (previous) {
          if (previous.hash !== parsed.hash) fail('tianxi_native_output_invalid', 'hash_mismatch');
        } else if (!allowHistory) {
          if (item.call_id !== pending?.call.call_id) fail('tianxi_native_output_invalid', 'pending_mismatch');
        }
      }
      if (!allowHistory) {
        const lastOutput = items.findLastIndex((i) => outputs.includes(i));
        if (items.slice(lastOutput + 1).some((i) => i?.role === 'user'))
          fail('tianxi_native_new_turn_unsupported');
      }
      if (terminal) return terminal;
      const relevant = pending ? outputs.filter((i) => i.call_id === pending.call.call_id) : [];
      if (!relevant.length) {
        const previous = outputs
          .map((i) => ({ item: i, record: consumed.get(i.call_id) }))
          .filter((i) => i.record)
          .at(-1);
        if (!previous) {
          if (terminal) return terminal;
          fail('tianxi_native_output_invalid', 'no_relevant_or_previous');
        }
        return previous.record.next;
      }
      if (!allowHistory && relevant.length !== 1) fail('tianxi_native_output_invalid', 'relevant_count_not_one');
      const item = relevant[0],
        current = pending;
      if (
        !allowHistory &&
        item.type !==
        (current.call.type === 'custom_tool_call'
          ? 'custom_tool_call_output'
          : 'function_call_output') &&
        item.type !== 'tool_call_output'
      )
        fail('tianxi_native_output_invalid');
      const parsed = parseNativeOutput(item, allowHistory);
      if (allowHistory) {
        consumedTextAccumulator += '\n' + parsed.text;
      }
      onOutput?.(parsed.text);
      pending = undefined;
      current.resolve({ content: [{ type: 'text', text: parsed.text }] });
      const continuation = next();
      consumed.set(item.call_id, { hash: parsed.hash, next: continuation });
      return continuation;
    },
    cancel() {
      controller.abort();
    },
  };
}

module.exports = { createTianxiNativeSession };
