'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { types } = require('node:util');
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
const {
  parseAnchorSnapshot,
  assertAnchorSuccessor,
} = require('./context-recovery-anchor-contract');

const MAX_VALUE_BYTES = 65536;
const MAX_WIRE_BYTES = 131072;
const PROGRAM = path.resolve(__dirname, '../../runtime/native/hpm-context-recovery-key.exe');
const domain = 'hpm.context.recovery.anchor.v1';

function ownRecord(input, names) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw storageFailure();
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => !names.includes(key)))
    throw storageFailure();
  const result = Object.create(null);
  for (const name of names) {
    const slot = Object.getOwnPropertyDescriptor(input, name);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value') || types.isProxy(slot.value))
      throw storageFailure();
    result[name] = slot.value;
  }
  return result;
}

// No source-only fallback: a missing or failed independent anchor backend must
// never silently become an ordinary file, in-memory index or PowerShell retry.
function physical(input, directory) {
  if (
    typeof input !== 'string' ||
    input.length > 4096 ||
    !path.isAbsolute(input) ||
    /^[\\/]{2}/.test(input) ||
    /[\0\r\n]/.test(input)
  )
    throw storageFailure();
  let current = path.resolve(input),
    first = true,
    identity;
  if (current === path.parse(current).root) throw storageFailure();
  for (;;) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (first
        ? directory
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1n
        : !stat.isDirectory())
    )
      throw storageFailure();
    if (path.resolve(fs.realpathSync.native(current)).toLowerCase() !== current.toLowerCase())
      throw storageFailure();
    if (first) identity = [stat.dev.toString(), stat.ino.toString(), stat.birthtimeNs.toString()];
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    first = false;
  }
  return identity;
}

function nativeReply(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_WIRE_BYTES) throw storageFailure();
  const parsed = JSON.parse(text);
  // The fixed native serializer is compact. Exact reserialization also refuses
  // duplicate keys, including an earlier conflicting ok/revision/value field.
  if (JSON.stringify(parsed) !== text) throw storageFailure();
  const value = ownRecord(parsed, ['ok', 'revision', 'value']);
  if (value.ok !== true || !Number.isSafeInteger(value.revision) || value.revision < 0)
    throw storageFailure();
  if (value.revision === 0) {
    if (value.value !== null) throw storageFailure();
  } else {
    if (
      typeof value.value !== 'string' ||
      value.value.length > 87384 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.value)
    )
      throw storageFailure();
    const bytes = Buffer.from(value.value, 'base64');
    if (
      bytes.length < 29 ||
      bytes.length > MAX_VALUE_BYTES ||
      bytes.toString('base64') !== value.value
    )
      throw storageFailure();
  }
  return value;
}

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
        const parsed = JSON.parse(text);
        if (JSON.stringify(parsed) !== text) throw storageFailure();
        return assertIdentity(parseAnchorSnapshot(parsed));
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
          const plain = Buffer.from(JSON.stringify(next));
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
