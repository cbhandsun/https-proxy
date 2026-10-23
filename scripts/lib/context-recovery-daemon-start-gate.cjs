'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isBuiltin } = require('node:module');
const {
  parseRuntimeBoundaryArguments,
  verifyRuntimeBoundaryInstallationParallel,
} = require('./nsis-runtime-boundary-contract');

const fail = () => new Error('daemon_start_gate_rejected');

// Synchronous preload: Node cannot enter its actual main module before EOF.
// The controller writes the single byte only after assigning the owned Job.
function readGate(read = fs.readSync) {
  const bytes = Buffer.alloc(2);
  let size = 0;
  for (;;) {
    const count = read(0, bytes, size, bytes.length - size, null);
    if (!Number.isInteger(count) || count < 0 || count > bytes.length - size) throw fail();
    if (count === 0) break;
    size += count;
    if (size > 1 || bytes[0] !== 49) throw fail();
  }
  if (size !== 1 || bytes[0] !== 49) throw fail();
}

function verifyGateIdentity(runtime = process) {
  const env = runtime.env;
  if (
    env.NODE_OPTIONS ||
    env.NODE_PATH ||
    runtime.execArgv.length !== 2 ||
    runtime.execArgv[0] !== '--require' ||
    path.resolve(runtime.execArgv[1]) !== __filename ||
    runtime.argv.length !== 2
  )
    throw fail();
  const input = parseRuntimeBoundaryArguments([
    'settings-matrix',
    env.HPM_DAEMON_OWNED_INSTALL,
    env.HPM_DAEMON_OWNED_CASE_ROOT,
    env.HPM_DAEMON_OWNED_MANIFEST,
  ]);
  const installed = verifyRuntimeBoundaryInstallationParallel(input, env.HPM_DAEMON_OWNED_ROOT);
  const same = (a, b) =>
    runtime.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (
    !same(fs.realpathSync.native(runtime.execPath), fs.realpathSync.native(installed.node)) ||
    !same(runtime.cwd(), installed.install) ||
    !same(path.resolve(runtime.argv[1]), path.join(installed.install, 'openai-proxy.js')) ||
    env.PROXY_CONFIG_DIR !== path.join(input.caseRoot, 'config') ||
    env.PROXY_RUNTIME_DIR !== path.join(input.caseRoot, 'runtime') ||
    !/^[a-zA-Z0-9_-]{32,256}$/.test(env.MGMT_TOKEN || '')
  )
    throw fail();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(installed.install, 'release-runtime-manifest.json'), 'utf8')
  );
  if (!Object.hasOwn(manifest.sourceSha256, 'openai-proxy.js')) throw fail();
}

