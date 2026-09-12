export function codexDesktopConnectionDetails(status, getElement) {
  const modelSelector = getElement('codexDesktopModel');
  const effortSelector = getElement('codexDesktopReasoningEffort');
  if (modelSelector && status.model) modelSelector.value = status.model;
  if (effortSelector && status.modelReasoningEffort) {
    effortSelector.value = status.modelReasoningEffort;
  }

  return {
    legacy:
      status.legacyBaseUrl && !status.openaiBaseUrl && !status.isCustomModern
        ? '；当前为旧 base_url 写法'
        : '',
    modelInfo: status.model
      ? `；默认模型: ${status.model}${status.modelReasoningEffort ? ` (${status.modelReasoningEffort})` : ''}`
      : '',
  };
}
