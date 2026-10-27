'use strict';
// Plan generation only: core filesystem/hash operations; never imports runtime,
// proposal, controller, HTTP, TLS, child_process, worker or native modules.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { isBuiltin } = require('node:module');
const { types } = require('node:util');
const fail = () => new Error('context_hosted_plan_rejected');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function plain(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw fail();
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !slot) throw fail();
    if (!slot.enumerable || !Object.hasOwn(slot, 'value') || types.isProxy(slot.value))
      throw fail();
    result[key] = slot.value;
  }
  return result;
}
function physical(file, directory = false) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    /^[\\/]{2}/.test(file) ||
    file.includes('\0')
  )
    throw fail();
  let current = path.resolve(file),
    first = true;
  for (;;) {
    const stat = fs.lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      (first
        ? directory
          ? !stat.isDirectory()
          : !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    )
      throw fail();
    if (path.resolve(fs.realpathSync.native(current)).toLowerCase() !== current.toLowerCase())
      throw fail();
    const parent = path.dirname(current);
    if (parent === current) break;
    first = false;
    current = parent;
  }
  return path.resolve(file);
}
function fileHash(file) {
  physical(file);
  return hash(fs.readFileSync(file));
}
function readJson(file, expected, maximum = 2097152) {
  physical(file);
  if (!hex(expected) || fs.statSync(file).size > maximum) throw fail();
  const bytes = fs.readFileSync(file),
    text = bytes.toString('utf8');
  if (hash(bytes) !== expected || !Buffer.from(text).equals(bytes)) throw fail();
  return JSON.parse(text);
}
function relativeFile(root, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.includes('\\') ||
    path.isAbsolute(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    name.includes('\0')
  )
    throw fail();
  return path.join(root, ...name.split('/'));
}
function fixedRecordHash(root, names) {
  return Object.fromEntries(names.map((name) => [name, fileHash(path.join(root, name))]));
}
function controllerPinRecord(candidate, names) {
  const entries = Object.entries(fixedRecordHash(candidate, names));
  return Object.fromEntries(entries.map(([name, sha256]) => [path.basename(name), sha256]));
}
function collectClosure(roots, dynamicTargets) {
  const result = Object.create(null),
    queue = [...roots, ...dynamicTargets],
    seen = new Set();
  while (queue.length) {
    const file = physical(queue.pop()),
      key = file.toLowerCase();
    if (seen.has(key)) continue;
    if (fs.statSync(file).size > 2097152 || seen.size >= 512) throw fail();
    seen.add(key);
    const data = fs.readFileSync(file);
    result[file] = hash(data);
    if (file.endsWith('.json')) continue;
    let source = data.toString('utf8');
    if (!Buffer.from(source).equals(data)) throw fail();
    source = source.replace(
      /\brequire\s*\(\s*path\.join\s*\(\s*value\.install\s*,\s*(['"])lib\/proxy\/context-recovery-(?:sessions|runtime)\.js\1\s*\)\s*\)/g,
      () => {
        if (file !== path.resolve(__dirname, '../lib/nsis-client-observer-bootstrap.cjs'))
          throw fail();
        // Original gate checks the full installed manifest; the observer also
        // verifies these exact sessions/runtime hashes before its fixed installed imports.
        return '';
      }
    );
    source = source.replace(
      /\brequire\s*\(\s*path\.join\s*\(\s*options\.install\s*,\s*(['"])lib\/proxy\/context-recovery-(?:durable-ack|lifecycle|storage|storage-contract|storage-inventory)\.js\1\s*\)\s*\)/g,
      () => {
        if (file !== path.resolve(__dirname, 'n09-ack/host-install.js')) throw fail();
        // Gate verifies the full installed manifest before these fixed imports.
        return '';
      }
    );
    source = source.replace(
      /\brequire\s*\(\s*path\.join\s*\(\s*options\.candidate\s*,\s*(['"])scripts\/lib\/context-recovery-daemon-owned-(?:transport|adapter)\.js\1\s*\)\s*\)/g,
      () => {
        if (path.basename(file) !== 'observed-composition.js' || dynamicTargets.length !== 2)
          throw fail();
        return '';
      }
    );
    source = source.replace(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g, (_all, _quote, name) => {
      if (isBuiltin(name)) return '';
      if (!name.startsWith('./') && !name.startsWith('../')) throw fail();
      const base = path.resolve(path.dirname(file), name);
      const choices = [
        base,
        base + '.js',
        base + '.cjs',
        base + '.json',
        path.join(base, 'index.js'),
      ].filter((item) => fs.existsSync(item) && fs.lstatSync(item).isFile());
      if (choices.length !== 1) throw fail();
      queue.push(choices[0]);
      return '';
    });
    if (/\brequire\s*\(/.test(source)) throw fail();
  }
  return result;
}
function buildHostedReviewPlan(input) {
  try {
    const options = plain(input),
      names = [
        'scenario',
        'candidate',
        'ownedRoot',
        'identity',
        'buildReceiptSha256',
        'negativeAddress',
      ];
    if (
      Object.keys(options).length !== names.length ||
      names.some((name) => !Object.hasOwn(options, name)) ||
      !['n08', 'n09', 'n09-sending-ack'].includes(options.scenario)
    )
      throw fail();
    const scenario = options.scenario === 'n09-sending-ack' ? 'n09' : options.scenario;
    const candidate = physical(options.candidate, true),
      ownedRoot = physical(options.ownedRoot, true);
    if (
      path.resolve(__dirname, '../..').toLowerCase() !== candidate.toLowerCase() ||
      !net.isIPv4(options.negativeAddress) ||
      !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(options.negativeAddress)
    )
      throw fail();
    const identity = plain(options.identity);
    if (
      identity.schemaVersion !== 1 ||
      typeof identity.sourceSha !== 'string' ||
      !/^[a-f0-9]{40}$/.test(identity.sourceSha) ||
      !Array.isArray(identity.entries) ||
      identity.entries.length < 1 ||
      identity.entries.length > 20000 ||
      identity.sourceEntries !== identity.entries.length ||
      hash(JSON.stringify(identity.entries)) !== identity.sourceIdentity
    )
      throw fail();
    const identityPins = new Map();
    for (const row of identity.entries) {
      const entry = plain(row),
        file = relativeFile(candidate, entry.path);
      if (
        identityPins.has(entry.path.toLowerCase()) ||
        !hex(entry.sha256) ||
        fileHash(file) !== entry.sha256
      )
        throw fail();
      identityPins.set(entry.path.toLowerCase(), entry.sha256);
    }
    const build = plain(
      readJson(path.join(ownedRoot, 'build-and-npm.json'), options.buildReceiptSha256, 4096)
    );
    if (
      build.phase !== 'build_and_npm_ready' ||
      build.buildCompleted !== true ||
      build.npmCompleted !== true ||
      build.sourceSha !== identity.sourceSha ||
      build.sourceIdentity !== identity.sourceIdentity ||
      build.sourcePackageLockSha256 !== identityPins.get('package-lock.json') ||
      !hex(build.manifestSha256) ||
      !hex(build.nodeSha256)
    )
      throw fail();
    const payload = path.join(ownedRoot, 'payload');
    const manifest = plain(
      readJson(path.join(payload, 'release-runtime-manifest.json'), build.manifestSha256, 4194304)
    );
    if (
      manifest.schemaVersion !== 2 ||
      manifest.nodeSha256 !== build.nodeSha256 ||
      fileHash(path.join(payload, 'runtime/node/node.exe')) !== build.nodeSha256 ||
      !hex(manifest.packageLockSha256) ||
      fileHash(path.join(payload, 'package-lock.json')) !== manifest.packageLockSha256
    )
      throw fail();
    const runtimePins = plain(manifest.sourceSha256);
    for (const [name, expected] of Object.entries(runtimePins)) {
      if (
        !hex(expected) ||
        fileHash(relativeFile(payload, name)) !== expected ||
        (identityPins.has(name.toLowerCase()) && identityPins.get(name.toLowerCase()) !== expected)
      )
        throw fail();
    }
    const proxySources = JSON.parse(
      fs.readFileSync(path.join(candidate, 'scripts/release-proxy-sources.json'), 'utf8')
    );
    if (!Array.isArray(proxySources) || proxySources.length < 1) throw fail();
    for (const name of ['openai-proxy.js', ...proxySources])
      if (runtimePins[name] !== identityPins.get(name.toLowerCase())) throw fail();
    const { validateRuntimeLock } = require('./runtime-lock.js');
    validateRuntimeLock(
      JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(candidate, 'package-lock.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(payload, 'package-lock.json'), 'utf8'))
    );
    const executionRoot = path.join(__dirname, scenario),
      shared = path.join(__dirname, 'shared');
    const mainModules = [
      'scripts/lib/context-recovery-daemon-owned-transport.js',
      'scripts/lib/context-recovery-daemon-owned-adapter.js',
    ];
    const dynamicTargets =
      scenario === 'n08' ? mainModules.map((name) => path.join(candidate, name)) : [];
    const loadedPins = collectClosure(
      [
        path.join(executionRoot, 'owned-entry.js'),
        path.join(executionRoot, scenario === 'n08' ? 'observed-composition.js' : 'composition.js'),
        ...(scenario === 'n09'
          ? [
              path.join(__dirname, 'n09-ack/host-install.js'),
              path.join(__dirname, 'n09-ack/bootstrap-contract.js'),
            ]
          : []),
      ],
      dynamicTargets
    );
    if (scenario === 'n09') {
      const writer = path.join(__dirname, 'n09-ack/write-bootstrap.psm1');
      loadedPins[writer] = fileHash(writer);
    }
    for (const [file, expected] of Object.entries(loadedPins)) {
      const relative = path.relative(candidate, file).split(path.sep).join('/').toLowerCase();
      if (identityPins.get(relative) !== expected) throw fail();
    }
    const controllerNames = [
      'context-recovery-daemon-owned-controller.ps1',
      'context-recovery-daemon-owned-controller.psm1',
      'context-recovery-daemon-start-gate.cjs',
      'nsis-runtime-boundary-job.cs',
      'nsis-lifecycle.psm1',
      'nsis-runtime-boundary.psm1',
    ];
    const jobFiles = [
      'nsis-runtime-boundary.psm1',
      'nsis-runtime-boundary-job.cs',
      'nsis-lifecycle.psm1',
    ].map((name) => path.join(candidate, 'scripts/lib', name));
    jobFiles.push(
      path.join(executionRoot, 'owned-entry.js'),
      path.join(payload, 'runtime/node/node.exe')
    );
    const libraryFiles = [
      path.join(shared, 'hosted-network.ps1'),
      path.join(shared, 'hosted-materials.ps1'),
      path.join(shared, 'hosted-egress-wfp.cs'),
      path.join(executionRoot, 'owned-job.ps1'),
      path.join(executionRoot, 'hosted-execution.ps1'),
    ];
    if (scenario === 'n09') libraryFiles.push(path.join(executionRoot, 'run-hosted.ps1'));
    for (const file of [
      ...libraryFiles,
      ...jobFiles.slice(0, -1),
      ...controllerNames.map((name) => path.join(candidate, 'scripts/lib', name)),
    ]) {
      const relative = path.relative(candidate, file).split(path.sep).join('/').toLowerCase();
      if (identityPins.get(relative) !== fileHash(file)) throw fail();
    }
    const plan = {
      ...(options.scenario === 'n09-sending-ack' ? { publicationGroup: 'sending-ack' } : {}),
      candidate,
      manifestSha256: build.manifestSha256,
      ...(scenario === 'n08'
        ? { sourcePins: fixedRecordHash(candidate, mainModules) }
        : {
            lifecyclePins: fixedRecordHash(path.join(__dirname, 'n09-ipc'), [
              'n09-ipc-entry.ps1',
              'same-directory-ipc.psm1',
              'same-directory-restart.psm1',
              'n09-ipc-writer.cs',
            ]),
          }),
      controllerPins: fixedRecordHash(path.join(candidate, 'scripts/lib'), controllerNames),
      loadedPins,
      negativeAddress: options.negativeAddress,
      jobSourcePins: Object.fromEntries(jobFiles.map((file) => [file, fileHash(file)])),
      libraryPins: Object.fromEntries(libraryFiles.map((file) => [file, fileHash(file)])),
    };
    const out = path.join(ownedRoot, scenario + '-hosted-review-plan.json'),
      encoded = Buffer.from(JSON.stringify(plan));
    const handle = fs.openSync(out, 'wx');
    try {
      fs.writeFileSync(handle, encoded);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return Object.freeze({
      phase: 'plan_generated_only',
      planSha256: hash(encoded),
      sourceSha: identity.sourceSha,
      sourceIdentity: identity.sourceIdentity,
      sourceEntries: identity.sourceEntries,
      manifestSha256: build.manifestSha256,
      loadedFiles: Object.keys(loadedPins).length,
      networkExecuted: false,
      daemonExecuted: false,
    });
  } catch {
    throw fail();
  }
}
module.exports = { buildHostedReviewPlan, collectClosure, controllerPinRecord };
