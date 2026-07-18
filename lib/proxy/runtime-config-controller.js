const { debounceReload: defaultDebounceReload } = require('./config-watcher');

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
    debounceReload = defaultDebounceReload,
  } = dependencies;
  if (typeof loadConfig !== 'function' || typeof setRuntimeState !== 'function') {
    throw new TypeError('createRuntimeConfigController requires loadConfig and setRuntimeState');
  }

  function applyConfig(nextConfig, { hotReload = false } = {}) {
    const profiles = getProfiles(nextConfig);
    const activeProfile = getActiveProfile(nextConfig);
    const localServer = getLocalServer(nextConfig);
    const modelRoutes = getModelRoutes(nextConfig);
    const claudeDesktopRoutes = getClaudeDesktopRoutes(nextConfig);
    const nextOptions = {
      ...defaultProtocolOptions,
      ...(nextConfig.protocolOptions || {}),
    };
    for (const key of Object.keys(protocolOptions)) delete protocolOptions[key];
    Object.assign(protocolOptions, nextOptions);

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
      applyConfig(loadConfig());
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
