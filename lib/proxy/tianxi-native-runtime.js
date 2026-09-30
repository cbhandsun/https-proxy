'use strict';

const fs = require('node:fs');
const { AbortController } = globalThis;
const {
  createTacServerTransport,
  inspectTianxiCredentialExpiry,
  readLatestAgentCoreHeader,
  readTianxiRegistryCredentialCacheWithFallback,
} = require('./tianxi-agentcore-local');
const {
  buildTianxiAgentCoreFrames,
  buildTianxiNativeApiQueryFrame,
  parseTianxiAgentCoreNotify,
} = require('./tianxi-agentcore-protocol');
const { parseTianxiBridgeFramesPayload } = require('./tianxi-responses');
const {
  injectTianxiServiceAccountToken,
  refreshTianxiQoderToken,
  sanitizeRefreshState,
  triggerTianxiSuperModeRefresh,
} = require('./tianxi-token-refresh');
const { readLatestQoderRuntimeSummaries } = require('./tianxi-super-probe');

const DEFAULT_TIANXI_NATIVE_TIMEOUT_MS = 300000;
// Default native budgets measure absence of progress, not the duration of a whole agent task.
const DEFAULT_TIANXI_TAC_SERVER_TIMEOUT_MS = 1800000;
const DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS = 120000;
const DEFAULT_MODELS = ['tianxi/super'];

class TianxiNativeRuntimeError extends Error {
  constructor(code, status = 502, details = {}) {
    super(code);
    this.name = 'TianxiNativeRuntimeError';
    this.code = code;
    this.status = status;
    if (details && details.cause) this.cause = details.cause;
    const diagnostics = sanitizeNativeRuntimeDiagnostics(details && details.diagnostics);
    if (diagnostics) this.diagnostics = diagnostics;
  }
}

function sanitizeNativeRuntimeText(value) {
  return String(value || '')
    .replace(/sat-[A-Za-z0-9._-]+/g, 'sat-<redacted>')
    .replace(
      /\b(authorization|cookie|set-cookie|token|access_token|refresh_token)\b\s*[:=]\s*[^,\s}]+/gi,
      '$1=<redacted>'
    )
    .replace(/[A-Za-z0-9_+/=-]{120,}/g, '<redacted-long>');
}

function sanitizeNativeRuntimeDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
    return null;
  }
  const allowed = {};
  for (const key of ['cause_name', 'cause_code', 'cause_message', 'phase']) {
    if (diagnostics[key] == null) continue;
    const safe = sanitizeNativeRuntimeText(diagnostics[key]).slice(0, 500);
    if (safe) allowed[key] = safe;
  }
  return Object.keys(allowed).length > 0 ? allowed : null;
}

function toPositiveInteger(value, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 2147483647 ? number : fallback;
}

function knownRuntimeError(error) {
  if (error instanceof TianxiNativeRuntimeError) return error;
  return new TianxiNativeRuntimeError('tianxi_native_runtime_failed', 502, {
    cause: error,
    diagnostics: {
      cause_name: error && error.name,
      cause_code: error && error.code,
      cause_message: error && error.message,
    },
  });
}

function createAbortOrTimeoutPromise(signal, timeoutMs, timeoutMode) {
  let timeout = null;
  let cleanup = () => {};
  let active = true;
  let resetTimeout = () => {};
  const controller = new AbortController();
  const promise = new Promise((_, reject) => {
    const abort = () => {
      active = false;
      reject(new TianxiNativeRuntimeError('tianxi_native_runtime_aborted', 499));
      controller.abort();
    };
    cleanup = () => {
      active = false;
      if (timeout) clearTimeout(timeout);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abort);
      }
    };
    if (signal && signal.aborted) {
      abort();
      return;
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', abort, { once: true });
    }
    resetTimeout = () => {
      if (!active) return;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        active = false;
        reject(new TianxiNativeRuntimeError('tianxi_native_runtime_timeout', 504));
        controller.abort();
      }, timeoutMs);
    };
    resetTimeout();
  });
  return {
    promise,
    cleanup,
    signal: controller.signal,
    onActivity: () => {
      if (timeoutMode === 'inactivity') resetTimeout();
    },
  };
}

