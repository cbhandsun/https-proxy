'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');
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

// No source-only fallback: a missing or failed independent anchor backend must
// never silently become an ordinary file, in-memory index or PowerShell retry.
function createRecoveryAnchorRepository(input, dependencies = {}) {
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
    return Object.freeze({
      identity: Object.freeze({ keyIdentity, locationHash }),
      read() {
        return guarded(() => {
          if (revision !== undefined) throw storageFailure();
          const reply = dispatch({ operation: 'read', slot });
          snapshot = reply.revision === 0 ? null : decode(reply);
          revision = reply.revision;
          return snapshot;
        });
      },
      commit(inputSnapshot) {
        return guarded(() => {
          if (revision === undefined || revision === Number.MAX_SAFE_INTEGER)
            throw storageFailure();
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
          const reply = dispatch({ operation: 'compare', slot, expectedRevision: revision, value });
          if (reply.revision !== revision + 1 || reply.value !== value) throw storageFailure();
          revision = reply.revision;
          snapshot = next;
          return Object.freeze({ revision });
        });
      },
      close,
    });
  } catch {
    key?.fill(0);
    throw storageFailure();
  }
}

module.exports = { createRecoveryAnchorRepository };
