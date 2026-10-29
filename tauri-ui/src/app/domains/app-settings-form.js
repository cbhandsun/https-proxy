export function createAppSettingsForm({
  applyPerformanceMode,
  ensureAppSettings,
  getConfig,
  getElement,
  refreshLaunchOnLogin,
}) {
  // Content capture only has meaning while the audit log itself is enabled.
  // Keep the stored value untouched but make the dependency visible in the UI.
  function syncCaptureContentAvailability() {
    const auditEnabled = getElement('conversationAuditEnabled').checked === true;
    const captureContent = getElement('conversationAuditCaptureContent');
    captureContent.disabled = !auditEnabled;
    captureContent.title = auditEnabled
      ? '开启后会把请求体与响应正文写入本地审计日志'
      : '请先开启“记录对话审计日志”';
  }

  function fillAppSettings() {
    ensureAppSettings();
    const settings = getConfig().appSettings;
    for (const name of [
      'closeToTray',
      'stopProxyOnExit',
      'autoStartProxy',
      'launchOnLogin',
      'showTopMenu',
      'showTrayMenu',
      'showWindowOnTrayCommand',
      'desktopNotifications',
      'disableLocalProxy',
      'verifyUpstreamTls',
      'conversationAuditEnabled',
      'conversationAuditCaptureContent',
      'contextRecoveryEnabled',
      'contextRecoveryPersistenceEnabled',
      'forceResponseStreaming',
      'forceChatStreaming',
      'upstreamWarmupEnabled',
      'streamDirectRequestBodies',
      'performanceMode',
    ]) {
      getElement(name).checked = settings[name];
    }
    applyPerformanceMode(settings.performanceMode);
    syncCaptureContentAvailability();
    void refreshLaunchOnLogin();
  }

  function collectAppSettings() {
    const config = getConfig();
    config.appSettings = {
      ...(config.appSettings || {}),
      closeToTray: getElement('closeToTray').checked,
      stopProxyOnExit: getElement('stopProxyOnExit').checked,
      autoStartProxy: getElement('autoStartProxy').checked,
      launchOnLogin: getElement('launchOnLogin').checked,
      showTopMenu: getElement('showTopMenu').checked,
      showTrayMenu: getElement('showTrayMenu').checked,
      showWindowOnTrayCommand: getElement('showWindowOnTrayCommand').checked,
      desktopNotifications: getElement('desktopNotifications').checked,
      disableLocalProxy: getElement('disableLocalProxy').checked,
      verifyUpstreamTls: getElement('verifyUpstreamTls').checked,
      conversationAuditEnabled: getElement('conversationAuditEnabled').checked,
      conversationAuditCaptureContent: getElement('conversationAuditCaptureContent').checked,
      contextRecoveryEnabled: getElement('contextRecoveryEnabled').checked,
      contextRecoveryPersistenceEnabled: getElement('contextRecoveryPersistenceEnabled').checked,
      forceResponseStreaming: getElement('forceResponseStreaming').checked,
      forceChatStreaming: getElement('forceChatStreaming').checked,
      upstreamWarmupEnabled: getElement('upstreamWarmupEnabled').checked,
      streamDirectRequestBodies: getElement('streamDirectRequestBodies').checked,
      performanceMode: getElement('performanceMode').checked,
    };
  }

  return { collectAppSettings, fillAppSettings, syncCaptureContentAvailability };
}
