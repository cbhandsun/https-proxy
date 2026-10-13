'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { gunzipSync, inflateSync, brotliDecompressSync } = require('node:zlib');
const { normalizeCompactionData } = require('./context-compaction-envelope');
const { createContextEvidenceLedger } = require('./context-evidence-ledger');
const { createContextEvidenceTools } = require('./context-evidence-tools');
const { parseCompletedEvidenceSource } = require('./context-evidence-source');
const { MAX_WIRE_BYTES, parseApiEvidenceResults } = require('./context-api-evidence-protocol');

const EVIDENCE_TOKEN_HEADER = 'x-hpm-evidence-token';
const TOKEN = /^hes_[a-f0-9]{64}$/;
const TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 16;
const MAX_OWNER_SESSIONS = 4;
const failure = (code) => ({ ok: false, error: code });
const hash = (value) => createHash('sha256').update(value).digest('hex');

function evidencePrincipal(auth) {
  try {
    const value = (object, key) => {
      if (!object || typeof object !== 'object' || Array.isArray(object))
        throw new TypeError('auth');
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('auth');
      return descriptor?.value;
    };
    const key = value(auth, 'key');
    const safe = normalizeCompactionData(
      {
        ok: value(auth, 'ok'),
        enabled: value(auth, 'enabled'),
        key: {
          id: value(key, 'id'),
          allowedEntryProtocols: value(key, 'allowedEntryProtocols') ?? [],
          allowedEntryPorts: value(key, 'allowedEntryPorts') ?? [],
          allowedProfileIds: value(key, 'allowedProfileIds') ?? [],
        },
      },
      16384
    );
    if (
      safe.ok !== true ||
      safe.enabled !== true ||
      typeof safe.key?.id !== 'string' ||
      !/^[A-Za-z0-9_.:-]{1,256}$/.test(safe.key.id)
    )
      return null;
    const policies = ['allowedEntryProtocols', 'allowedEntryPorts', 'allowedProfileIds'].map(
      (key) => safe.key[key] ?? []
    );
    if (policies.some((value) => !Array.isArray(value))) return null;
    return hash(JSON.stringify([safe.key.id, ...policies]));
  } catch {
    return null;
  }
}

