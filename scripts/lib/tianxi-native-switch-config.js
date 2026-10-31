'use strict';
const path = require('node:path');
const { MODELS, DEFAULT_MODEL } = require('./tianxi-native-gateway-sessions');

function planTianxiNativeSwitch({ config, catalog, directory, port, token }) {
  if (
    typeof config !== 'string' ||
    config.length > 1024 * 1024 ||
    config.includes('\0') ||
    !catalog ||
    !Array.isArray(catalog.models) ||
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    /[\0\r\n"]/.test(directory) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(token)
  )
    throw new Error('tianxi_native_switch_invalid');
  if (/^\s*\[model_providers\.tianxi_native\]\s*$/m.test(config))
    throw new Error('tianxi_native_switch_already_configured');
  const source = catalog.models.find(
    (model) => model?.tool_mode === 'code_mode_only' && model.apply_patch_tool_type === 'freeform'
  );
  if (!source) throw new Error('tianxi_native_switch_metadata_missing');
  const models = MODELS.map((slug) => ({
    ...source,
    slug,
    display_name: slug + ' · Codex native tools',
    context_window: 32000,
    max_context_window: 32000,
    auto_compact_token_limit: 24000,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    supports_parallel_tool_calls: false,
    prefer_websockets: false,
  }));
  // This adapter is bounded by its SDK text budget, not the source model's
  // advertised context. Compaction is explicitly unsupported by the gateway.
  const overrides = {
    model_provider: '"tianxi_native"',
    model: JSON.stringify(DEFAULT_MODEL),
    model_catalog_json: JSON.stringify(path.join(directory, 'models.json').replaceAll('\\', '/')),
    model_auto_compact_token_limit: '24000',
  };
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const boundary = firstTable === -1 ? lines.length : firstTable;
  const header = lines.slice(0, boundary);
  for (const [key, value] of Object.entries(overrides)) {
    const matches = header.flatMap((line, index) =>
      new RegExp('^\\s*' + key + '\\s*=').test(line) ? [index] : []
    );
    if (matches.length > 1) throw new Error('tianxi_native_switch_ambiguous');
    if (matches.length) header[matches[0]] = key + ' = ' + value;
    else header.push(key + ' = ' + value);
  }
  const provider = [
    '',
    '[model_providers.tianxi_native]',
    'name = "Tianxi Codex Native Tools"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    `http_headers = { Authorization = "Bearer ${token}" }`,
    '',
  ];
  return {
    config: [...header, ...lines.slice(boundary), ...provider].join('\n'),
    catalog: { models },
    state: { port, token },
  };
}
module.exports = { planTianxiNativeSwitch };
