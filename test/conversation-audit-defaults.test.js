const assert = require('assert');

const { DEFAULT_CONFIG } = require('../lib/proxy/config');

(async () => {
  const { normalizeAppSettings } = await import('../tauri-ui/src/app/models/configuration.js');
  const frontendDefaults = normalizeAppSettings(null, {});

  // The backend falls back to DEFAULT_CONFIG when proxy.config.json is missing,
  // while the desktop UI normalizes a fresh config with its own defaults. If the
  // two drift apart the UI shows a state the proxy does not actually use.
  assert.strictEqual(
    DEFAULT_CONFIG.appSettings.conversationAuditEnabled,
    frontendDefaults.conversationAuditEnabled,
    'conversation audit default must match between proxy and desktop UI'
  );
  assert.strictEqual(DEFAULT_CONFIG.appSettings.conversationAuditEnabled, true);
  assert.strictEqual(
    DEFAULT_CONFIG.appSettings.conversationAuditCaptureContent,
    false,
    'capturing conversation content stays opt-in'
  );
  assert.strictEqual(
    frontendDefaults.conversationAuditCaptureContent,
    false,
    'the desktop default must not silently enable content capture'
  );
  assert.strictEqual(DEFAULT_CONFIG.appSettings.verifyUpstreamTls, true);
  assert.strictEqual(frontendDefaults.verifyUpstreamTls, true);

  console.log('[conversation-audit-defaults.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
