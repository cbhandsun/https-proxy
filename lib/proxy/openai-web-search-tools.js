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
        if (!nested.type) {
          flattened.push({ ...nested, type: 'function' });
        } else {
          flattened.push(nested);
        }
      }
    } else {
      flattened.push(tool);
    }
  }
  return flattened;
}

function classifyResponsesWebSearchTools(tools, disableManagedPromotion = false) {
  if (!Array.isArray(tools)) {
    return { useNativeSearch: false, managedFallback: null, functionTools: [] };
  }
  const flatTools = flattenResponsesTools(tools);
  const promoteManagedSearch =
    !disableManagedPromotion &&
    flatTools.length === 1 &&
    isResponsesManagedWebSearchFunction(flatTools[0]);
  return {
    useNativeSearch: promoteManagedSearch || flatTools.some(isResponsesNativeWebSearchTool),
    managedFallback: promoteManagedSearch ? flatTools : null,
    functionTools: flatTools.filter(
      (tool) =>
        tool &&
        tool.type === 'function' &&
        !isResponsesNativeWebSearchTool(tool) &&
        !(promoteManagedSearch && isResponsesManagedWebSearchFunction(tool))
    ),
  };
}

module.exports = {
  flattenResponsesTools,
  classifyResponsesWebSearchTools,
  hasResponsesNativeWebSearchTool,
  isResponsesManagedWebSearchFunction,
  isResponsesNativeWebSearchTool,
};
