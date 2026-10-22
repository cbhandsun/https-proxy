const { debounceReload: defaultDebounceReload } = require('./config-watcher');
const { composeContextProtocolOptions } = require('./context-recovery-policy');
const { contextRecoveryDiagnostics } = require('./context-recovery-diagnostics');

function createRuntimeConfigController(dependencies = {}) {
  const {
    configFile,
    createHttpsAgent,
    defaultProtocolOptions,
    getActiveProfile,
    getClaudeDesktopRoutes,
    getLocalServer,
    getModelRoutes,
    getProfiles,
    loadConfig,
    log,
    metricsInstance,
    protocolOptions,
    rebuildProxyRouteIndex,
    resetLocalProxyDetectionCache,
    setHttpsAgent,
    setRuntimeState,
    contextRecoveryLifecycle,
    recoveryDiagnostics = contextRecoveryDiagnostics,
    debounceReload = defaultDebounceReload,
  } = dependencies;
  if (typeof loadConfig !== 'function' || typeof setRuntimeState !== 'function') {
    throw new TypeError('createRuntimeConfigController requires loadConfig and setRuntimeState');
  }
  recoveryDiagnostics.attachPlannerOptions(protocolOptions);
  let configureRecovery;
  if (contextRecoveryLifecycle !== undefined) {
    const settingsSlot = Object.getOwnPropertyDescriptor(
      contextRecoveryLifecycle,
      'configureSettings'
    );
    const slot =
      settingsSlot || Object.getOwnPropertyDescriptor(contextRecoveryLifecycle, 'configure');
    if (typeof slot?.value !== 'function')
      throw new TypeError('Invalid recovery lifecycle composition');
    const apply = slot.value.bind(contextRecoveryLifecycle);
    configureRecovery = settingsSlot
      ? apply
      : (config) => apply(config.appSettings?.contextRecoveryEnabled === true);
  }

  function applyConfig(nextConfig, { hotReload = false } = {}) {
    const profiles = getProfiles(nextConfig);
    const activeProfile = getActiveProfile(nextConfig);
    const localServer = getLocalServer(nextConfig);
    const modelRoutes = getModelRoutes(nextConfig);
    const claudeDesktopRoutes = getClaudeDesktopRoutes(nextConfig);
    const nextOptions = composeContextProtocolOptions(defaultProtocolOptions, nextConfig);
    for (const key of Reflect.ownKeys(protocolOptions)) delete protocolOptions[key];
    Object.defineProperties(protocolOptions, Object.getOwnPropertyDescriptors(nextOptions));

    const httpsAgent = createHttpsAgent();
    setHttpsAgent(httpsAgent);
    setRuntimeState({
      config: nextConfig,
      profiles,
      activeProfile,
      localServer,
      modelRoutes,
      claudeDesktopRoutes,
    });
    configureRecovery?.(nextConfig);

    if (hotReload) {
      resetLocalProxyDetectionCache();
      log.info(
        '[config] Configuration hot-reloaded successfully. Active profile:',
        activeProfile.id
      );
      try {
        metricsInstance.counter('proxy_config_reloads_total').inc();
        metricsInstance.gauge('proxy_active_profile_id').set(1, { id: activeProfile.id });
        if (rebuildProxyRouteIndex(modelRoutes)) {
          metricsInstance.counter('proxy_route_cache_total').inc(1, { event: 'rebuild' });
        }
      } catch (error) {}
    } else {
      log.info('[config] Configuration reloaded (legacy). Active profile:', activeProfile.id);
    }
    return nextConfig;
  }

  let watcher = null;
  try {
    watcher = debounceReload(
      configFile,
      (nextConfig) => {
        try {
          applyConfig(nextConfig, { hotReload: true });
        } catch (error) {
          log.error('[config] Failed to apply hot-reload configuration:', error.message);
          throw error;
        }
      },
      {
        onError: (error) => log.warn('[config] Hot-reload error:', error?.message),
        loadConfigFn: () => loadConfig({ throwOnError: true }),
      }
    );
  } catch (error) {
    log.warn('[config] Failed to watch config file:', error.message);
  }

  function reloadProxyConfig() {
    if (watcher && typeof watcher.scheduleNow === 'function') {
      watcher.scheduleNow();
      return;
    }
    try {
      applyConfig(loadConfig({ throwOnError: true }));
    } catch (error) {
      log.error('[config] Failed to reload configuration:', error.message);
    }
  }

  return {
    applyConfig,
    close: () => watcher?.close?.(),
    reloadProxyConfig,
  };
}

module.exports = { createRuntimeConfigController };