function createTransportTianxiNativeRuntime({
  name,
  models = DEFAULT_MODELS,
  send,
  timeoutMs = DEFAULT_TIANXI_NATIVE_TIMEOUT_MS,
  timeoutMode = 'total',
} = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createTransportTianxiNativeRuntime requires send');
  }
  const safeTimeoutMs = toPositiveInteger(timeoutMs, DEFAULT_TIANXI_NATIVE_TIMEOUT_MS);
  return {
    name: typeof name === 'string' && name ? name : 'transport',
    models: Array.isArray(models) && models.length > 0 ? models : DEFAULT_MODELS,
    async sendResponses(payload, context = {}) {
      const guard = createAbortOrTimeoutPromise(context.signal, safeTimeoutMs, timeoutMode);
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => {
            if (guard.signal.aborted) return guard.promise;
            return send(payload, {
              ...context,
              signal: guard.signal,
              onActivity() {
                guard.onActivity();
                if (typeof context.onActivity === 'function') context.onActivity();
              },
            });
          }),
          guard.promise,
        ]);
        return { frames: parseTianxiBridgeFramesPayload(result) };
      } catch (error) {
        throw knownRuntimeError(error);
      } finally {
        guard.cleanup();
      }
    },
  };
}

function createFixtureTianxiNativeRuntime(options = {}) {
  const text =
    typeof options.text === 'string' && options.text
      ? options.text
      : 'Tianxi bridge development runtime is connected.';
  return createTransportTianxiNativeRuntime({
    name: 'fixture',
    models: options.models,
    timeoutMs: options.timeoutMs,
    async send(payload) {
      return {
        frames: [
          {
            type: 'task_output',
            data: { reasoning_content: `接收到模型 ${payload.model} 的 Responses 请求。` },
          },
          { type: 'task_output', data: { content_type: 'text', content: text } },
          { type: 'task_status', data: { status: 'COMPLETED' } },
        ],
      };
    },
  });
}

function createFileTianxiNativeRuntime(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TianxiNativeRuntimeError('tianxi_native_frames_file_required', 500);
  }
  return createTransportTianxiNativeRuntime({
    name: 'frames-file',
    models: options.models,
    timeoutMs: options.timeoutMs,
    async send() {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    },
  });
}

function createUnavailableTianxiNativeRuntime(options = {}) {
  return createTransportTianxiNativeRuntime({
    name: 'native-unavailable',
    models: options.models,
    timeoutMs: options.timeoutMs,
    async send() {
      throw new TianxiNativeRuntimeError('tianxi_native_runtime_unavailable', 501);
    },
  });
}

function createAgentCoreTianxiNativeRuntime({ transport, timeoutMs, models } = {}) {
  if (!transport || typeof transport.sendAgentCoreFrames !== 'function') {
    throw new TypeError(
      'createAgentCoreTianxiNativeRuntime requires transport.sendAgentCoreFrames'
    );
  }
  return createTransportTianxiNativeRuntime({
    name: 'agentcore',
    models,
    timeoutMs,
    async send(payload, context) {
      const request = buildTianxiAgentCoreFrames(payload, {
        now: context.now,
        uuid: context.uuid,
      });
      const result = await transport.sendAgentCoreFrames(request, context);
      return { frames: parseTianxiAgentCoreNotify(result) };
    },
  });
}

function isTerminalTianxiFrame(frame) {
  if (!frame || frame.type !== 'task_status') return false;
  const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
  return ['COMPLETED', 'FAILED', 'CANCELED'].includes(
    String(data.status || frame.status || '').toUpperCase()
  );
}

function isVisibleTianxiFrame(frame) {
  return ['task_output', 'act_exec', 'act_resp', 'risk_exec'].includes(frame && frame.type);
}

function frameData(frame) {
  return frame && frame.data && typeof frame.data === 'object' ? frame.data : {};
}

function getFrameText(frame) {
  const data = frameData(frame);
  return [
    frame && frame.error,
    frame && frame.message,
    frame && frame.error_detail,
    data.error,
    data.message,
    data.error_detail,
    data.error_message,
    data.status,
  ]
    .filter((value) => value != null)
    .map((value) => String(value))
    .join('\n');
}

