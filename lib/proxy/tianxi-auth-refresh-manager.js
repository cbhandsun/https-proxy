'use strict';
const { exchangeTianxiToken, candidateMatches, validIdentity } = require('./tianxi-auth-exchange');
const { inspectTianxiCredentialExpiry } = require('./tianxi-agentcore-local');
const KNOWN_ERRORS = new Set([
  'tianxi_auth_build_changed',
  'tianxi_auth_build_invalid',
  'tianxi_auth_application_mismatch',
  'tianxi_auth_identity_invalid',
  'tianxi_auth_aborted',
  'tianxi_auth_native_timeout',
  'tianxi_auth_native_failed',
  'tianxi_auth_native_reply_invalid',
  'tianxi_auth_exchange_http_failed',
  'tianxi_auth_exchange_reply_invalid',
  'tianxi_auth_exchange_rejected',
  'tianxi_auth_candidate_invalid',
  'tianxi_auth_account_changed',
]);
function sameIdentity(a, b) {
  return Boolean(a && b && ['user_id', 'app_id', 'device_id'].every((key) => a[key] === b[key]));
}
function waitFor(entry, signal) {
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      entry.waiters--;
      signal?.removeEventListener('abort', abort);
      if (entry.waiters === 0 && !entry.finished) entry.controller.abort();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error('tianxi_auth_aborted'));
    entry.promise.then(
      (value) => finish(null, value),
      (error) => finish(error)
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
function createTianxiAuthRefreshManager({
  exchange = exchangeTianxiToken,
  now = Date.now,
  maxEntries = 32,
} = {}) {
  const states = new Map();
  async function refresh(options, context = {}) {
    let header;
    try {
      header = options.readHeader();
    } catch {
      return {
        attempted: false,
        status: 'no_chat_failed',
        source: 'native-exchange',
        errorCode: 'tianxi_auth_identity_invalid',
      };
    }
    if (!validIdentity(header) || header.user_id !== options.userId)
      return {
        attempted: false,
        status: 'no_chat_failed',
        source: 'native-exchange',
        errorCode: 'tianxi_auth_identity_invalid',
      };
    const key = JSON.stringify([header.user_id, header.app_id, header.device_id]);
    if (context.signal?.aborted) throw new Error('tianxi_auth_aborted');
    let state = states.get(key);
    if (!state) {
      if (states.size >= maxEntries) {
        const disposable = [...states].find(([, value]) => !value.pending);
        if (disposable) states.delete(disposable[0]);
        else
          return {
            attempted: false,
            status: 'no_chat_busy',
            source: 'native-exchange',
            errorCode: 'tianxi_auth_capacity',
          };
      }
      state = { token: '', retryAt: 0, failures: 0, pending: null };
      states.set(key, state);
    }
    const result = (token) => ({
      attempted: true,
      status: 'refreshed',
      source: 'native-exchange',
      token,
      header: { ...header, credentials: { ...header.credentials, qoder_token: token } },
      cache: {
        credentials: { qoder_token: token },
        credentialExpiry: inspectTianxiCredentialExpiry({ qoder_token: token }, { nowMs: now() }),
        available: true,
        hasQoderToken: true,
      },
    });
    if (
      state.token &&
      candidateMatches(state.token, header, now()) &&
      (!options.force || state.token !== options.previousToken)
    )
      return {
        ...result(state.token),
        attempted: false,
        status: options.force ? 'refreshed' : 'fresh_cache',
      };
    state.token = '';
    if (!state.pending && state.retryAt > now())
      return {
        attempted: false,
        status: 'no_chat_backoff',
        source: 'native-exchange',
        errorCode: 'tianxi_auth_retry_later',
      };
    let entry = state.pending;
    if (!entry) {
      entry = {
        controller: new globalThis.AbortController(),
        waiters: 0,
        finished: false,
        promise: null,
      };
      state.pending = entry;
      entry.promise = (async () => {
        try {
          const token = await exchange(header, { signal: entry.controller.signal, now });
          if (entry.controller.signal.aborted) throw new Error('tianxi_auth_aborted');
          if (!sameIdentity(header, options.readHeader()))
            throw new Error('tianxi_auth_account_changed');
          if (!candidateMatches(token, header, now()))
            throw new Error('tianxi_auth_candidate_invalid');
          state.token = token;
          state.failures = 0;
          state.retryAt = 0;
          return token;
        } catch (error) {
          const code = entry.controller.signal.aborted
            ? 'tianxi_auth_aborted'
            : KNOWN_ERRORS.has(error?.message)
              ? error.message
              : 'tianxi_auth_exchange_failed';
          if (code !== 'tianxi_auth_aborted') {
            state.failures = Math.min(4, state.failures + 1);
            state.retryAt = now() + Math.min(120000, 15000 * 2 ** (state.failures - 1));
          }
          throw new Error(code, { cause: error });
        } finally {
          entry.finished = true;
          state.pending = null;
        }
      })();
    }
    try {
      const token = await waitFor(entry, context.signal);
      if (!sameIdentity(header, options.readHeader()))
        throw new Error('tianxi_auth_account_changed');
      return result(token);
    } catch (error) {
      if (error?.message === 'tianxi_auth_aborted') throw error;
      return {
        attempted: true,
        status: 'no_chat_failed',
        source: 'native-exchange',
        errorCode: KNOWN_ERRORS.has(error?.message) ? error.message : 'tianxi_auth_exchange_failed',
      };
    }
  }
  return { refresh };
}
const defaultManager = createTianxiAuthRefreshManager();
module.exports = {
  createTianxiAuthRefreshManager,
  refreshTianxiWithoutChat: defaultManager.refresh,
  sameIdentity,
};
