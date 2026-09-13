export function createSharedAppState() {
  return Object.seal({
    diagnosticsRefreshInFlight: false,
    heartbeatTimer: null,
    lastEventTime: null,
    lastLogAutoRefreshAt: 0,
    lastRenderedDiagnosticsOutput: '',
    lastRenderedDiagnosticsStatus: '',
    lastRenderedLog: '',
    lastRenderedMonitorHtml: null,
    lastStatusRefresh: 0,
    logRefreshInFlight: false,
    logRefreshTimer: null,
    monitorEvents: [],
    monitorPaused: false,
    monitorRefreshInFlight: false,
    monitorVisibleCount: null,
    startupProxyRetryTimer: null,
    statusRefreshInFlight: false,
    viewDomCache: null,
  });
}