function isTianxiQoderAuthFailure(frames) {
  if (!Array.isArray(frames)) return false;
  return frames.some((frame) => {
    const data = frameData(frame);
    const status = String(data.status || frame.status || '').toUpperCase();
    const errorCode = String(data.error_code || frame.error_code || '').toUpperCase();
    const text = getFrameText(frame).toLowerCase();
    return (
      (status === 'FAILED' || errorCode === 'INVALID_CREDENTIALS') &&
      (text.includes('service account token') ||
        text.includes('catalog not ready') ||
        text.includes('auth not ready') ||
        text.includes('authentication'))
    );
  });
}

function buildQoderRuntimeState(options = {}) {
  const readRuns =
    typeof options.readLatestQoderRuntimeSummaries === 'function'
      ? options.readLatestQoderRuntimeSummaries
      : () => readLatestQoderRuntimeSummaries({ limit: 3 });
  try {
    const runs = readRuns();
    const safeRuns = Array.isArray(runs) ? runs.slice(0, 3) : [];
    const latest = safeRuns[0] || null;
    return {
      latestClassification:
        latest && typeof latest.classification === 'string' ? latest.classification : '',
      latestRunLastTimestamp:
        latest && typeof latest.lastTimestamp === 'string' ? latest.lastTimestamp : '',
      latestInitializeStatus:
        latest && typeof latest.initializeStatus === 'string' ? latest.initializeStatus : '',
      latestCatalogReady:
        latest && typeof latest.catalogReady === 'boolean' ? latest.catalogReady : null,
      recentClassifications: safeRuns
        .map((run) => (run && typeof run.classification === 'string' ? run.classification : ''))
        .filter(Boolean),
    };
  } catch (_err) {
    return {
      latestClassification: '',
      latestRunLastTimestamp: '',
      latestInitializeStatus: '',
      latestCatalogReady: null,
      recentClassifications: [],
    };
  }
}

function attachRefreshStateToFailedFrames(frames, refreshState, diagnostics = {}) {
  return (Array.isArray(frames) ? frames : []).map((frame) => {
    const data = frameData(frame);
    const status = String(data.status || frame.status || '').toUpperCase();
    if (
      status !== 'FAILED' &&
      String(data.error_code || frame.error_code || '') !== 'INVALID_CREDENTIALS'
    ) {
      return frame;
    }
    return {
      ...frame,
      data: {
        ...data,
        refresh_state: sanitizeRefreshState(refreshState),
        ...diagnostics,
      },
    };
  });
}

function requiresQoderServiceAccount(payload) {
  const model = String((payload && payload.model) || '').toLowerCase();
  const metadata =
    payload && payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const tianxi = metadata.tianxi && typeof metadata.tianxi === 'object' ? metadata.tianxi : {};
  const requestedModel = String(metadata.requestedModel || metadata.requested_model || '')
    .trim()
    .toLowerCase();
  const routedModel = String(metadata.routedModel || metadata.routed_model || '')
    .trim()
    .toLowerCase();
  const llm = String(tianxi.llm || tianxi.model || '')
    .trim()
    .toLowerCase();
  const agentId = String(tianxi.agent_id || tianxi.agentId || '')
    .trim()
    .toLowerCase();
  const workMode = String(tianxi.workMode || tianxi.work_mode || '')
    .trim()
    .toLowerCase();
  return [model, requestedModel, routedModel, llm, agentId, workMode].some((value) =>
    ['tianxi/super', 'super', 'dfmodel', 'qoder'].includes(value)
  );
}

async function triggerDefaultTianxiSuperModeRefresh(options, context, refreshOptions = {}) {
  const result = await triggerTianxiSuperModeRefresh({
    exePath: options.tianxiSmartUiExePath,
    existsSync: options.existsSync,
    spawn: options.spawn,
    forceWindows: options.forceWindows,
    source: options.tianxiRefreshSource,
    content: options.tianxiRefreshContent,
    userId: refreshOptions.userId,
    now: context.now,
  });
  if (!result || result.attempted !== true) {
    const status = result && typeof result.status === 'string' ? result.status : 'unavailable';
    throw new Error(`tianxi_super_mode_refresh_${status}`);
  }
  return result;
}

