export function configurationLoadNotice(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return '正在读取配置';
  return config.__fallback ? '配置读取失败，正在自动重连；原有配置未被清空。' : '';
}

export function assertConfigurationLoaded(config) {
  if (configurationLoadNotice(config)) {
    throw new Error('配置尚未成功读取，已阻止保存，避免覆盖原有设置。');
  }
}
