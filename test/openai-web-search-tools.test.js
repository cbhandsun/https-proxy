'use strict';

const assert = require('assert');
const {
  classifyResponsesWebSearchTools,
  isResponsesManagedWebSearchFunction,
  isResponsesNativeWebSearchTool,
} = require('../lib/proxy/openai-web-search-tools');

const managedSearch = { type: 'function', function: { name: 'web_search' } };
const ordinaryFunction = { type: 'function', function: { name: 'read_file' } };
const nativeSearch = { type: 'web_search_preview_2025_03_11' };

assert.strictEqual(isResponsesManagedWebSearchFunction(managedSearch), true);
assert.strictEqual(isResponsesManagedWebSearchFunction(nativeSearch), false);
assert.strictEqual(isResponsesManagedWebSearchFunction(null), false);
assert.strictEqual(isResponsesNativeWebSearchTool(nativeSearch), true);
assert.strictEqual(isResponsesNativeWebSearchTool({ type: 'web_search' }), true);
assert.strictEqual(
  isResponsesNativeWebSearchTool({ type: 'function', function: { name: 'web_search' } }),
  false
);
assert.strictEqual(isResponsesNativeWebSearchTool({ name: 'google_search' }), true);

assert.deepStrictEqual(classifyResponsesWebSearchTools(null), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [],
});
assert.deepStrictEqual(classifyResponsesWebSearchTools([managedSearch]), {
  useNativeSearch: true,
  managedFallback: [managedSearch],
  functionTools: [],
});
assert.deepStrictEqual(classifyResponsesWebSearchTools([managedSearch], true), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [managedSearch],
});
assert.deepStrictEqual(classifyResponsesWebSearchTools([managedSearch, ordinaryFunction]), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [managedSearch, ordinaryFunction],
});
assert.deepStrictEqual(
  classifyResponsesWebSearchTools([managedSearch, ordinaryFunction], false, {
    input: '上海天气',
  }),
  {
    useNativeSearch: true,
    managedFallback: [managedSearch],
    functionTools: [],
  }
);
assert.deepStrictEqual(
  classifyResponsesWebSearchTools([managedSearch, ordinaryFunction], true, {
    input: '上海天气',
  }),
  {
    useNativeSearch: false,
    managedFallback: null,
    functionTools: [managedSearch, ordinaryFunction],
  }
);
assert.deepStrictEqual(classifyResponsesWebSearchTools([nativeSearch, ordinaryFunction]), {
  useNativeSearch: true,
  managedFallback: null,
  functionTools: [ordinaryFunction],
});

// Namespace tools support:
// 1. Empty namespace should be dropped safely
assert.deepStrictEqual(classifyResponsesWebSearchTools([{ type: 'namespace', name: 'empty_ns' }]), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [],
});

// 2. Namespace containing functions should be unwrapped
const namespaceWithTools = {
  type: 'namespace',
  name: 'system',
  tools: [ordinaryFunction],
};
assert.deepStrictEqual(classifyResponsesWebSearchTools([namespaceWithTools]), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [ordinaryFunction],
});

// 3. Namespace containing raw functions without type='function' should be normalized
const namespaceWithRawFunctions = {
  type: 'namespace',
  name: 'tools',
  functions: [{ name: 'custom_action', description: 'custom', parameters: {} }],
};
assert.deepStrictEqual(classifyResponsesWebSearchTools([namespaceWithRawFunctions]), {
  useNativeSearch: false,
  managedFallback: null,
  functionTools: [
    { type: 'function', name: 'custom_action', description: 'custom', parameters: {} },
  ],
});

console.log('[openai-web-search-tools.test] ok');