function resolveTianxiQoderRefreshTrigger(options, context) {
  if (typeof options.triggerTianxiQoderRefresh === 'function') {
    return options.triggerTianxiQoderRefresh;
  }
  if (options.enableTianxiSuperModeRefresh === false) return undefined;
  return (refreshOptions) => triggerDefaultTianxiSuperModeRefresh(options, context, refreshOptions);
}

async function refreshQoderAfterTacServerAuthFailure({
  context,
  header,
  options,
  registryCache,
  transport,
}) {
  const refreshResult =
    typeof options.refreshQoderToken === 'function'
      ? await options.refreshQoderToken({
          header,
          registryCache,
          context,
          transport,
          reason: 'tac_server_auth_failure',
        })
      : await refreshTianxiQoderToken(
          {
            userId: header.user_id,
            readHeader:
              typeof options.readLatestAgentCoreHeader === 'function'
                ? options.readLatestAgentCoreHeader
                : () => readLatestAgentCoreHeader(options),
            previousToken: header.credentials?.qoder_token,
            readCache:
              typeof options.readTianxiRegistryCredentialCache === 'function'
                ? options.readTianxiRegistryCredentialCache
                : (readOptions) => readTianxiRegistryCredentialCacheWithFallback(readOptions),
            triggerNativeRefresh: resolveTianxiQoderRefreshTrigger(options, context),
            attempts: options.refreshAttempts,
            pollIntervalMs: options.refreshPollIntervalMs,
            force: true,
          },
          context
        );
  return {
    refreshResult,
    refreshState: sanitizeRefreshState(refreshResult),
    header: refreshResult?.header || header,
    registryCache: refreshResult?.cache || registryCache,
  };
}

function buildTianxiCredentialState(credentialExpiry) {
  const qoderExpired =
    credentialExpiry.qoder_token && typeof credentialExpiry.qoder_token.expired === 'boolean'
      ? credentialExpiry.qoder_token.expired
      : null;
  const txExpired =
    credentialExpiry.tx_token && typeof credentialExpiry.tx_token.expired === 'boolean'
      ? credentialExpiry.tx_token.expired
      : null;
  return {
    qoderExpired,
    txExpired,
    refreshPossibleWithTx: qoderExpired === true && txExpired === false,
  };
}

function buildTianxiRegistryCredentialState(registryCache) {
  const credentialExpiry =
    registryCache &&
    registryCache.credentialExpiry &&
    typeof registryCache.credentialExpiry === 'object'
      ? registryCache.credentialExpiry
      : {};
  const qoderExpired =
    credentialExpiry.qoder_token && typeof credentialExpiry.qoder_token.expired === 'boolean'
      ? credentialExpiry.qoder_token.expired
      : null;
  const loginExpired =
    credentialExpiry.tianxi_login_token &&
    typeof credentialExpiry.tianxi_login_token.expired === 'boolean'
      ? credentialExpiry.tianxi_login_token.expired
      : null;
  return {
    qoderExpired,
    loginExpired,
    hasQoderToken: Boolean(registryCache && registryCache.hasQoderToken),
    hasPlaintextQoderToken: Boolean(
      registryCache &&
      registryCache.credentials &&
      typeof registryCache.credentials.qoder_token === 'string' &&
      registryCache.credentials.qoder_token
    ),
    refreshPossibleWithLogin: qoderExpired === true && loginExpired === false,
  };
}

function mergeTianxiRegistryCredentials(header, registryCache) {
  const baseCredentials =
    header && header.credentials && typeof header.credentials === 'object'
      ? { ...header.credentials }
      : {};
  const qoderExpiry =
    registryCache &&
    registryCache.credentialExpiry &&
    registryCache.credentialExpiry.qoder_token &&
    typeof registryCache.credentialExpiry.qoder_token === 'object'
      ? registryCache.credentialExpiry.qoder_token
      : null;
  if (
    registryCache &&
    registryCache.credentials &&
    registryCache.credentials.qoder_token &&
    qoderExpiry &&
    qoderExpiry.expired === false
  ) {
    baseCredentials.qoder_token = registryCache.credentials.qoder_token;
  }
  return baseCredentials;
}

