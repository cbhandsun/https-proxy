'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');
const {
  createRecoveryAnchorChannel,
  primeRecoveryAnchorChannel,
  waitForRecoveryAnchorChannelReady,
} = require('./context-recovery-anchor-channel');
const { nativeReaderPromise } = require('./context-recovery-reader-result');
const { encodeAnchorSnapshot, decodeAnchorSnapshot } = require('./context-recovery-anchor-wire');
const {
  createHmac,
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require('node:crypto');
const { keyRequest } = require('./context-recovery-key-contract');
const { storageDirectory } = require('./context-recovery-storage-paths');
const { storageFailure } = require('./context-recovery-storage-contract');
const { storageExecutionFailure } = require('./context-recovery-storage-failure');
const { recoveryPhysicalIdentity: physical } = require('./context-recovery-physical-identity');
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('./context-recovery-anchor-contract');

const {
  MAX_VALUE_BYTES,
  MAX_WIRE_BYTES,
  ownAnchorRecord: ownRecord,
  parseRecoveryAnchorReply: nativeReply,
} = require('./context-recovery-anchor-protocol');
const PROGRAM = path.resolve(__dirname, '../../runtime/native/hpm-context-recovery-key.exe');
const domain = 'hpm.context.recovery.anchor.v1';
const startupSessions = new WeakMap();

// No source-only fallback: a missing or failed independent anchor backend must
// never silently become an ordinary file, in-memory index or PowerShell retry.
function createRepository(input, dependencies, sessionMode) {
  let key;
  try {
    const options = ownRecord(input, ['directory', 'dataKey']);
    const directory = storageDirectory(options.directory);
    const identity = physical(directory, true);
    const dataKey = Buffer.from(
      keyRequest({ operation: 'protect', value: options.dataKey }).value,
      'base64'
    );
    let slot, keyIdentity;
    try {
      const derive = (name) =>
        createHmac('sha256', dataKey)
          .update(domain + '/' + name)
          .digest();
      key = derive('envelope');
      slot = derive('slot').toString('hex');
      keyIdentity = derive('identity').toString('hex');
    } finally {
      dataKey.fill(0);
    }
    const locationHash = createHash('sha256')
      .update(
        JSON.stringify([
          domain,
          process.platform === 'win32' ? directory.toLowerCase() : directory,
          ...identity,
        ])
      )
      .digest('hex');
    const platform = dependencies.platform ?? process.platform;
    const executable = dependencies.nativeExecutable ?? PROGRAM;
    const execute = dependencies.execute ?? execFileSync;
    const environment = dependencies.environment ?? process.env;
    const root = environment.SystemRoot || environment.WINDIR;
    if (
      platform !== 'win32' ||
      typeof executable !== 'string' ||
      !executable.endsWith('.exe') ||
      typeof execute !== 'function' ||
      types.isProxy(execute) ||
      typeof root !== 'string' ||
      !/^[A-Za-z]:[\\/]/.test(root) ||
      /[\0\r\n]/.test(root)
    )
      throw storageFailure();
    const programIdentity = physical(executable, false);
    let closed = false,
      revision,
      snapshot;
    let channel,
      channelCapability,
      closing,
      asyncActive = false,
      asyncClosed = false,
      inFlight = false;
    const close = () => {
      closed = true;
      key.fill(0);
      snapshot = undefined;
    };
    function guarded(operation) {
      try {
        if (
          closed ||
          JSON.stringify(physical(directory, true)) !== JSON.stringify(identity) ||
          JSON.stringify(physical(executable, false)) !== JSON.stringify(programIdentity)
        )
          throw storageFailure();
        return operation();
      } catch {
        close();
        throw storageFailure();
      }
    }
    function verifyIdentity() {
      if (
        closed ||
        JSON.stringify(physical(directory, true)) !== JSON.stringify(identity) ||
        JSON.stringify(physical(executable, false)) !== JSON.stringify(programIdentity)
      )
        throw storageFailure();
    }
    function dispatch(request) {
      const reply = nativeReply(
        execute(executable, ['--hpm-context-anchor-v1'], {
          input: JSON.stringify(request),
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: MAX_WIRE_BYTES,
          windowsHide: true,
          shell: false,
          env: { SystemRoot: root, WINDIR: root },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      );
      if (
        JSON.stringify(physical(directory, true)) !== JSON.stringify(identity) ||
        JSON.stringify(physical(executable, false)) !== JSON.stringify(programIdentity)
      )
        throw storageFailure();
      return reply;
    }
    const aad = (version) => Buffer.from(JSON.stringify([domain, slot, version]));
    function assertIdentity(value) {
      if (value.keyIdentity !== keyIdentity || value.locationHash !== locationHash)
        throw storageFailure();
      return value;
    }
    function decode(value) {
      const bytes = Buffer.from(value.value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(aad(value.revision));
      decipher.setAuthTag(bytes.subarray(12, 28));
      let plain;
      try {
        plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
        return assertIdentity(decodeAnchorSnapshot(text));
      } finally {
        plain?.fill(0);
      }
    }
    function prepareCommit(inputSnapshot) {
      if (revision === undefined || revision === Number.MAX_SAFE_INTEGER) throw storageFailure();
      const next = assertIdentity(parseAnchorSnapshot(inputSnapshot));
      if (snapshot) assertAnchorSuccessor(snapshot, next);
      const plain = Buffer.from(encodeAnchorSnapshot(next));
      let value;
      try {
        if (plain.length + 28 > MAX_VALUE_BYTES) throw storageFailure();
        const nonce = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad(revision + 1));
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        value = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
      } finally {
        plain.fill(0);
      }
      return { next, request: { operation: 'compare', slot, expectedRevision: revision, value } };
    }
    function acceptCommit(reply, prepared) {
      if (reply.revision !== revision + 1 || reply.value !== prepared.request.value)
        throw storageFailure();
      revision = reply.revision;
      snapshot = prepared.next;
      return Object.freeze({ revision });
    }
    const repository = Object.freeze({
      identity: Object.freeze({ keyIdentity, locationHash }),
      read() {
        if (asyncActive) throw storageFailure();
        return guarded(() => {
          if (revision !== undefined) throw storageFailure();
          const reply = dispatch({ operation: 'read', slot });
          snapshot = reply.revision === 0 ? null : decode(reply);
          revision = reply.revision;
          return snapshot;
        });
      },
      commit(inputSnapshot) {
        if (asyncActive) throw storageFailure();
        return guarded(() => {
          const prepared = prepareCommit(inputSnapshot);
          return acceptCommit(dispatch(prepared.request), prepared);
        });
      },
      close() {
        // Startup-only capabilities cannot claim asynchronous process cleanup.
        if ((asyncActive || channel) && !asyncClosed) throw storageFailure();
        close();
      },
    });
    if (!sessionMode) return repository;
    function openChannel() {
      if (!channel) {
        const factory = dependencies.createChannel ?? createRecoveryAnchorChannel;
        if (
          typeof factory !== 'function' ||
          types.isProxy(factory) ||
          types.isAsyncFunction(factory) ||
          types.isGeneratorFunction(factory)
        )
          throw storageFailure();
        const created = factory({ executable, systemRoot: root });
        channel = ownRecord(created, ['execute', 'close']);
        for (const method of ['execute', 'close']) {
          if (typeof channel[method] !== 'function' || types.isProxy(channel[method]))
            throw storageFailure();
        }
        channelCapability = created;
      }
    }
    function closeSession() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        try {
          if (channel) {
            const result = channel.close();
            if (!nativeReaderPromise(result)) throw storageFailure();
            await result;
          }
          asyncClosed = true;
        } catch {
          throw storageFailure();
        } finally {
          close();
        }
      })();
      return closing;
    }
    const session = Object.freeze({
      repository,
      async commit(inputSnapshot) {
        if (closed || inFlight) throw storageFailure();
        inFlight = true;
        asyncActive = true;
        let phase = 'anchor-identity-before';
        try {
          verifyIdentity();
          phase = 'anchor-prepare';
          const prepared = prepareCommit(inputSnapshot);
          if (!channel) phase = 'anchor-channel-open';
          openChannel();
          phase = 'anchor-request';
          const result = channel.execute(JSON.stringify(prepared.request));
          if (!nativeReaderPromise(result)) throw storageFailure();
          const text = await result;
          phase = 'anchor-reply';
          const reply = nativeReply(text);
          phase = 'anchor-identity-after';
          verifyIdentity();
          phase = 'anchor-receipt';
          return acceptCommit(reply, prepared);
        } catch {
          let cleanupFailed = false;
          try {
            await closeSession();
          } catch {
            cleanupFailed = true;
          }
          throw storageExecutionFailure(phase, cleanupFailed);
        } finally {
          inFlight = false;
        }
      },
      close: closeSession,
    });
    startupSessions.set(session, {
      prime() {
        if (closed || asyncActive || inFlight) throw storageFailure();
        verifyIdentity();
        openChannel();
        primeRecoveryAnchorChannel(channelCapability);
        verifyIdentity();
      },
      ready() {
        if (closed || asyncActive || inFlight) throw storageFailure();
        verifyIdentity();
        return waitForRecoveryAnchorChannelReady(channelCapability);
      },
      close: closeSession,
    });
    return session;
  } catch {
    key?.fill(0);
    throw storageFailure();
  }
}