// Authenticate and hash the entire helper closure before loading any of it.
// No plan means the original gate behavior. A present but invalid plan fails.
function verifyN09Bootstrap(runtime = process) {
  const env = runtime.env;
  const caseRoot = env.HPM_DAEMON_OWNED_CASE_ROOT;
  if (typeof caseRoot !== 'string' || !path.isAbsolute(caseRoot)) throw fail();
  const directory = path.join(caseRoot, 'n09-ack');
  try {
    try {
      fs.lstatSync(directory);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw fail();
    }
    if (!Number.isSafeInteger(runtime.pid) || runtime.pid < 1) throw fail();
    const physical = (file, directory = false) => {
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
        if (path.dirname(current) === current) return stat;
      }
    };
    physical(directory, true);
    const planFile = path.join(directory, 'bootstrap-' + runtime.pid + '.json');
    physical(planFile);
    if (fs.statSync(planFile).size > 131072) throw fail();
    const bytes = fs.readFileSync(planFile);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const envelope = JSON.parse(text);
    if (
      JSON.stringify(envelope) !== text ||
      !envelope ||
      Object.keys(envelope).sort().join(',') !== 'payload,signature' ||
      typeof envelope.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.signature) ||
      !/^[a-zA-Z0-9_-]{32,256}$/.test(env.MGMT_TOKEN || '')
    )
      throw fail();
    const signature = crypto
      .createHmac('sha256', env.MGMT_TOKEN)
      .update('hpm.n09.bootstrap.v1\0')
      .update(JSON.stringify(envelope.payload))
      .digest();
    if (!crypto.timingSafeEqual(signature, Buffer.from(envelope.signature, 'hex'))) throw fail();
    const pins = envelope.payload?.sourcePins;
    if (!pins || typeof pins !== 'object' || Array.isArray(pins)) throw fail();
    const names = Object.keys(pins);
    if (names.length < 1 || names.length > 512) throw fail();
    const candidate = path.resolve(path.dirname(__filename), '../..');
    for (const name of names) {
      if (
        !/^[a-zA-Z0-9_./-]+\.(?:js|cjs|json)$/.test(name) ||
        name.startsWith('/') ||
        name.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof pins[name] !== 'string' ||
        !/^[a-f0-9]{64}$/.test(pins[name])
      )
        throw fail();
      const file = path.join(candidate, ...name.split('/'));
      physical(file);
      if (
        fs.statSync(file).size > 2097152 ||
        crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== pins[name]
      )
        throw fail();
    }
    for (const name of ['host-install.js', 'bootstrap-contract.js'])
      if (!Object.hasOwn(pins, 'scripts/context-hosted/n09-ack/' + name)) throw fail();
    const sources = new Map(
      names.map((name) => [path.join(candidate, ...name.split('/')), pins[name]])
    );
    const queue = ['host-install.js', 'bootstrap-contract.js'].map((name) =>
      path.join(candidate, 'scripts/context-hosted/n09-ack', name)
    );
    const visited = new Set();
    while (queue.length) {
      const file = queue.pop();
      if (visited.has(file)) continue;
      if (!sources.has(file)) throw fail();
      visited.add(file);
      if (file.endsWith('.json')) continue;
      let code = fs.readFileSync(file, 'utf8');
      code = code.replace(
        /\brequire\s*\(\s*path\.join\s*\(\s*options\.install\s*,\s*(['"])lib\/proxy\/context-recovery-(?:durable-ack|lifecycle)\.js\1\s*\)\s*\)/g,
        () => {
          if (file !== path.join(candidate, 'scripts/context-hosted/n09-ack/host-install.js'))
            throw fail();
          return '';
        }
      );
      code = code.replace(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (_all, _quote, name) => {
        if (isBuiltin(name)) return '';
        if (!name.startsWith('./') && !name.startsWith('../')) throw fail();
        const base = path.resolve(path.dirname(file), name);
        const choices = [
          base,
          base + '.js',
          base + '.cjs',
          base + '.json',
          path.join(base, 'index.js'),
        ].filter((entry) => sources.has(entry));
        if (choices.length !== 1) throw fail();
        queue.push(choices[0]);
        return '';
      });
      if (/\brequire\s*\(/.test(code)) throw fail();
    }
    const { createN09BootstrapContract } = require('../context-hosted/n09-ack/bootstrap-contract');
    const contract = createN09BootstrapContract({
      token: env.MGMT_TOKEN,
      pid: runtime.pid,
      manifestSha256: env.HPM_DAEMON_OWNED_MANIFEST,
    });
    try {
      const payload = contract.verify(envelope);
      return {
        caseRoot,
        install: env.HPM_DAEMON_OWNED_INSTALL,
        pid: runtime.pid,
        epoch: payload.epoch,
        signingKey: contract.mailboxKey(payload),
      };
    } finally {
      contract.close();
    }
  } catch {
    throw fail();
  }
}

// Node's --require loader uses this parent id. Ordinary imports for offline
// tests do not execute the gate; the fixed controller invocation always does.
if (module.parent?.id === 'internal/preload') {
  try {
    fs.writeSync(2, 'HPM_GATE_ENTERED\n');
    readGate();
    verifyGateIdentity();
    const ack = verifyN09Bootstrap();
    if (ack) require('../context-hosted/n09-ack/host-install').installN09HostAck(ack);
    fs.writeSync(2, 'HPM_GATE_PASSED\n');
  } catch {
    fs.writeSync(2, 'HPM_GATE_FAILED\n');
    throw fail();
  }
}

module.exports = { readGate, verifyGateIdentity, verifyN09Bootstrap };
