'use strict';

function toolType(tool) {
  return String(tool?.type || '').toLowerCase();
}

function toolName(tool) {
  return String(tool?.name || tool?.function?.name || '').toLowerCase();
}

function isResponsesNativeWebSearchTool(tool) {
  if (!tool || typeof tool !== 'object' || toolType(tool) === 'function') return false;
  const type = toolType(tool);
  const name = toolName(tool);
  return (
    type === 'web_search' ||
    type.startsWith('web_search_preview') ||
    name === 'builtin_web_search' ||
    name === 'web_search' ||
    name === 'web_search_preview' ||
    name.startsWith('web_search_preview') ||
    name === 'google_search'
  );
}

function isResponsesManagedWebSearchFunction(tool) {
  return Boolean(
    tool &&
    typeof tool === 'object' &&
    toolType(tool) === 'function' &&
    toolName(tool) === 'web_search'
  );
}

function hasResponsesNativeWebSearchTool(tools) {
  return Array.isArray(tools) && tools.some(isResponsesNativeWebSearchTool);
}

function extractResponsesRequestText(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((entry) => extractResponsesRequestText(entry, depth + 1)).join('\n');
  }
  if (typeof value !== 'object') return '';
  return ['input', 'messages', 'message', 'content', 'text']
    .map((key) => extractResponsesRequestText(value[key], depth + 1))
    .filter(Boolean)
    .join('\n');
}

function isResponsesNativeSearchPreferredRequest(requestBody) {
  const text = extractResponsesRequestText(requestBody).slice(-4000);
  return /\u5929\u6c14|\u6c14\u8c61|\u6c14\u6e29|\u6e29\u5ea6|\u4e0b\u96e8|\u964d\u96e8|\u98ce\u529b|\u6e7f\u5ea6|weather|forecast|temperature|rain|humidity/i.test(
    text
  );
}

function flattenResponsesTools(tools) {
  if (!Array.isArray(tools)) return [];
  const flattened = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const type = toolType(tool);
    if (type === 'namespace') {
      const nestedTools = Array.isArray(tool.tools)
        ? tool.tools
        : Array.isArray(tool.functions)
          ? tool.functions
          : [];
      for (const nested of nestedTools) {
        if (!nested || typeof nested !== 'object') continue;
        const nType = toolType(nested);
        if (nType === 'namespace') {
          flattened.push(...flattenResponsesTools([nested]));
        } else if (!nested.type || nType === 'custom' || nType === 'function') {
          flattened.push({ ...nested, type: 'function' });
        } else {
          flattened.push(nested);
        }
      }
    } else if (type === 'custom') {
      flattened.push({ ...tool, type: 'function' });
    } else {
      flattened.push(tool);
    }
  }
  return flattened;
}

function classifyResponsesWebSearchTools(
  tools,
  disableManagedPromotion = false,
  requestBody = null
) {
  if (!Array.isArray(tools)) {
    return { useNativeSearch: false, managedFallback: null, functionTools: [] };
  }
  const flatTools = flattenResponsesTools(tools);
  const managedSearchTools = flatTools.filter(isResponsesManagedWebSearchFunction);
  const preferNativeManagedSearch =
    !disableManagedPromotion &&
    managedSearchTools.length > 0 &&
    isResponsesNativeSearchPreferredRequest(requestBody);
  const promoteManagedSearch =
    !disableManagedPromotion &&
    ((flatTools.length === 1 && isResponsesManagedWebSearchFunction(flatTools[0])) ||
      preferNativeManagedSearch);
  return {
    useNativeSearch: promoteManagedSearch || flatTools.some(isResponsesNativeWebSearchTool),
    managedFallback: promoteManagedSearch ? managedSearchTools : null,
    functionTools: preferNativeManagedSearch
      ? []
      : flatTools.filter(
          (tool) =>
            tool &&
            (tool.type === 'function' || tool.type === 'custom' || !tool.type) &&
            !isResponsesNativeWebSearchTool(tool) &&
            !(promoteManagedSearch && isResponsesManagedWebSearchFunction(tool))
        ),
  };
}

module.exports = {
  extractResponsesRequestText,
  flattenResponsesTools,
  classifyResponsesWebSearchTools,
  hasResponsesNativeWebSearchTool,
  isResponsesManagedWebSearchFunction,
  isResponsesNativeSearchPreferredRequest,
  isResponsesNativeWebSearchTool,
};
