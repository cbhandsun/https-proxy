'use strict';

const { createLazyHandlerGroup } = require('./lazy-handler-group');

const FEATURE_HANDLERS = Object.freeze({
  cert: [
    'handleLocalCertStatusRequest',
    'handleLocalCertTrustRequest',
    'handleLocalCertUntrustRequest',
  ],
  prompts: ['handleLocalPromptsSyncRequest', 'handleLocalPromptsPresetsRequest'],
  toolConfig: [
    'handleLocalAntigravityCliStatusRequest',
    'handleLocalAntigravityCliApplyRequest',
    'handleLocalAntigravityCliRestoreRequest',
    'handleLocalClaudeCodeStatusRequest',
    'handleLocalClaudeCodeApplyRequest',
    'handleLocalClaudeCodeRestoreRequest',
    'handleLocalCodexStatusRequest',
    'handleLocalCodexApplyRequest',
    'handleLocalCodexRestoreRequest',
    'handleLocalCodexSwitchRequest',
    'handleLocalCodexApiLoginRequest',
    'handleLocalCodexOfficialLoginRequest',
    'handleLocalCodexAuthBackupRequest',
    'handleLocalCodexDesktopStatusRequest',
    'handleLocalCodexDesktopApplyRequest',
    'handleLocalCodexDesktopRestoreRequest',
    'handleLocalCodexDesktopSwitchRequest',
    'handleLocalCodexDesktopApiLoginRequest',
    'handleLocalCodexDesktopOfficialLoginRequest',
    'handleLocalCodexDesktopAuthBackupRequest',
    'handleLocalGeminiCliStatusRequest',
    'handleLocalGeminiCliApplyRequest',
    'handleLocalGeminiCliRestoreRequest',
  ],
  traeBridge: [
    'callTraeOfficialBridge',
    'streamTraeOfficialBridge',
    'writeTraeBridgeOpenAIStream',
    'writeTraeBridgeOpenAILiveStream',
    'buildTraeBridgeOpenAIResponsesResponse',
    'writeTraeBridgeOpenAIResponsesStream',
    'writeTraeBridgeOpenAIResponsesLiveStream',
    'buildTraeBridgeClaudeMessageResponse',
    'writeTraeBridgeClaudeStream',
    'writeTraeBridgeClaudeLiveStream',
  ],
  traeOfficial: [
    'handleTraeOfficialChatCompletion',
    'handleTraeOfficialResponses',
    'handleTraeOfficialClaudeMessages',
  ],
  tianxiBridge: ['callTianxiOfficialBridge'],
  tianxiOfficial: ['handleTianxiOfficialResponses'],
  traeStatus: [
    'handleLocalTraeStatusRequest',
    'handleLocalTraeBridgeStatusRequest',
    'handleLocalTraeDebugEventsRequest',
    'handleLocalTraeDebugSettingsRequest',
    'handleLocalTraeDebugSettingsSaveRequest',
    'handleLocalTraeDebugClaudeProcessSelfTestRequest',
    'handleLocalTraeDebugNativeStatusRequest',
    'handleLocalTraeDebugNativeScanRequest',
    'handleLocalTraeDebugNativeDeepEventsRequest',
    'handleLocalTraeDebugNativeDeepStartRequest',
    'handleLocalTraeDebugNativeDeepStopRequest',
  ],
});

function createLazyFeatureHandlers(
  handlerNames,
  modulePath,
  factoryName,
  dependencies,
  options = {}
) {
  const loadModule = options.loadModule || (() => require(modulePath));
  return createLazyHandlerGroup(handlerNames, () => {
    const loaded = loadModule();
    if (!factoryName) return loaded;
    const factory = loaded && loaded[factoryName];
    if (typeof factory !== 'function') {
      throw new TypeError(modulePath + ' must export ' + factoryName);
    }
    return factory(dependencies);
  });
}

function createLazyCertHandlers(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.cert,
    './cert-management',
    'createCertManagement',
    dependencies,
    options
  );
}

function createLazyPromptsHandlers(options) {
  return createLazyFeatureHandlers(FEATURE_HANDLERS.prompts, './prompts-sync', null, null, options);
}

function createLazyToolConfigHandlers(options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.toolConfig,
    './tool-config-handlers',
    'createToolConfigHandlers',
    undefined,
    options
  );
}

function createLazyTraeBridgeRuntime(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.traeBridge,
    './trae-bridge-runtime',
    'createTraeBridgeRuntime',
    dependencies,
    options
  );
}

function createLazyTraeOfficialHandlers(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.traeOfficial,
    './trae-official-handlers',
    'createTraeOfficialHandlers',
    dependencies,
    options
  );
}

function createLazyTraeStatusHandlers(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.traeStatus,
    './trae-status-handlers',
    'createTraeStatusHandlers',
    dependencies,
    options
  );
}

function createLazyTianxiBridgeRuntime(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.tianxiBridge,
    './tianxi-bridge-runtime',
    'createTianxiBridgeRuntime',
    dependencies,
    options
  );
}

function createLazyTianxiOfficialHandlers(dependencies, options) {
  return createLazyFeatureHandlers(
    FEATURE_HANDLERS.tianxiOfficial,
    './tianxi-official-handlers',
    'createTianxiOfficialHandlers',
    dependencies,
    options
  );
}

module.exports = {
  createLazyCertHandlers,
  createLazyFeatureHandlers,
  createLazyPromptsHandlers,
  createLazyToolConfigHandlers,
  createLazyTianxiBridgeRuntime,
  createLazyTianxiOfficialHandlers,
  createLazyTraeBridgeRuntime,
  createLazyTraeOfficialHandlers,
  createLazyTraeStatusHandlers,
};