function createRecoveryAnchorRepository(input, dependencies = {}) {
  return createRepository(input, dependencies, false);
}

// Synchronous startup (including empty durable intent) is deliberately retained.
// Steady-state commits share the same key/revision and original envelope codec.
function createRecoveryAnchorSession(input, dependencies = {}) {
  return createRepository(input, dependencies, true);
}

// Only this module's exact session can prime its transport. No request is sent,
// no revision is accepted, and synchronous admission remains mandatory. The
// owner must await session.close() on every subsequent startup failure.
function primeRecoveryAnchorSession(session) {
  const capability = startupSessions.get(session);
  if (!capability) return false;
  try {
    capability.prime();
    return true;
  } catch {
    throw storageFailure();
  }
}

// Failure cleanup uses the same private capability rather than assimilating
// a caller-supplied close result before admission has validated the session.
function closeRecoveryAnchorStartupSession(session) {
  const capability = startupSessions.get(session);
  return capability ? capability.close() : null;
}

// A private native readiness barrier, never an admission or commit receipt.
function waitForRecoveryAnchorStartupSession(session) {
  const capability = startupSessions.get(session);
  if (!capability) return null;
  try {
    return capability.ready();
  } catch {
    throw storageFailure();
  }
}

module.exports = {
  waitForRecoveryAnchorStartupSession,
  closeRecoveryAnchorStartupSession,
  createRecoveryAnchorRepository,
  createRecoveryAnchorSession,
  primeRecoveryAnchorSession,
};
