'use strict';

const path = require('node:path');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const {
  EVIDENCE_NAMESPACE,
  createContextEvidenceNativeDelivery,
} = require('../../lib/client/context-evidence-native-delivery');

const FIXTURE_MODES = [
  'discovery',
  'code-mode-object',
  'code-mode-json',
  'direct',
  'legacy-console',
  'code-mode-page',
  'namespace-direct',
];
const name = (value) => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(value);
const fail = () => new TypeError('Invalid isolated native fixture');

function nativeFixtureOptions(input) {
  const value = normalizeCompactionData(input, 4096);
  if (
    !value ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['executable', 'mode'].includes(key)) ||
    !FIXTURE_MODES.includes(value.mode) ||
    typeof value.executable !== 'string' ||
    !path.isAbsolute(value.executable) ||
    value.executable.includes('\0')
  )
    throw fail();
  return { executable: value.executable, mode: value.mode };
}

function nativeFixtureThreadOptions(port, directory, definitions, mode = 'direct') {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    directory.includes('\0') ||
    !FIXTURE_MODES.includes(mode)
  )
    throw fail();
  const dynamicTools = normalizeCompactionData(definitions, 16 * 1024);
  if (
    !Array.isArray(dynamicTools) ||
    dynamicTools.length !== 2 ||
    new Set(dynamicTools.map((tool) => tool?.name)).size !== 2 ||
    dynamicTools.some(
      (tool) =>
        !tool ||
        tool.type !== 'function' ||
        !['hpm_list_retained_evidence', 'hpm_read_retained_evidence'].includes(tool.name)
    )
  )
    throw fail();
  const delivery =
    mode === 'namespace-direct'
      ? createContextEvidenceNativeDelivery(dynamicTools, { delivery: 'namespace-direct' })
      : null;
  return {
    model: 'gpt-5.6-sol',
    modelProvider: 'hpm-loopback-fixture',
    ephemeral: true,
    cwd: directory,
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    config: {
      model_reasoning_effort: 'low',
      web_search: 'disabled',
      tool_output_token_limit: 24000,
      model_auto_compact_token_limit: 1000000,
      analytics: { enabled: false },
      features: {
        apps: false,
        ...(delivery?.config.features ?? {}),
      },
      mcp_servers: {},
      model_providers: {
        'hpm-loopback-fixture': {
          name: 'Isolated Loopback Fixture',
          base_url: 'http://127.0.0.1:' + port,
          wire_api: 'responses',
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 0,
          stream_max_retries: 0,
        },
      },
    },
    dynamicTools: delivery?.dynamicTools ?? dynamicTools,
  };
}

function nativeFixtureToolShapes(input) {
  const tools = normalizeCompactionData(input, 256 * 1024);
  if (!Array.isArray(tools)) throw fail();
  const result = [];
  const identities = new Set();
  function visit(value, namespace = null) {
    if (result.length >= 64 || !value || typeof value !== 'object' || Array.isArray(value))
      throw fail();
    if (value.type === 'namespace' && Array.isArray(value.tools)) {
      if (!name(value.name) || namespace !== null || value.tools.length > 64) throw fail();
      for (const tool of value.tools) visit(tool, value.name);
    } else if (['function', 'custom'].includes(value.type)) {
      if (!name(value.name)) throw fail();
      const identity = JSON.stringify([namespace, value.name]);
      if (identities.has(identity)) throw fail();
      identities.add(identity);
      result.push({
        type: value.type,
        name: value.name,
        namespace,
        formatType: value.format?.type ?? null,
      });
    } else if (['tool_search', 'web_search', 'web_search_preview'].includes(value.type)) {
      result.push({ type: value.type, name: null, namespace, formatType: null });
    } else throw fail();
  }
  for (const tool of tools) visit(tool);
  return result;
}

function nativeFixtureToolInventory(input) {
  const tools = normalizeCompactionData(input, 256 * 1024);
  if (!Array.isArray(tools) || tools.length > 64) throw fail();
  function project(value) {
    return {
      type: name(value?.type) ? value.type : null,
      name: name(value?.name) ? value.name : null,
      keys:
        value && typeof value === 'object'
          ? Object.keys(value).filter((key) =>
              [
                'type',
                'name',
                'tools',
                'namespace',
                'description',
                'format',
                'parameters',
                'function',
                'functions',
              ].includes(key)
            )
          : [],
      children: Array.isArray(value?.tools) ? value.tools.slice(0, 64).map(project) : [],
    };
  }
  return tools.map(project);
}