// Bearer capability plus an authenticated entry principal, never a guessed
// chat ID, API key hash, upstream profile, or model-chosen session selector.
function createContextApiEvidenceRuntime({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('invalid_api_evidence_clock');
  const sessions = new Map();
  let enabled = false;
  let closed = false;
  let lastTime = 0;
  let activeObservations = 0;
  const counters = { rejected: 0, captured: 0, observationFailures: 0 };
  function dispose(session) {
    session.active = false;
    session.pending.clear();
    session.seen.clear();
    session.ledger.close();
  }
  function clear() {
    for (const session of sessions.values()) dispose(session);
    sessions.clear();
  }
  function clock() {
    let time;
    try {
      time = now();
    } catch {
      time = null;
    }
    if (
      !Number.isSafeInteger(time) ||
      time < lastTime ||
      time < 0 ||
      time > Number.MAX_SAFE_INTEGER - TTL_MS
    ) {
      clear();
      closed = true;
      return null;
    }
    lastTime = time;
    for (const [token, session] of sessions)
      if (time >= session.expiresAt) {
        dispose(session);
        sessions.delete(token);
      }
    return time;
  }
  function current(session) {
    return enabled && !closed && clock() !== null && session.active;
  }
  function resolve(auth, token) {
    const principal = evidencePrincipal(auth);
    if (
      !enabled ||
      closed ||
      !principal ||
      typeof token !== 'string' ||
      !TOKEN.test(token) ||
      clock() === null
    )
      return null;
    const session = sessions.get(hash(token));
    return session?.principal === principal && session.active ? session : null;
  }
  function capability(session) {
    return {
      definitions: session.readers.definitions.map((tool) => ({
        ...tool,
        description:
          'API client-reported evidence, not proof of execution or business success. ' +
          tool.description,
      })),
      acquireObservation() {
        if (!current(session) || activeObservations >= 16 || session.observations >= 4) {
          counters.observationFailures++;
          return null;
        }
        activeObservations++;
        session.observations++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          activeObservations--;
          session.observations--;
        };
      },
      observeCalls(kind, calls) {
        if (!current(session)) return;
        if (
          !['chat', 'responses', 'claude'].includes(kind) ||
          !Array.isArray(calls) ||
          calls.length > 128
        ) {
          counters.rejected++;
          return;
        }
        for (const input of calls) {
          const parsed = parseCompletedEvidenceSource(input);
          if (!parsed.ok) {
            counters.rejected++;
            continue;
          }
          const call = parsed.source;
          const key = kind + ':' + call.callId;
          const digest = hash(JSON.stringify([call.toolName, call.arguments]));
          if (session.seen.has(key)) {
            if (session.seen.get(key) !== digest) {
              session.pending.delete(key);
              counters.rejected++;
            }
            continue;
          }
          if (session.seen.size >= 128) {
            counters.rejected++;
            continue;
          }
          session.seen.set(key, digest);
          session.pending.set(key, { ...call, callId: 'hpa_' + hash(key) });
        }
      },
      observeInput(kind, input, encoding) {
        if (!current(session)) return;
        let body = input;
        try {
          if (Buffer.isBuffer(input)) {
            if (input.length > MAX_WIRE_BYTES) throw new TypeError('limit');
            const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };
            if (encoding && encoding !== 'identity' && !Object.hasOwn(decoders, encoding))
              throw new TypeError('encoding');
            const bytes = decoders[encoding]
              ? decoders[encoding](input, { maxOutputLength: MAX_WIRE_BYTES })
              : input;
            const text = bytes.toString('utf8');
            if (!Buffer.from(text).equals(bytes)) throw new TypeError('utf8');
            body = JSON.parse(text);
          }
          const results = parseApiEvidenceResults(kind, body);
          for (const result of results) {
            const key = kind + ':' + result.callId;
            const pending = session.pending.get(key);
            if (!pending) continue;
            const parsed = parseCompletedEvidenceSource({ ...pending, output: result.output });
            if (!parsed.ok) {
              counters.rejected++;
              continue;
            }
            try {
              session.ledger.capture(parsed.source);
              session.pending.delete(key);
              counters.captured++;
            } catch {
              counters.rejected++;
            }
          }
        } catch {
          counters.rejected++;
        }
      },
      reply(name, args) {
        if (!current(session)) return { ok: false, code: 'context_evidence_unavailable' };
        const result = session.readers.reply(name, args);
        if (!result?.text) return result;
        const text = JSON.stringify({
          ...JSON.parse(result.text),
          observation: 'client_reported',
          verification: 'not_verified',
        });
        if (Buffer.byteLength(text) > 16384)
          return { ok: false, code: 'evidence_read_budget_exceeded' };
        return { ...result, text };
      },
      observationFailed() {
        counters.observationFailures++;
      },
    };
  }
  return {
    configure(value) {
      enabled = value === true && !closed;
      if (!enabled) clear();
    },
    create(auth) {
      const principal = evidencePrincipal(auth);
      const time = clock();
      if (!enabled || closed || !principal || time === null)
        return failure('evidence_session_unavailable');
      if (
        sessions.size >= MAX_SESSIONS ||
        [...sessions.values()].filter((session) => session.principal === principal).length >=
          MAX_OWNER_SESSIONS
      )
        return failure('evidence_session_limit');
      const token = 'hes_' + randomBytes(32).toString('hex');
      const ledger = createContextEvidenceLedger({ owner: principal, threadId: hash(token), now });
      sessions.set(hash(token), {
        principal,
        ledger,
        readers: createContextEvidenceTools(ledger),
        expiresAt: time + TTL_MS,
        active: true,
        observations: 0,
        pending: new Map(),
        seen: new Map(),
      });
      return {
        ok: true,
        token,
        expiresAt: time + TTL_MS,
        scope: 'explicit_connection',
        persistence: 'memory',
      };
    },
    bind(auth, token) {
      const session = resolve(auth, token);
      return session ? capability(session) : null;
    },
    remove(auth, token) {
      const session = resolve(auth, token);
      if (!session) return false;
      dispose(session);
      sessions.delete(hash(token));
      return true;
    },
    inspect() {
      clock();
      return { enabled, closed, sessions: sessions.size, activeObservations, ...counters };
    },
    close() {
      closed = true;
      enabled = false;
      clear();
    },
  };
}

module.exports = { EVIDENCE_TOKEN_HEADER, evidencePrincipal, createContextApiEvidenceRuntime };
