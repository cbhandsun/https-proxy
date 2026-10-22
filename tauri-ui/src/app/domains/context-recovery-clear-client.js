const storageKey = 'hpm_context_recovery_clear_operation_v1';
const validId = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

function decode(value, expectedId) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'ok,operationId,scope,state'
  )
    return null;
  const slots = Object.getOwnPropertyDescriptors(value);
  const read = (key) => slots[key]?.value;
  const id = read('operationId');
  const state = read('state');
  if (
    read('ok') !== true ||
    read('scope') !== 'proxy_context_recovery' ||
    !validId(id) ||
    (expectedId && id !== expectedId) ||
    !['prepared', 'running', 'succeeded', 'failed', 'disabled', 'cancelled'].includes(state)
  )
    return null;
  return { id, state };
}

// Save the reserved ID before sending the destructive start. Reload can only
// query it; missing/expired/server-restart records never authorize a new start.
export function createContextRecoveryClearClient({
  fetchRequest,
  getApiBase,
  storage,
  setTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  let pendingId = null;
  try {
    const saved = storage.getItem(storageKey);
    if (validId(saved)) pendingId = saved;
  } catch {
    /* a fresh action must still persist its ID before it can start */
  }
  let active = null;
  async function request(path, method, body) {
    const controller = new AbortController();
    let timer;
    try {
      const expiry = new Promise((resolve) => {
        timer = setTimer(() => {
          controller.abort();
          resolve(null);
        }, 10000);
      });
      const action = (async () => {
        const response = await fetchRequest(
          `${getApiBase()}/v1/local/context-recovery/clear-operations${path}`,
          {
            method,
            signal: controller.signal,
            ...(method === 'POST'
              ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
              : {}),
          }
        );
        if (!response.ok) return null;
        return await response.json();
      })();
      return await Promise.race([action, expiry]);
    } catch {
      return null;
    } finally {
      cancelTimer(timer);
    }
  }
  function forget() {
    try {
      storage.removeItem(storageKey);
    } catch {
      /* stale terminal IDs only allow read-only queries */
    }
    pendingId = null;
  }
  function project(record) {
    if (!record) return 'unknown';
    // A delayed start may still be in transit when a query sees prepared.
    // Never use that observation to permit a second destructive request.
    if (record.state === 'prepared') return 'unknown';
    if (record.state === 'running') return 'clearing';
    forget();
    if (record.state === 'cancelled') return 'cancelled';
    return record.state === 'succeeded' ? 'cleared' : 'failed';
  }
  function single(run) {
    if (active) return active;
    active = run().finally(() => {
      active = null;
    });
    return active;
  }
  return {
    hasPending: () => pendingId !== null,
    cancelPending() {
      if (active) return Promise.resolve('unknown');
      return single(async () => {
        if (!pendingId) return 'not_started';
        const value = await request('/cancel', 'POST', { confirm: true, operationId: pendingId });
        return project(decode(value, pendingId));
      });
    },
    dismissPending() {
      if (active) return false;
      try {
        storage.removeItem(storageKey);
        if (storage.getItem(storageKey) !== null) return false;
      } catch {
        return false;
      }
      pendingId = null;
      return true;
    },
    readStatus() {
      return single(async () => {
        if (!pendingId) return 'not_started';
        const value = await request(`?operationId=${pendingId}`, 'GET');
        return project(decode(value, pendingId));
      });
    },
    requestClear() {
      return single(async () => {
        if (pendingId) return 'unknown';
        const prepared = decode(await request('', 'POST', {}));
        if (!prepared || prepared.state !== 'prepared') return 'not_started';
        try {
          storage.setItem(storageKey, prepared.id);
          if (storage.getItem(storageKey) !== prepared.id) return 'not_started';
        } catch {
          return 'not_started';
        }
        pendingId = prepared.id;
        const value = await request('/start', 'POST', { confirm: true, operationId: pendingId });
        return project(decode(value, pendingId));
      });
    },
  };
}
