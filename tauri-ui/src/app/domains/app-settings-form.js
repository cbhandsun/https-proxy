export function createAppSettingsForm({
  applyPerformanceMode,
  ensureAppSettings,
  getConfig,
  getElement,
  refreshLaunchOnLogin,
}) {
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
      'forceResponseStreaming',
      'forceChatStreaming',
      'upstreamWarmupEnabled',
      'streamDirectRequestBodies',
      'performanceMode',
    ]) {
      getElement(name).checked = settings[name];
    }
    applyPerformanceMode(settings.performanceMode);
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
      forceResponseStreaming: getElement('forceResponseStreaming').checked,
      forceChatStreaming: getElement('forceChatStreaming').checked,
      upstreamWarmupEnabled: getElement('upstreamWarmupEnabled').checked,
      streamDirectRequestBodies: getElement('streamDirectRequestBodies').checked,
      performanceMode: getElement('performanceMode').checked,
    };
  }

  return { collectAppSettings, fillAppSettings };
}