function mergeTianxiCredentialExpiry(logExpiry, registryCache) {
  const merged = logExpiry && typeof logExpiry === 'object' ? { ...logExpiry } : {};
  if (registryCache && registryCache.credentialExpiry) {
    const registryQoder = registryCache.credentialExpiry.qoder_token;
    if (
      registryQoder &&
      registryQoder.expired === false &&
      registryCache.credentials?.qoder_token
    ) {
      merged.qoder_token = registryQoder;
    } else if (!merged.qoder_token && registryQoder) {
      merged.qoder_token = registryQoder;
    }
    const registryLogin = registryCache.credentialExpiry.tianxi_login_token;
    if (registryLogin) merged.tianxi_login_token = registryLogin;
  }
  return merged;
}

async function maybeRefreshQoderCredentials({
  payload,
  context,
  credentialExpiry,
  header,
  options,
  registryCache,
  transport,
}) {
  if (
    !requiresQoderServiceAccount(payload) ||
    !credentialExpiry.qoder_token ||
    credentialExpiry.qoder_token.expired !== true
  ) {
    return { registryCache, credentials: null, credentialExpiry, refreshState: null };
  }
  const refreshResult =
    typeof options.refreshQoderToken === 'function'
      ? await options.refreshQoderToken({
          header,
          registryCache,
          context,
          transport,
        })
      : await refreshTianxiQoderToken(
          {
            userId: header.user_id,
            readHeader:
              typeof options.readLatestAgentCoreHeader === 'function'
                ? options.readLatestAgentCoreHeader
                : () => readLatestAgentCoreHeader(options),
            readCache:
              typeof options.readTianxiRegistryCredentialCache === 'function'
                ? options.readTianxiRegistryCredentialCache
                : (readOptions) => readTianxiRegistryCredentialCacheWithFallback(readOptions),
            triggerNativeRefresh: resolveTianxiQoderRefreshTrigger(options, context),
            attempts: options.refreshAttempts,
            pollIntervalMs: options.refreshPollIntervalMs,
          },
          context
        );
  const refreshedCache =
    refreshResult && refreshResult.cache && typeof refreshResult.cache === 'object'
      ? refreshResult.cache
      : registryCache;
  if (refreshResult && refreshResult.token) {
    const refreshedHeader = refreshResult.header || header;
    const refreshedCredentials = mergeTianxiRegistryCredentials(refreshedHeader, refreshedCache);
    const refreshedExpiry = mergeTianxiCredentialExpiry(
      inspectTianxiCredentialExpiry(refreshedCredentials, { now: context.now }),
      refreshedCache
    );
    return {
      registryCache: refreshedCache,
      header: refreshedHeader,
      credentials: refreshedCredentials,
      credentialExpiry: refreshedExpiry,
      refreshState: sanitizeRefreshState(refreshResult),
    };
  }
  if (refreshedCache && refreshedCache.credentialExpiry) {
    const refreshedCredentials = mergeTianxiRegistryCredentials(header, refreshedCache);
    const refreshedExpiry = mergeTianxiCredentialExpiry(
      inspectTianxiCredentialExpiry(refreshedCredentials, { now: context.now }),
      refreshedCache
    );
    if (refreshedExpiry.qoder_token && refreshedExpiry.qoder_token.expired === false) {
      return {
        registryCache: refreshedCache,
        credentials: refreshedCredentials,
        credentialExpiry: refreshedExpiry,
        refreshState: sanitizeRefreshState(refreshResult),
      };
    }
  }
  return {
    registryCache: refreshedCache,
    credentials: null,
    credentialExpiry,
    refreshState: sanitizeRefreshState(refreshResult),
  };
}

async function maybeInjectFreshQoderCredential({
  payload,
  credentials,
  context,
  enabled,
  header,
  transport,
}) {
  if (!enabled) {
    return { attempted: false, status: 'disabled', source: 'tac-server' };
  }
  if (!requiresQoderServiceAccount(payload)) {
    return { attempted: false, status: 'not_required', source: 'tac-server' };
  }
  const token =
    credentials && typeof credentials.qoder_token === 'string'
      ? credentials.qoder_token.trim()
      : '';
  if (!token) return { attempted: false, status: 'missing_token', source: 'tac-server' };
  return injectTianxiServiceAccountToken(transport, token, context, { header });
}

