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

function classifyResponsesWebSearchTools(tools, disableManagedPromotion = false) {
  if (!Array.isArray(tools)) {
    return { useNativeSearch: false, managedFallback: null, functionTools: [] };
  }
  const promoteManagedSearch =
    !disableManagedPromotion && tools.length === 1 && isResponsesManagedWebSearchFunction(tools[0]);
  return {
    useNativeSearch: promoteManagedSearch || tools.some(isResponsesNativeWebSearchTool),
    managedFallback: promoteManagedSearch ? tools : null,
    functionTools: tools.filter(
      (tool) =>
        tool &&
        tool.type === 'function' &&
        !isResponsesNativeWebSearchTool(tool) &&
        !(promoteManagedSearch && isResponsesManagedWebSearchFunction(tool))
    ),
  };
}

module.exports = {
  classifyResponsesWebSearchTools,
  hasResponsesNativeWebSearchTool,
  isResponsesManagedWebSearchFunction,
  isResponsesNativeWebSearchTool,
};