function nativeFixtureCodeItem(shape, sources, mode, offsetBytes = 0, index = 1) {
  shape = normalizeCompactionData(shape, 4096);
  const safe = normalizeCompactionData(sources, 16 * 1024);
  if (
    ![
      'code-mode-object',
      'code-mode-json',
      'legacy-console',
      'code-mode-page',
      'namespace-direct',
    ].includes(mode) ||
    shape?.type !== 'custom' ||
    !name(shape.name) ||
    (shape.namespace !== null && !name(shape.namespace)) ||
    !Array.isArray(safe) ||
    safe.length !== (mode === 'code-mode-page' ? 1 : 7) ||
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    offsetBytes > 524288 ||
    !Number.isSafeInteger(index) ||
    index < 1 ||
    index > 32 ||
    safe.some(
      (source) =>
        typeof source?.sourceId !== 'string' ||
        typeof source.digest !== 'string' ||
        !/^hce_[a-f0-9]{32}$/.test(source.sourceId) ||
        !/^[a-f0-9]{64}$/.test(source.digest)
    )
  )
    throw fail();
  const print =
    mode === 'legacy-console'
      ? 'console.log(result);'
      : mode === 'code-mode-json'
        ? 'text(JSON.stringify(result));'
        : 'text(result);';
  let program =
    'const sources = ' +
    JSON.stringify(safe.map(({ sourceId, digest }) => ({ sourceId, digest }))) +
    ';\n' +
    'for (const source of sources) { let offsetBytes = 0; do {\n' +
    'const result = await tools.hpm_read_retained_evidence({...source, offsetBytes, limitBytes: 6144});\n' +
    print +
    '\n' +
    'const value = typeof result === "string" ? JSON.parse(result) : result;\n' +
    'const packed = value.contentItems?.[0]?.text ?? value.content?.[0]?.text;\n' +
    'const page = (typeof packed === "string" ? JSON.parse(packed) : value).page; offsetBytes = page.nextOffsetBytes;\n' +
    '} while (offsetBytes !== null); }';
  if (mode === 'code-mode-page')
    program =
      'const result = await tools.hpm_read_retained_evidence(' +
      JSON.stringify({
        sourceId: safe[0].sourceId,
        digest: safe[0].digest,
        offsetBytes,
        limitBytes: 6144,
      }) +
      ');\ntext(result);';
  if (mode === 'namespace-direct')
    program =
      'const exposed = typeof tools.hpm_evidence?.hpm_read_retained_evidence === "function" || ' +
      'typeof tools.hpm_read_retained_evidence === "function" || ' +
      'typeof tools.hpm_evidence__hpm_read_retained_evidence === "function";\n' +
      'text(exposed ? "fixture_evidence_nested_callable" : "fixture_evidence_nested_unavailable");';
  return {
    type: 'custom_tool_call',
    id: 'fixture-code-item-' + index,
    call_id: 'fixture-code-call-' + index,
    name: shape.name,
    ...(shape.namespace ? { namespace: shape.namespace } : {}),
    input: program,
  };
}

// Entirely synthetic protocol frames, not a fabricated native compaction item.
function nativeFixtureSse(item) {
  const safe = normalizeCompactionData(item, 256 * 1024);
  if (!safe || !['message', 'custom_tool_call', 'function_call'].includes(safe.type)) throw fail();
  const response = {
    id: 'fixture-response',
    object: 'response',
    model: 'gpt-5.6-sol',
    status: 'completed',
    output: [safe],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: safe },
    { type: 'response.output_item.done', output_index: 0, item: safe },
    { type: 'response.completed', response },
  ];
  return events
    .map((event) => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    .join('');
}

function nativeFixtureAcceptance(input) {
  const value = normalizeCompactionData(input, 4096);
  if (!value || Array.isArray(value) || !FIXTURE_MODES.includes(value.mode)) throw fail();
  if (value.failureCode !== null || value.turnCompleted !== true) return false;
  if (value.mode === 'discovery') return value.requests === 1;
  return (
    value.fullyReadSources === 7 &&
    value.readReplies === 13 &&
    value.exactEnvelopes === 13 &&
    value.completedDynamicReadItems === 13 &&
    (value.mode === 'direct' || value.realNativeCodeModeObserved === true) &&
    (value.mode !== 'namespace-direct' ||
      (value.evidenceNestedUnavailableObserved === true &&
        value.evidenceNestedCallableObserved === false))
  );
}

module.exports = {
  FIXTURE_MODES,
  EVIDENCE_NAMESPACE,
  nativeFixtureOptions,
  nativeFixtureThreadOptions,
  nativeFixtureToolShapes,
  nativeFixtureToolInventory,
  nativeFixtureCodeItem,
  nativeFixtureSse,
  nativeFixtureAcceptance,
};
