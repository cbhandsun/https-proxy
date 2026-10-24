'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { types } = require('node:util');
const { performance } = require('node:perf_hooks');
const fail = () => new Error('installed_client_observer_rejected');
const names = ['nsis-client-observer.cjs', 'nsis-client-observer-bootstrap.cjs'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function record(input, keys) {
  if (
    !input ||
    typeof input !== 'object' ||
    types.isProxy(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw fail();
  if (Reflect.ownKeys(input).length !== keys.length) throw fail();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail();
    result[key] = descriptor.value;
  }
  return result;
}
function physical(file, directory = false) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    file.startsWith('\\\\')
  )
    throw fail();
  for (let current = file, first = true; ; current = path.dirname(current), first = false) {
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase() ||
      (first
        ? directory
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    )
      throw fail();
    if (path.dirname(current) === current) return;
  }
}
function config(input, runtime = process) {
  const value = record(input, ['caseRoot', 'install', 'token', 'pid', 'manifestSha256']);
  const root = path.join(runtime.env.RUNNER_TEMP || '', 'hpm-installed-clients');
  if (
    runtime.platform !== 'win32' ||
    runtime.env.GITHUB_ACTIONS !== 'true' ||
    runtime.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    runtime.env.RUNNER_OS !== 'Windows' ||
    !path.isAbsolute(root) ||
    value.install !== path.join(root, 'payload') ||
    typeof value.caseRoot !== 'string' ||
    !value.caseRoot.startsWith(path.join(root, 'cases') + path.sep) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 1 ||
    typeof value.manifestSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    typeof value.token !== 'string' ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(value.token)
  )
    throw fail();
  physical(root, true);
  physical(value.caseRoot, true);
  physical(value.install, true);
  const manifest = path.join(value.install, 'release-runtime-manifest.json');
  physical(manifest);
  if (hash(fs.readFileSync(manifest)) !== value.manifestSha256) throw fail();
  return value;
}
function sign(value, token, domain) {
  return crypto
    .createHmac('sha256', token)
    .update('hpm.installed.observer.' + domain + '.v1\0')
    .update(JSON.stringify(value))
    .digest('hex');
}
function envelope(payload, token, domain) {
  return { payload, signature: sign(payload, token, domain) };
}
function authenticate(input, token, domain) {
  const value = record(input, ['payload', 'signature']);
  if (
    typeof value.signature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.signature) ||
    !crypto.timingSafeEqual(
      Buffer.from(sign(value.payload, token, domain), 'hex'),
      Buffer.from(value.signature, 'hex')
    )
  )
    throw fail();
  return value.payload;
}
function read(file, maximum = 16384) {
  physical(file);
  if (fs.statSync(file).size > maximum) throw fail();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  const value = JSON.parse(text);
  if (JSON.stringify(value) !== text) throw fail();
  return value;
}
// Release manifests are intentionally pretty printed; their exact bytes are
// authenticated by the package pin, independently of canonical mailbox JSON.
function readInstalledManifest(value) {
  try {
    const file = path.join(value.install, 'release-runtime-manifest.json');
    physical(file);
    if (fs.statSync(file).size > 2097152) throw fail();
    const bytes = fs.readFileSync(file);
    physical(file);
    if (bytes.length > 2097152 || hash(bytes) !== value.manifestSha256) throw fail();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail();
  }
}
function directory(value) {
  return path.join(value.caseRoot, 'installed-client-observer');
}
function write(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  physical(file);
}
function prepareInstalledClientObserver(input, runtime = process) {
  try {
    const value = config(input, runtime),
      dir = directory(value);
    fs.mkdirSync(dir);
    physical(dir, true);
    const sourcePins = {};
    for (const name of names) {
      const file = path.join(__dirname, name);
      physical(file);
      sourcePins[name] = hash(fs.readFileSync(file));
    }
    const payload = {
      version: 1,
      pid: value.pid,
      manifestSha256: value.manifestSha256,
      sourcePins,
    };
    write(path.join(dir, 'plan.json'), envelope(payload, value.token, 'plan'));
    return Object.freeze({ prepared: true, pid: value.pid, manifestSha256: value.manifestSha256 });
  } catch {
    throw fail();
  }
}
async function requestInstalledClientObservation(input, runtime = process) {
  try {
    const copied = record(input, [
      'caseRoot',
      'install',
      'token',
      'pid',
      'manifestSha256',
      'sequence',
    ]);
    const { sequence, ...rest } = copied,
      value = config(rest, runtime),
      dir = directory(value);
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 100) throw fail();
    physical(dir, true);
    const request = path.join(dir, 'request.json'),
      receipt = path.join(dir, 'receipt.json');
    if (sequence > 1) {
      const old = authenticate(read(receipt), value.token, 'receipt');
      if (old.sequence !== sequence - 1) throw fail();
      fs.unlinkSync(request);
      fs.unlinkSync(receipt);
    }
    write(
      request,
      envelope(
        { version: 1, pid: value.pid, manifestSha256: value.manifestSha256, sequence },
        value.token,
        'request'
      )
    );
    const deadline = performance.now() + 5000;
    for (;;) {
      try {
        const result = authenticate(read(receipt), value.token, 'receipt');
        record(result, [
          'version',
          'pid',
          'manifestSha256',
          'sequence',
          'roots',
          'snapshots',
          'enabled',
          'closed',
          'factoryCalls',
        ]);
        if (
          result.version !== 1 ||
          result.pid !== value.pid ||
          result.manifestSha256 !== value.manifestSha256 ||
          result.sequence !== sequence ||
          !Number.isSafeInteger(result.factoryCalls) ||
          result.factoryCalls < 1 ||
          result.factoryCalls > 16 ||
          !['roots', 'snapshots'].every(
            (key) => Number.isSafeInteger(result[key]) && result[key] >= 0
          ) ||
          typeof result.enabled !== 'boolean' ||
          typeof result.closed !== 'boolean'
        )
          throw fail();
        return Object.freeze(result);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw fail();
      }
      if (performance.now() >= deadline) throw fail();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch {
    throw fail();
  }
}
module.exports = {
  prepareInstalledClientObserver,
  requestInstalledClientObservation,
  physical,
  config,
  authenticate,
  envelope,
  read,
  write,
  directory,
  record,
  readInstalledManifest,
};

if (require.main === module) {
  let size = 0;
  const chunks = [];
  const reject = () => {
    process.stderr.write('installed_client_observer_rejected\n');
    process.exitCode = 1;
  };
  process.stdin.on('data', (chunk) => {
    size += chunk.length;
    if (size > 8192) {
      chunks.length = 0;
      process.stdin.destroy();
      reject();
      return;
    }
    chunks.push(chunk);
  });
  process.stdin.on('error', reject);
  process.stdin.on('end', () => {
    try {
      if (process.argv.length !== 3 || process.argv[2] !== 'prepare' || size < 1 || size > 8192)
        throw fail();
      const value = config(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
      );
      const node = path.join(value.install, 'runtime/node/node.exe');
      physical(node);
      const manifest = readInstalledManifest(value);
      if (
        process.execArgv.length !== 0 ||
        process.env.NODE_OPTIONS ||
        process.env.NODE_PATH ||
        fs.realpathSync.native(process.execPath).toLowerCase() !== node.toLowerCase() ||
        hash(fs.readFileSync(node)) !== manifest.nodeSha256
      )
        throw fail();
      prepareInstalledClientObserver(value);
      process.stdout.write('observer_prepared\n');
    } catch {
      reject();
    }
  });
}
