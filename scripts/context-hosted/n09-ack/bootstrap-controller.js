'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { exact, snapshotOwnData } = require('../shared/boundary');
const { verifyPhysicalPath } = require('../shared/build-hosted-controller');
const { collectClosure } = require('../build-plan');
const { fail } = require('./contract');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Pure source transformation. No process, native resource or credential is
// created here; the pinned PowerShell writer runs after the owned Job assign.
function buildN09AckController(input) {
  try {
    const options = exact(input, ['candidate', 'controller', 'loadedPins', 'manifestSha256']);
    const controller = snapshotOwnData(options.controller);
    const loadedPins = snapshotOwnData(options.loadedPins);
    const copyPins = snapshotOwnData(controller.copyPins);
    if (
      path.resolve(options.candidate) !== path.resolve(__dirname, '../../..') ||
      !/^[a-f0-9]{64}$/.test(options.manifestSha256)
    )
      throw fail();
    const sourcePins = {};
    const closure = collectClosure(
      [path.join(__dirname, 'host-install.js'), path.join(__dirname, 'bootstrap-contract.js')],
      []
    );
    for (const [file, expected] of Object.entries(closure)) {
      if (loadedPins[file] !== expected) throw fail();
      sourcePins[path.relative(options.candidate, file).split(path.sep).join('/')] = expected;
    }
    const writerFile = path.join(__dirname, 'write-bootstrap.psm1');
    verifyPhysicalPath(writerFile, false);
    let writer = fs.readFileSync(writerFile, 'utf8');
    if (hash(writer) !== loadedPins[writerFile]) throw fail();
    for (const [marker, value] of Object.entries({
      __N09_CANDIDATE__: options.candidate,
      __N09_MANIFEST_SHA256__: options.manifestSha256,
      __N09_SOURCE_PINS__: JSON.stringify(sourcePins),
    })) {
      if (writer.split(marker).length !== 2) throw fail();
      writer = writer.replace(marker, () => value.replaceAll("'", "''"));
    }
    const file = path.join(controller.outputRoot, 'context-recovery-daemon-owned-controller.psm1');
    verifyPhysicalPath(file, false);
    let source = fs.readFileSync(file, 'utf8');
    if (hash(source) !== copyPins[path.basename(file)]) throw fail();
    const before = "    $State.startStage = 'gate_release'";
    if (source.split(before).length !== 2) throw fail();
    source =
      source.replace(
        before,
        '    Initialize-HpmN09AckBootstrap $OwnedRoot $caseRoot $process.Id $Request.token $ManifestSha256\n' +
          before
      ) +
      '\n' +
      writer;
    fs.writeFileSync(file, source, { flag: 'w' });
    verifyPhysicalPath(file, false);
    if (hash(fs.readFileSync(file)) !== hash(source)) throw fail();
    return Object.freeze({
      ...controller,
      copyPins: Object.freeze({
        ...copyPins,
        [path.basename(file)]: hash(source),
      }),
      sourcePins: Object.freeze(sourcePins),
    });
  } catch {
    throw fail();
  }
}

module.exports = { buildN09AckController };