function createNativeApiChannelTianxiRuntime({ transport, timeoutMs, models } = {}) {
  if (!transport || typeof transport.sendChannelMessage !== 'function') {
    throw new TypeError(
      'createNativeApiChannelTianxiRuntime requires transport.sendChannelMessage'
    );
  }
  if (typeof transport.registerChannel !== 'function') {
    throw new TypeError('createNativeApiChannelTianxiRuntime requires transport.registerChannel');
  }
  return createTransportTianxiNativeRuntime({
    name: 'nativeApi-channel',
    models,
    timeoutMs,
    async send(payload, context) {
      const request = buildTianxiNativeApiQueryFrame(payload, {
        now: context.now,
        uuid: context.uuid,
      });
      const frames = [];
      let unregister = null;
      return await new Promise((resolve, reject) => {
        const finish = (error) => {
          if (typeof unregister === 'function') {
            try {
              unregister();
            } catch (_err) {}
          }
          if (context.signal && typeof context.signal.removeEventListener === 'function') {
            context.signal.removeEventListener('abort', abort);
          }
          if (error) reject(error);
          else resolve({ frames });
        };
        const abort = () =>
          finish(new TianxiNativeRuntimeError('tianxi_native_runtime_aborted', 499));
        if (context.signal && context.signal.aborted) {
          abort();
          return;
        }
        if (context.signal && typeof context.signal.addEventListener === 'function') {
          context.signal.addEventListener('abort', abort, { once: true });
        }
        unregister = transport.registerChannel(request.channelName, (message) => {
          const incoming = parseTianxiAgentCoreNotify(message);
          for (const frame of incoming) frames.push(frame);
          if (incoming.some(isTerminalTianxiFrame)) finish();
        });
        Promise.resolve(
          transport.sendChannelMessage(request.frame, request.channelName, context)
        ).catch((error) => finish(knownRuntimeError(error)));
      });
    },
  });
}

