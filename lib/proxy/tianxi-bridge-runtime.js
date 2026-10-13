'use strict';

const { createTacServerTianxiNativeRuntime } = require('./tianxi-native-runtime');
const { createTianxiSdkRuntime } = require('./tianxi-sdk-runtime');
const { isTianxiOfficialProfile } = require('./tianxi-official');
const { parseTianxiBridgeFramesPayload } = require('./tianxi-responses');

const DIRECT_BRIDGE_URL = 'tianxi://tac-server';

function parseJsonBody(text) {
  try {
    return JSON.parse(text || '{}');
  } catch (err) {
    const wrapped = new Error('Invalid Tianxi bridge JSON response: ' + err.message);
    wrapped.cause = err;
    throw wrapped;
  }
}

function hasTianxiBridgeFrameShape(payload) {
  if (Array.isArray(payload)) return true;
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload.frames)) return true;
  if (Array.isArray(payload.events)) return true;
  if (Array.isArray(payload.data)) return true;
  return typeof payload.type === 'string' && payload.type.length > 0;
}

function assertTianxiBridgeFrameShape(payload, bridgeUrl) {
  if (hasTianxiBridgeFrameShape(payload)) return;
  const err = new Error('Invalid Tianxi bridge response payload.');
  err.code = 'tianxi_bridge_invalid_response';
  err.statusCode = 502;
  err.bridgeUrl = bridgeUrl;
  throw err;
}

function isDisabled(value) {
  return value === false || value === 'false' || value === '0' || value === 0;
}

function profileAllowsDirectRuntime(profile, env) {
  if (isDisabled(env && env.HPM_TIANXI_DIRECT)) return false;
  if (profile && (isDisabled(profile.tianxiDirect) || isDisabled(profile.directRuntime))) {
    return false;
  }
  return true;
}

function shouldUseDirectRuntime(profile, env) {
  if (!profileAllowsDirectRuntime(profile, env)) return false;
  if (profile && profile.bridgeUrl && !profile.tianxiDirect) return false;
  if (profile && profile.tianxiRuntime === 'tac-server') return true;
  if (env && env.HPM_TIANXI_RUNTIME === 'tac-server') return true;
  return isTianxiOfficialProfile(profile) || (profile && profile.protocol === 'tianxi');
}

function createTianxiBridgeRuntime({
  makeRequest,
  getTianxiOfficialBridgeUrl,
  createDirectRuntime = createTacServerTianxiNativeRuntime,
  createSdkRuntime = createTianxiSdkRuntime,
  env = process.env,
} = {}) {
  if (typeof makeRequest !== 'function') {
    throw new TypeError('createTianxiBridgeRuntime requires makeRequest');
  }
  if (typeof getTianxiOfficialBridgeUrl !== 'function') {
    throw new TypeError('createTianxiBridgeRuntime requires getTianxiOfficialBridgeUrl');
  }

  async function callTianxiOfficialBridge(payload, profile, context = {}) {
    if (shouldUseDirectRuntime(profile, env)) {
      const useSdk = typeof payload?.metadata?.tianxi?.sdk_model === 'string';
      const runtime = (useSdk ? createSdkRuntime : createDirectRuntime)({
        timeoutMs: (profile && profile.timeoutMs) || env.HPM_TIANXI_RUNTIME_TIMEOUT_MS,
      });
      const result = await runtime.sendResponses(payload, context);
      return {
        bridgeUrl: useSdk ? 'tianxi://sdk' : DIRECT_BRIDGE_URL,
        frames: parseTianxiBridgeFramesPayload(result),
        raw: result,
        mode: 'direct',
      };
    }
    const bridgeUrl = getTianxiOfficialBridgeUrl('/v1/responses', profile);
    const body = JSON.stringify(payload || {});
    const response = await makeRequest(
      bridgeUrl,
      {
        method: 'POST',
        timeout: (profile && profile.timeoutMs) || 300000,
        maxResponseBytes: 16 * 1024 * 1024,
        signal: context.signal,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      body
    );
    if (!response || response.statusCode < 200 || response.statusCode >= 300) {
      const err = new Error(
        'Tianxi bridge request failed with status ' + (response && response.statusCode)
      );
      err.statusCode = response && response.statusCode;
      err.bridgeUrl = bridgeUrl;
      throw err;
    }
    const parsed = parseJsonBody(response.body);
    assertTianxiBridgeFrameShape(parsed, bridgeUrl);
    return {
      bridgeUrl,
      frames: parseTianxiBridgeFramesPayload(parsed),
      raw: parsed,
    };
  }

  return {
    callTianxiOfficialBridge,
  };
}

module.exports = {
  createTianxiBridgeRuntime,
  shouldUseDirectRuntime,
};
