'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const https = require('node:https');
const test = require('node:test');
const {
  generateCertificatePair,
  issuerFields,
  randomSerialHex,
} = require('../lib/proxy/certificate-native');
const legacy = require('./fixtures/synthetic-legacy-ca.json');

const commonName = 'HTTPS Proxy Local Root CA 012345ABCD';
const pair = generateCertificatePair(commonName);

test('native RSA certificates have verified chain, key pairs, intended SANs and constraints', () => {
  const ca = new crypto.X509Certificate(pair.caCertPem);
  const leaf = new crypto.X509Certificate(pair.certPem);
  assert.equal(pair.reusedCa, false);
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.ok(ca.verify(ca.publicKey));
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(leaf.checkIssued(ca));
  assert.ok(ca.checkPrivateKey(crypto.createPrivateKey(pair.caKeyPem)));
  assert.ok(leaf.checkPrivateKey(crypto.createPrivateKey(pair.keyPem)));
  assert.equal(leaf.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.equal(leaf.checkHost('localhost', { subject: 'never' }), 'localhost');
  assert.equal(leaf.checkHost('host.docker.internal'), 'host.docker.internal');
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(leaf.checkHost('localhost.evil.invalid'), undefined);
  assert.ok(leaf.keyUsage.includes('1.3.6.1.5.5.7.3.1'));
  assert.ok(Date.parse(leaf.validTo) <= Date.parse(ca.validTo));
  for (let i = 0; i < 20; i++) assert.match(randomSerialHex(), /^[0-7][0-9A-F]{31}$/);
});

test('legacy forge CA/private key and complete multi-RDN issuer bytes survive unchanged', () => {
  const reused = generateCertificatePair(commonName, legacy.cert, legacy.key);
  const ca = new crypto.X509Certificate(legacy.cert);
  const leaf = new crypto.X509Certificate(reused.certPem);
  assert.equal(reused.reusedCa, true);
  assert.equal(reused.caCertPem, legacy.cert);
  assert.equal(reused.caKeyPem, legacy.key);
  assert.equal(leaf.issuer, ca.subject);
  assert.ok(leaf.checkIssued(ca));
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(issuerFields(ca).subject.length > 0);
});

test('validity is capped to issuer lifetime and GeneralizedTime works across 2050', () => {
  const nearExpiry = generateCertificatePair(
    commonName,
    legacy.cert,
    legacy.key,
    new Date('2039-12-01Z')
  );
  assert.equal(
    new crypto.X509Certificate(nearExpiry.certPem).validTo,
    new crypto.X509Certificate(legacy.cert).validTo
  );
  const future = generateCertificatePair(commonName, undefined, undefined, new Date('2049-12-01Z'));
  assert.equal(new Date(new crypto.X509Certificate(future.certPem).validTo).getUTCFullYear(), 2051);
});

test('invalid, empty, mismatched, expired, extreme and unsafe inputs yield content-free error codes', () => {
  const leafAsCa = pair.certPem;
  for (const args of [
    ['', undefined, undefined],
    ['evil\nsecret', undefined, undefined],
    [commonName + '\n', undefined, undefined],
    ['X'.repeat(10000), undefined, undefined],
    [null, undefined, undefined],
    [commonName, legacy.cert, undefined],
    [commonName, undefined, legacy.key],
    [commonName, '', ''],
    [commonName, 'SECRET_CA_VALUE', 'SECRET_KEY_VALUE'],
    [commonName, 'X'.repeat(33000), legacy.key],
    [commonName, legacy.cert, 'X'.repeat(33000)],
    [commonName, legacy.cert, pair.caKeyPem],
    [commonName, leafAsCa, pair.keyPem],
    [commonName, legacy.cert, legacy.key, new Date('2041-01-01Z')],
    [commonName, legacy.cert, legacy.key, new Date('2019-01-01Z')],
    [commonName, undefined, undefined, new Date(NaN)],
    [commonName, undefined, undefined, new Date('2200-01-01Z')],
    [commonName, undefined, undefined, {}],
  ]) {
    assert.throws(() => generateCertificatePair(...args), {
      message: 'certificate_generation_failed',
    });
  }
  let accessed = false;
  assert.throws(
    () =>
      generateCertificatePair({
        get toString() {
          accessed = true;
          return () => commonName;
        },
      }),
    { message: 'certificate_generation_failed' }
  );
  assert.equal(accessed, false);
});

test('real isolated HTTPS handshake trusts legacy root and verifies generated leaf hostname', async () => {
  const reused = generateCertificatePair(commonName, legacy.cert, legacy.key);
  const server = https.createServer({ cert: reused.certPem, key: reused.keyPem }, (_req, res) =>
    res.end('fixture-ok')
  );
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const result = await new Promise((resolve, reject) => {
      const req = https.get(
        { host: '127.0.0.1', port, servername: 'localhost', ca: legacy.cert },
        (res) => {
          let body = '';
          const authorized = res.socket.authorized;
          res.setEncoding('utf8');
          res.on('data', (data) => {
            body += data;
          });
          res.on('end', () => resolve({ body, authorized }));
        }
      );
      req.setTimeout(5000, () => req.destroy(new Error('fixture_timeout')));
      req.on('error', reject);
    });
    assert.deepEqual(result, { body: 'fixture-ok', authorized: true });
    await assert.rejects(
      new Promise((resolve, reject) => {
        const req = https.get(
          { host: '127.0.0.1', port, servername: 'wrong.invalid', ca: legacy.cert },
          resolve
        );
        req.setTimeout(5000, () => req.destroy(new Error('fixture_timeout')));
        req.on('error', reject);
      }),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
