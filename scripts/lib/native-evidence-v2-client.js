'use strict';

const { isDeepStrictEqual } = require('node:util');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const { createNativeBenchmarkToolConcurrency } = require('./native-benchmark-tool-concurrency');
const { nativeEvidenceV2Options } = require('./native-evidence-v2-options');
const { nativeEvidenceArgumentShape } = require('./native-evidence-argument-shape');
const fail = (code) => Object.assign(new Error('Native evidence client refused input'), { code });
const identity = (s) => typeof s === 'string' && /^[a-zA-Z0-9_.:-]{1,256}$/.test(s);

function nativeEvidenceV2Thread(port, directory, definitions, arm) {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof directory !== 'string' ||
    !require('node:path').isAbsolute(directory) ||
    directory.includes('\0') ||
    !['control', 'compact'].includes(arm)
  )
    throw fail('native_v2_thread_invalid');
  const tools = normalizeCompactionData(definitions, 32768);
  const names = [
    'hpm_read_branch',
    'hpm_read_page',
    'hpm_verify_state',
    'hpm_list_retained_evidence',
    'hpm_read_retained_evidence',
  ];
  if (
    !Array.isArray(tools) ||
    tools.length !== names.length ||
    new Set(tools.map((t) => t?.name)).size !== names.length ||
    tools.some((t) => !names.includes(t?.name))
  )
    throw fail('native_v2_thread_invalid');
  return {
    model: 'gpt-5.6-sol',
    modelProvider: 'hpm-isolated',
    ephemeral: true,
    cwd: directory,
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    config: {
      model_reasoning_effort: 'low',
      web_search: 'disabled',
      tool_output_token_limit: 24000,
      model_auto_compact_token_limit: arm === 'compact' ? 4096 : 1000000,
      model_auto_compact_token_limit_scope: 'body_after_prefix',
      model_providers: {
        'hpm-isolated': {
          name: 'OpenAI',
          base_url: 'http://127.0.0.1:' + port + '/backend-api/codex',
          wire_api: 'responses',
          env_key: 'HPM_NATIVE_TEST_AUTH',
          supports_websockets: false,
          capabilities: { remote_compaction: 'v2' },
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
    },
    dynamicTools: tools.map((tool) => ({ type: 'function', ...tool })),
  };
}

function createNativeEvidenceV2Client(input) {
  const {
    workload,
    report,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = nativeEvidenceV2Options(input, ['workload', 'report', 'delay']);
  if (
    typeof workload?.reply !== 'function' ||
    !Array.isArray(workload.tools) ||
    !Array.isArray(report?.turns) ||
    typeof delay !== 'function'
  )
    throw fail('native_v2_client_invalid');
  const concurrency = createNativeBenchmarkToolConcurrency();
  const calls = new Map();
  const completed = new Set();
  let threadId = null;
  let turnId = null;
  let text = '';
  let compactionItems = 0;
  return {
    bind(id) {
      if (threadId !== null || !identity(id)) throw fail('native_v2_thread_invalid');
      threadId = id;
    },
    async onServerRequest(message) {
      const m = normalizeCompactionData(message, 2 * 1024 * 1024);
      const p = m?.params;
      if (
        m?.method !== 'item/tool/call' ||
        threadId === null ||
        p?.threadId !== threadId ||
        !identity(p?.callId) ||
        !identity(p?.turnId) ||
        p.turnId !== turnId ||
        p.namespace !== null ||
        calls.has(p.callId) ||
        !workload.tools.some((tool) => tool.name === p.tool)
      ) {
        report.unsafeToolRequests++;
        throw fail('native_v2_tool_refused');
      }
      calls.set(p.callId, p.tool);
      const response = workload.reply(p.tool, p.arguments);
      if (!response.ok) {
        report.toolFailureCount++;
        report.toolFailureShape = {
          tool: p.tool,
          code:
            typeof response.code === 'string' && /^[a-z_]{1,80}$/.test(response.code)
              ? response.code
              : 'native_v2_tool_failed',
          ...nativeEvidenceArgumentShape(p.arguments),
        };
        throw fail('native_v2_tool_failed');
      }
      const finish =
        p.tool === 'hpm_read_branch' ? concurrency.begin(p.arguments.document) : () => {};
      try {
        await delay(100); // Identical, predeclared delay for every tool in both arms.
        return { success: true, contentItems: [{ type: 'inputText', text: response.text }] };
      } finally {
        finish();
      }
    },
    onNotification(message) {
      message = normalizeCompactionData(message, 2 * 1024 * 1024);
      const p = message.params;
      if (message.method === 'turn/started') {
        if (p?.threadId !== threadId || !identity(p.turn?.id) || turnId !== null)
          throw fail('native_v2_turn_invalid');
        turnId = p.turn.id;
        text = '';
        compactionItems = 0;
      }
      if (['item/started', 'item/completed'].includes(message.method)) {
        if (p?.threadId !== threadId || p.turnId !== turnId) throw fail('native_v2_turn_invalid');
        const item = p.item;
        if (
          [
            'commandExecution',
            'fileChange',
            'mcpToolCall',
            'collabAgentToolCall',
            'collabToolCall',
            'webSearch',
          ].includes(item?.type)
        ) {
          report.unsafeToolRequests++;
          throw fail('native_v2_side_effect_refused');
        }
        if (message.method === 'item/completed') {
          if (item?.type === 'contextCompaction') compactionItems++;
          if (item?.type === 'dynamicToolCall') {
            if (
              !identity(item.id) ||
              !calls.has(item.id) ||
              calls.get(item.id) !== item.tool ||
              item.success !== true ||
              completed.has(item.id)
            )
              throw fail('native_v2_completion_invalid');
            completed.add(item.id);
            if (item.tool === 'hpm_read_retained_evidence') report.completedDynamicReadItems++;
          }
          if (item?.type === 'agentMessage') {
            if (typeof item.text !== 'string' || Buffer.byteLength(item.text) > 65536)
              throw fail('native_v2_final_too_large');
            text = item.text; // In memory only; never included in a report.
          }
        }
      }
      if (message.method === 'turn/completed') {
        if (p?.threadId !== threadId || p.turn?.id !== turnId) throw fail('native_v2_turn_invalid');
        report.turns.push({
          completed: p.turn.status === 'completed',
          compactionItems,
          outputBytes: Buffer.byteLength(text),
        });
        turnId = null;
      }
      if (message.method === 'error') throw fail('native_v2_client_error');
    },
    verifyFinal() {
      let value;
      try {
        value = normalizeCompactionData(JSON.parse(text.trim()), 65536);
      } catch {
        throw fail('native_v2_final_invalid');
      }
      report.finalStateCorrect = isDeepStrictEqual(
        JSON.parse(JSON.stringify(value)),
        workload.expected
      );
      text = '';
    },
    inspect: () => ({ ...concurrency.diagnostics(), completedToolItems: completed.size }),
  };
}

module.exports = { nativeEvidenceV2Thread, createNativeEvidenceV2Client };
