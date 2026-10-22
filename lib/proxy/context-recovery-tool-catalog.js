'use strict';

const { normalizeCompactionData } = require('./context-compaction-envelope');
const { MAX_WIRE_BYTES } = require('./context-api-evidence-protocol');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('./context-evidence-tools');

const reserved = new Set([LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL]);
const hostedTypes = new Set(['web_search', 'web_search_preview', 'web_search_preview_2025_03_11']);
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (namespace, name) => JSON.stringify([namespace ?? null, name]);

// Index identities without flattening or rewriting the provider's tool schemas.
// The index grants no executor: only the separately owned private readers run here.
function createRecoveryToolCatalog(kind, input) {
  const tools = normalizeCompactionData(input, MAX_WIRE_BYTES);
  if (!['chat', 'responses', 'claude'].includes(kind) || !Array.isArray(tools))
    throw new TypeError('Invalid recovery tool catalog');
  const entries = new Map();
  const topNames = new Set();
  let hostedSearch = false;
  const collision = () => ({ ok: false, code: 'context_recovery_tool_collision' });
  const unsupported = () => ({ ok: false, code: 'context_recovery_tools_unsupported' });
  function add(tool, namespace) {
    const name = kind === 'chat' ? tool?.function?.name : tool?.name;
    if (!identity(name) || reserved.has(name) || entries.has(key(namespace, name)))
      return collision();
    const type = kind === 'claude' ? 'function' : tool.type;
    if (
      (kind === 'claude' && tool.type !== undefined) ||
      !['function', ...(kind === 'responses' ? ['custom'] : [])].includes(type)
    )
      return unsupported();
    entries.set(key(namespace, name), type);
    return null;
  }
  for (const tool of tools) {
    if (!record(tool)) return unsupported();
    if (kind === 'responses' && hostedTypes.has(tool.type)) {
      if (hostedSearch || tool.name !== undefined) return collision();
      hostedSearch = true;
      continue;
    }
    const name = kind === 'chat' ? tool.function?.name : tool.name;
    if (!identity(name) || reserved.has(name) || topNames.has(name)) return collision();
    topNames.add(name);
    if (kind === 'responses' && tool.type === 'namespace') {
      if (!Array.isArray(tool.tools) || !tool.tools.length || tool.tools.length > 128)
        return unsupported();
      for (const child of tool.tools) {
        if (!record(child)) return unsupported();
        const error = add(child, name);
        if (error) return error;
      }
    } else {
      const error = add(tool, null);
      if (error) return error;
    }
  }
  return {
    ok: true,
    hostedSearch,
    resolve(name, namespace) {
      if (!identity(name) || (namespace != null && !identity(namespace))) return null;
      return entries.get(key(namespace, name)) ?? null;
    },
  };
}

module.exports = { createRecoveryToolCatalog };
