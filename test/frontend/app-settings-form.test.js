// Regression tests for the application settings form round trip.

'use strict';

const assert = require('node:assert/strict');

(async () => {
  const { createAppSettingsForm } =
    await import('../../tauri-ui/src/app/domains/app-settings-form.js');

  const checkboxNames = [
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
    'forceResponseStreaming',
    'forceChatStreaming',
    'upstreamWarmupEnabled',
    'streamDirectRequestBodies',
    'performanceMode',
  ];
  const elements = Object.fromEntries(
    checkboxNames.map((name) => [name, { checked: false, disabled: false, title: '' }])
  );
  const config = {
    appSettings: {
      closeToTray: true,
      stopProxyOnExit: false,
      autoStartProxy: true,
      launchOnLogin: false,
      showTopMenu: true,
      showTrayMenu: false,
      showWindowOnTrayCommand: true,
      desktopNotifications: false,
      disableLocalProxy: false,
      verifyUpstreamTls: true,
      conversationAuditEnabled: true,
      conversationAuditCaptureContent: false,
      forceResponseStreaming: true,
      forceChatStreaming: false,
      upstreamWarmupEnabled: true,
      streamDirectRequestBodies: false,
      performanceMode: true,
      unknownSetting: 'preserved',
    },
  };
  const applied = [];
  let loginRefreshes = 0;

  const form = createAppSettingsForm({
    applyPerformanceMode: (value) => applied.push(value),
    ensureAppSettings: () => {},
    getConfig: () => config,
    getElement: (name) => {
      if (!elements[name]) elements[name] = { checked: false };
      return elements[name];
    },
    refreshLaunchOnLogin: async () => {
      loginRefreshes += 1;
    },
  });

  form.fillAppSettings();
  for (const name of checkboxNames) {
    assert.equal(
      elements[name].checked,
      config.appSettings[name],
      `${name} is reflected from configuration into the form`
    );
  }
  assert.deepEqual(applied, [true], 'performance mode is applied from the loaded settings');
  assert.equal(loginRefreshes, 1, 'launch-on-login state is refreshed once');
  assert.equal(
    elements.conversationAuditCaptureContent.disabled,
    false,
    'content capture stays interactive while the audit log is enabled'
  );

  // Turning off the audit log must disable content capture without losing the
  // stored preference, so re-enabling the log restores the previous choice.
  elements.conversationAuditEnabled.checked = false;
  form.syncCaptureContentAvailability();
  assert.equal(elements.conversationAuditCaptureContent.disabled, true);
  assert.ok(elements.conversationAuditCaptureContent.title.includes('记录对话审计日志'));
  elements.conversationAuditEnabled.checked = true;
  form.syncCaptureContentAvailability();
  assert.equal(elements.conversationAuditCaptureContent.disabled, false);
  assert.ok(elements.conversationAuditCaptureContent.title.includes('请求体'));

  // Toggle every field so the collect path cannot silently keep stale values.
  for (const name of checkboxNames) elements[name].checked = !elements[name].checked;
  form.collectAppSettings();
  for (const name of checkboxNames) {
    assert.equal(
      config.appSettings[name],
      elements[name].checked,
      `${name} is persisted from the form`
    );
  }
  // Migration-critical settings must survive the spread-based collect.
  assert.equal(config.appSettings.conversationAuditCaptureContent, true);
  assert.equal(config.appSettings.forceResponseStreaming, false);
  assert.equal(config.appSettings.forceChatStreaming, true);
  assert.equal(config.appSettings.upstreamWarmupEnabled, false);
  assert.equal(config.appSettings.streamDirectRequestBodies, true);
  assert.equal(config.appSettings.unknownSetting, 'preserved');

  // Missing DOM nodes must fail loudly instead of writing `undefined` into config.
  assert.throws(() => {
    const broken = createAppSettingsForm({
      applyPerformanceMode: () => {},
      ensureAppSettings: () => {},
      getConfig: () => ({ appSettings: {} }),
      getElement: () => {
        throw new Error('missing element');
      },
      refreshLaunchOnLogin: async () => {},
    });
    broken.fillAppSettings();
  }, /missing element/);

  console.log('[app-settings-form.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
