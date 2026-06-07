const ROUTES = [
  ['POST', 'selectDirectory', ['/v1/local/select-directory', '/local/select-directory']],
  ['POST', 'cliLaunch', ['/v1/local/cli/launch', '/local/cli/launch']],
  ['GET', 'cliSessions', ['/v1/local/cli/sessions', '/local/cli/sessions']],
  ['POST', 'cliSessionDelete', ['/v1/local/cli/sessions/delete', '/local/cli/sessions/delete']],
  ['GET', 'auditConversations', ['/v1/local/audit/conversations', '/local/audit/conversations']],
  ['POST', 'auditConversationsClear', ['/v1/local/audit/conversations/clear', '/local/audit/conversations/clear']],
  ['GET', 'usageSummary', ['/v1/local/usage/summary', '/local/usage/summary']],
  ['POST', 'auditRetry', ['/v1/local/audit/retry', '/local/audit/retry']],
  ['GET', 'usageReport', ['/v1/local/usage/report', '/local/usage/report']],
  ['POST', 'profileTestAuth', ['/v1/local/profile/test-auth', '/local/profile/test-auth']],
  ['GET', 'health', ['/v1/local/health', '/local/health']],
  ['GET', 'getConfig', ['/v1/local/config', '/local/config']],
  ['POST', 'saveConfig', ['/v1/local/config', '/local/config']],
  ['POST', 'setActive', ['/v1/local/active', '/local/active']],
  ['GET', 'log', ['/v1/local/log', '/local/log']],
  ['GET', 'envCheck', ['/v1/local/env/check', '/local/env/check']],
  ['GET', 'envInstallJobs', ['/v1/local/env/install-jobs', '/local/env/install-jobs']],
  ['POST', 'envUpgrade', ['/v1/local/env/upgrade', '/local/env/upgrade']],
  ['GET', 'diagnosticsGet', ['/v1/local/diagnostics', '/local/diagnostics']],
  ['POST', 'diagnosticsClear', ['/v1/local/diagnostics/clear', '/local/diagnostics/clear']],
  ['GET', 'certStatus', ['/v1/local/cert', '/local/cert']],
  ['POST', 'certTrust', ['/v1/local/cert/trust', '/local/cert/trust']],
  ['POST', 'certUntrust', ['/v1/local/cert/untrust', '/local/cert/untrust']],
  ['POST', 'modelsList', ['/v1/local/models/list', '/local/models/list']],
  ['POST', 'routeTest', ['/v1/local/route/test', '/local/route/test']],
  ['POST', 'latency', ['/v1/local/profile/latency', '/local/profile/latency']],
  ['POST', 'promptsSync', ['/v1/local/prompts/sync', '/local/prompts/sync']],
  ['GET', 'promptsPresetsGet', ['/v1/local/prompts/presets', '/local/prompts/presets']],
  ['POST', 'promptsPresetsApply', ['/v1/local/prompts/presets/apply', '/local/prompts/presets/apply']],
  ['POST', 'promptsPresetsSave', ['/v1/local/prompts/presets', '/local/prompts/presets']],
  ['GET', 'mcpHubGet', ['/v1/local/mcp-hub', '/local/mcp-hub']],
  ['POST', 'mcpHubSave', ['/v1/local/mcp-hub', '/local/mcp-hub']],
  ['GET', 'mcpHubLogs', ['/v1/local/mcp-hub/logs', '/local/mcp-hub/logs']],
  ['GET', 'claudeCodeStatus', ['/v1/local/claude-code/status', '/local/claude-code/status']],
  ['POST', 'claudeCodeApply', ['/v1/local/claude-code/apply', '/local/claude-code/apply']],
  ['POST', 'claudeCodeRestore', ['/v1/local/claude-code/restore', '/local/claude-code/restore']],
  ['GET', 'antigravityCliStatus', ['/v1/local/antigravity-cli/status', '/local/antigravity-cli/status']],
  ['GET', 'traeStatus', ['/v1/local/trae/status', '/local/trae/status', '/v1/local/trae-international/status', '/local/trae-international/status']],
  ['GET', 'traeBridgeStatus', ['/v1/local/trae/bridge/status', '/local/trae/bridge/status']],
  ['GET', 'traeDebugEvents', ['/v1/local/trae/debug/events', '/local/trae/debug/events']],
  ['GET', 'traeDebugSettings', ['/v1/local/trae/debug/settings', '/local/trae/debug/settings']],
  ['POST', 'traeDebugSettingsSave', ['/v1/local/trae/debug/settings', '/local/trae/debug/settings']],
  ['GET', 'traeDebugNativeStatus', ['/v1/local/trae/debug/native/status', '/local/trae/debug/native/status']],
  ['POST', 'traeDebugNativeScan', ['/v1/local/trae/debug/native/scan', '/local/trae/debug/native/scan']],
  ['POST', 'antigravityCliApply', ['/v1/local/antigravity-cli/apply', '/local/antigravity-cli/apply']],
  ['POST', 'antigravityCliRestore', ['/v1/local/antigravity-cli/restore', '/local/antigravity-cli/restore']],
  ['GET', 'claudeDesktopStatus', ['/v1/local/claude-desktop/status', '/local/claude-desktop/status']],
  ['POST', 'claudeDesktopApply', ['/v1/local/claude-desktop/apply', '/local/claude-desktop/apply']],
  ['POST', 'claudeDesktopRestore', ['/v1/local/claude-desktop/restore', '/local/claude-desktop/restore']],
  ['GET', 'codexStatus', ['/v1/local/codex/status', '/local/codex/status']],
  ['POST', 'codexApply', ['/v1/local/codex/apply', '/local/codex/apply']],
  ['POST', 'codexRestore', ['/v1/local/codex/restore', '/local/codex/restore']],
  ['POST', 'codexSwitch', ['/v1/local/codex/switch', '/local/codex/switch']],
  ['POST', 'codexApiLogin', ['/v1/local/codex/auth/api-login', '/local/codex/auth/api-login']],
  ['POST', 'codexOfficialLogin', ['/v1/local/codex/auth/official-login', '/local/codex/auth/official-login']],
  ['POST', 'codexAuthBackup', ['/v1/local/codex/auth/backup', '/local/codex/auth/backup']],
  ['GET', 'codexDesktopStatus', ['/v1/local/codex-desktop/status', '/local/codex-desktop/status']],
  ['POST', 'codexDesktopApply', ['/v1/local/codex-desktop/apply', '/local/codex-desktop/apply']],
  ['POST', 'codexDesktopRestore', ['/v1/local/codex-desktop/restore', '/local/codex-desktop/restore']],
  ['POST', 'codexDesktopSwitch', ['/v1/local/codex-desktop/switch', '/local/codex-desktop/switch']],
  ['POST', 'codexDesktopApiLogin', ['/v1/local/codex-desktop/auth/api-login', '/local/codex-desktop/auth/api-login']],
  ['POST', 'codexDesktopOfficialLogin', ['/v1/local/codex-desktop/auth/official-login', '/local/codex-desktop/auth/official-login']],
  ['POST', 'codexDesktopAuthBackup', ['/v1/local/codex-desktop/auth/backup', '/local/codex-desktop/auth/backup']],
  ['GET', 'geminiCliStatus', ['/v1/local/gemini-cli/status', '/local/gemini-cli/status']],
  ['POST', 'geminiCliApply', ['/v1/local/gemini-cli/apply', '/local/gemini-cli/apply']],
  ['POST', 'geminiCliRestore', ['/v1/local/gemini-cli/restore', '/local/gemini-cli/restore']],
  ['GET', 'cliCredentials', ['/v1/local/auth/cli-credentials', '/local/auth/cli-credentials'], 'prefix'],
  ['GET', 'rateLimits', ['/v1/local/auth/rate-limits', '/local/auth/rate-limits'], 'prefix'],
  ['GET', 'events', ['/v1/local/events', '/local/events']],
  ['POST', 'eventsClear', ['/v1/local/events/clear', '/local/events/clear']],
  ['GET', 'metrics', ['/v1/local/metrics', '/local/metrics', '/metrics']],
].map(([method, handlerName, paths, match = 'exact']) => ({ method, handlerName, paths, match }));

function routeMatches(route, method, pathname) {
  if (route.method !== String(method || '').toUpperCase()) return false;
  const value = String(pathname || '').split('?')[0];
  if (route.match === 'prefix') return route.paths.some((prefix) => value.indexOf(prefix) === 0);
  return route.paths.includes(value);
}

function dispatchLocalManagementRoute(options) {
  const { method, pathname, req, res, handlers } = options || {};
  for (const route of ROUTES) {
    if (!routeMatches(route, method, pathname)) continue;
    const legacyHandlerName = 'handleLocal' + route.handlerName.charAt(0).toUpperCase() + route.handlerName.slice(1) + 'Request';
    const handler = handlers && (handlers[route.handlerName] || handlers[legacyHandlerName]);
    if (typeof handler !== 'function') {
      throw new Error(`Missing local management handler: ${route.handlerName}`);
    }
    handler(req, res);
    return true;
  }
  return false;
}

module.exports = {
  ROUTES,
  routeMatches,
  dispatchLocalManagementRoute,
};
