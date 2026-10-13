'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeCertificateFiles } = require('../lib/proxy/certificate-files');

test('exclusive root initialization never replaces existing material and rolls back partial creation', () =>
  fixture((directory) => {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    fs.writeFileSync(cert, 'already-initialized-root');
    assert.throws(
      () =>
        writeCertificateFiles([
          { path: key, content: 'new-key', exclusive: true },
          { path: cert, content: 'new-root', exclusive: true },
        ]),
      { message: 'certificate_file_install_failed' }
    );
    assert.equal(fs.existsSync(key), false);
    assert.equal(fs.readFileSync(cert, 'utf8'), 'already-initialized-root');
    writeCertificateFiles([{ path: key, content: 'new-key', exclusive: true }]);
    assert.equal(fs.readFileSync(key, 'utf8'), 'new-key');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['cert.pem', 'key.pem']);
  }));

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-certificate-files-'));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('staged certificate pair installs securely with no temporary leftovers', () =>
  fixture((directory) => {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    writeCertificateFiles([
      { path: key, content: 'test-key-one' },
      { path: cert, content: 'test-cert-one' },
    ]);
    writeCertificateFiles([
      { path: key, content: 'test-key-two' },
      { path: cert, content: 'test-cert-two' },
    ]);
    assert.equal(fs.readFileSync(key, 'utf8'), 'test-key-two');
    assert.equal(fs.readFileSync(cert, 'utf8'), 'test-cert-two');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['cert.pem', 'key.pem']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(key).mode & 511, 384);
  }));

test('partial rename failure rolls both original files back and returns only fixed code', () =>
  fixture((directory) => {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    fs.writeFileSync(key, 'original-key');
    fs.writeFileSync(cert, 'original-cert');
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (source.endsWith('.tmp') && target === cert) throw new Error('SECRET_PATH_CONTENT');
      return rename(source, target);
    };
    try {
      assert.throws(
        () =>
          writeCertificateFiles([
            { path: key, content: 'new-key' },
            { path: cert, content: 'new-cert' },
          ]),
        { message: 'certificate_file_install_failed' }
      );
    } finally {
      fs.renameSync = rename;
    }
    assert.equal(fs.readFileSync(key, 'utf8'), 'original-key');
    assert.equal(fs.readFileSync(cert, 'utf8'), 'original-cert');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['cert.pem', 'key.pem']);
  }));

test('failed rollback retains the recoverable backup and reports recovery required', () =>
  fixture((directory) => {
    const key = path.join(directory, 'key.pem');
    const cert = path.join(directory, 'cert.pem');
    fs.writeFileSync(key, 'original-key');
    fs.writeFileSync(cert, 'original-cert');
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (
        (source.endsWith('.tmp') && target === cert) ||
        (source.endsWith('.bak') && target === key)
      )
        throw new Error('SECRET_PATH_CONTENT');
      return rename(source, target);
    };
    try {
      assert.throws(
        () =>
          writeCertificateFiles([
            { path: key, content: 'new-key' },
            { path: cert, content: 'new-cert' },
          ]),
        { message: 'certificate_file_recovery_required' }
      );
    } finally {
      fs.renameSync = rename;
    }
    const backups = fs.readdirSync(directory).filter((item) => item.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), 'original-key');
    assert.equal(fs.readFileSync(cert, 'utf8'), 'original-cert');
    assert.equal(
      fs.readdirSync(directory).some((item) => item.endsWith('.tmp')),
      false
    );
  }));

test('invalid, empty, duplicate, extreme and accessor inputs are rejected before any writes', () =>
  fixture((directory) => {
    const target = path.join(directory, 'key.pem');
    let accessed = false;
    for (const files of [
      undefined,
      null,
      {},
      [],
      new Array(5),
      [undefined],
      [{}],
      [{ path: 'relative.pem', content: 'x' }],
      [{ path: target, content: '' }],
      [{ path: target, content: 'x'.repeat(33000) }],
      [
        { path: target, content: 'x' },
        { path: target, content: 'y' },
      ],
      [
        {
          get path() {
            accessed = true;
            return target;
          },
          content: 'x',
        },
      ],
      [
        {
          path: target,
          get content() {
            accessed = true;
            return 'SECRET';
          },
        },
      ],
    ]) {
      assert.throws(() => writeCertificateFiles(files), {
        message: 'certificate_file_input_invalid',
      });
    }
    assert.equal(accessed, false);
    assert.deepEqual(fs.readdirSync(directory), []);
    const existingDirectory = path.join(directory, 'do-not-move');
    fs.mkdirSync(existingDirectory);
    assert.throws(() => writeCertificateFiles([{ path: existingDirectory, content: 'x' }]), {
      message: 'certificate_file_install_failed',
    });
    assert.ok(fs.statSync(existingDirectory).isDirectory());
  }));