function createTacServerTianxiNativeRuntime(options = {}) {
  const transport = options.transport || createTacServerTransport(options);
  const idleTimeoutMs = toPositiveInteger(
    options.idleTimeoutMs,
    DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS
  );
  return createTransportTianxiNativeRuntime({
    name: 'tac-server',
    models: options.models,
    timeoutMs: toPositiveInteger(options.timeoutMs, DEFAULT_TIANXI_TAC_SERVER_TIMEOUT_MS),
    timeoutMode:
      options.timeoutMode || (toPositiveInteger(options.timeoutMs, null) ? 'total' : 'inactivity'),
    async send(payload, context) {
      let header = options.header || readLatestAgentCoreHeader(options);
      if (!header) {
        throw new TianxiNativeRuntimeError('tianxi_tac_header_unavailable', 503);
      }
      let registryCache =
        typeof options.readTianxiRegistryCredentialCache === 'function'
          ? options.readTianxiRegistryCredentialCache({
              userId: header.user_id,
              now: context.now,
            })
          : readTianxiRegistryCredentialCacheWithFallback({
              userId: header.user_id,
              now: context.now,
            });
      let credentials = mergeTianxiRegistryCredentials(header, registryCache);
      let credentialExpiry = mergeTianxiCredentialExpiry(
        inspectTianxiCredentialExpiry(credentials, {
          now: context.now,
        }),
        registryCache
      );
      const logCredentialExpiry = inspectTianxiCredentialExpiry(header.credentials, {
        now: context.now,
      });
      const refreshResult = await maybeRefreshQoderCredentials({
        payload,
        context,
        credentialExpiry,
        header,
        options,
        registryCache,
        transport,
      });
      registryCache = refreshResult.registryCache || registryCache;
      header = refreshResult.header || header;
      credentials = refreshResult.credentials || credentials;
      credentialExpiry = refreshResult.credentialExpiry || credentialExpiry;
      const credentialState = buildTianxiCredentialState(credentialExpiry);
      const qoderRuntimeState = buildQoderRuntimeState(options);
      if (
        requiresQoderServiceAccount(payload) &&
        credentialExpiry.qoder_token &&
        credentialExpiry.qoder_token.expired
      ) {
        return {
          frames: [
            {
              type: 'task_status',
              data: {
                status: 'FAILED',
                error_code: 'INVALID_CREDENTIALS',
                error_detail: 'Service Account token has expired',
                credential_state: credentialState,
                registry_credential_state: registryCache.available
                  ? buildTianxiRegistryCredentialState(registryCache)
                  : null,
                log_credential_state: buildTianxiCredentialState(logCredentialExpiry),
                qoder_runtime_state: qoderRuntimeState,
                refresh_state: refreshResult.refreshState,
              },
            },
          ],
        };
      }
      const buildRequest = (currentHeader, currentCredentials) =>
        buildTianxiNativeApiQueryFrame(
          {
            ...payload,
            metadata: {
              ...(payload && payload.metadata && typeof payload.metadata === 'object'
                ? payload.metadata
                : {}),
              tianxi: {
                ...(payload?.metadata?.tianxi || {}),
                app_id: currentHeader.app_id,
                app_version: currentHeader.app_version,
                credentials: currentCredentials,
                device_id: currentHeader.device_id,
                device_type: currentHeader.device_type,
                resource_id: currentHeader.resource_id,
                role: currentHeader.role,
                tab_id: currentHeader.tab_id,
                user_id: currentHeader.user_id,
              },
            },
          },
          { now: context.now, uuid: context.uuid }
        );
      const emitTerminalFrames = (frames) => {
        if (typeof context.onFrame !== 'function') return;
        for (const frame of frames) {
          if (isTerminalTianxiFrame(frame)) context.onFrame(frame);
        }
      };
      const emitFrames = (frames) => {
        if (typeof context.onFrame !== 'function') return;
        for (const frame of frames) context.onFrame(frame);
      };
      let workingProgress = null;
      const isWorkingStatus = (frame) => {
        const status = frameData(frame).status || frame.status;
        return (
          frame.type === 'task_status' &&
          typeof status === 'string' &&
          status.toUpperCase() === 'WORKING'
        );
      };
      const queryResult = (frames) => ({
        frames: workingProgress
          ? [workingProgress, ...frames.filter((frame) => !isWorkingStatus(frame))]
          : frames,
      });
      const sendStreamingQuery = async (nativeRequest) => {
        const queryContext = {
          ...context,
          allowPartialOnIdle: false,
          waitForTerminalOnIdle: true,
          idleTimeoutMs,
        };
        const live = { callbackFrameCount: 0, committed: false, pending: [] };
        if (typeof context.onFrame === 'function') {
          queryContext.onFrame = (value) => {
            for (const frame of parseTianxiAgentCoreNotify(value)) {
              if (isTerminalTianxiFrame(frame)) continue;
              live.callbackFrameCount += 1;
              // Status progress is safe to publish without committing content or disabling auth retry.
              if (isWorkingStatus(frame)) {
                if (!workingProgress) {
                  workingProgress = { type: 'task_status', data: { status: 'WORKING' } };
                  context.onFrame(workingProgress);
                }
                continue;
              }
              if (live.committed) {
                context.onFrame(frame);
                continue;
              }
              live.pending.push(frame);
              if (isVisibleTianxiFrame(frame)) {
                live.committed = true;
                emitFrames(live.pending);
                live.pending = [];
              }
            }
          };
        }
        const rawFrames = await transport.sendQuery(nativeRequest.frame, queryContext);
        return { frames: parseTianxiAgentCoreNotify(rawFrames), live };
      };
      const flushSuccessfulQuery = (query) => {
        if (query.live.committed) return;
        const frames =
          query.live.callbackFrameCount > 0
            ? query.live.pending
            : query.frames.filter((frame) => !isTerminalTianxiFrame(frame));
        emitFrames(frames);
        query.live.pending = [];
      };
      const request = buildRequest(header, credentials);
      await maybeInjectFreshQoderCredential({
        payload,
        credentials,
        context,
        enabled: options.enableSetTokenInjection === true,
        header: request.frame.header,
        transport,
      });
      const firstQuery = await sendStreamingQuery(request);
      const parsedFrames = firstQuery.frames;
      if (!requiresQoderServiceAccount(payload) || !isTianxiQoderAuthFailure(parsedFrames)) {
        flushSuccessfulQuery(firstQuery);
        emitTerminalFrames(parsedFrames);
        return queryResult(parsedFrames);
      }
      if (firstQuery.live.committed) {
        emitTerminalFrames(parsedFrames);
        return queryResult(parsedFrames);
      }
      const retryRefresh = await refreshQoderAfterTacServerAuthFailure({
        context,
        header,
        options,
        registryCache,
        transport,
      });
      if (
        !['refreshed', 'refreshed_encrypted_cache', 'refreshed_agentcore'].includes(
          retryRefresh.refreshState.status
        )
      ) {
        const failedFrames = attachRefreshStateToFailedFrames(
          parsedFrames,
          retryRefresh.refreshResult,
          { qoder_runtime_state: buildQoderRuntimeState(options) }
        );
        emitTerminalFrames(failedFrames);
        return queryResult(failedFrames);
      }
      const retryCredentials = mergeTianxiRegistryCredentials(
        retryRefresh.header,
        retryRefresh.registryCache
      );
      const retryRequest = buildRequest(retryRefresh.header, retryCredentials);
      await maybeInjectFreshQoderCredential({
        payload,
        credentials: retryCredentials,
        context,
        enabled: options.enableSetTokenInjection === true,
        header: retryRequest.frame.header,
        transport,
      });
      const retryQuery = await sendStreamingQuery(retryRequest);
      const parsedRetryFrames = retryQuery.frames;
      if (isTianxiQoderAuthFailure(parsedRetryFrames)) {
        const failedFrames = attachRefreshStateToFailedFrames(
          parsedRetryFrames,
          retryRefresh.refreshResult,
          { qoder_runtime_state: buildQoderRuntimeState(options) }
        );
        emitTerminalFrames(failedFrames);
        return queryResult(failedFrames);
      }
      flushSuccessfulQuery(retryQuery);
      emitTerminalFrames(parsedRetryFrames);
      return queryResult(parsedRetryFrames);
    },
  });
}

function createTianxiNativeRuntime(options = {}) {
  const env = options.env || process.env;
  const framesFile = options.framesFile || env.HPM_TIANXI_FRAMES_FILE;
  const mode = String(options.mode || env.HPM_TIANXI_RUNTIME || (framesFile ? 'file' : 'fixture'));
  const timeoutMs = toPositiveInteger(
    options.timeoutMs || env.HPM_TIANXI_RUNTIME_TIMEOUT_MS,
    mode === 'tac-server' ? DEFAULT_TIANXI_TAC_SERVER_TIMEOUT_MS : DEFAULT_TIANXI_NATIVE_TIMEOUT_MS
  );
  const idleTimeoutMs = toPositiveInteger(
    options.idleTimeoutMs || env.HPM_TIANXI_IDLE_TIMEOUT_MS,
    DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS
  );
  if (mode === 'file') return createFileTianxiNativeRuntime(framesFile, { timeoutMs });
  if (mode === 'tac-server') {
    const configuredTimeout = toPositiveInteger(
      options.timeoutMs || env.HPM_TIANXI_RUNTIME_TIMEOUT_MS,
      null
    );
    return createTacServerTianxiNativeRuntime({
      ...options,
      timeoutMs,
      idleTimeoutMs,
      timeoutMode: options.timeoutMode || (configuredTimeout ? 'total' : 'inactivity'),
    });
  }
  if (mode === 'native') return createUnavailableTianxiNativeRuntime({ timeoutMs });
  return createFixtureTianxiNativeRuntime({ timeoutMs });
}

module.exports = {
  DEFAULT_TIANXI_NATIVE_TIMEOUT_MS,
  DEFAULT_TIANXI_TAC_SERVER_TIMEOUT_MS,
  DEFAULT_TIANXI_NATIVE_IDLE_TIMEOUT_MS,
  TianxiNativeRuntimeError,
  createFileTianxiNativeRuntime,
  createAgentCoreTianxiNativeRuntime,
  createFixtureTianxiNativeRuntime,
  createNativeApiChannelTianxiRuntime,
  createTacServerTianxiNativeRuntime,
  createTianxiNativeRuntime,
  createTransportTianxiNativeRuntime,
  createUnavailableTianxiNativeRuntime,
  buildTianxiCredentialState,
  buildTianxiRegistryCredentialState,
  buildQoderRuntimeState,
};
