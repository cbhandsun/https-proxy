const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cert-test-'));
const sentinelCertDir = path.join(tempDir, 'ambient-certificate-sentinel');
fs.mkdirSync(sentinelCertDir);
fs.writeFileSync(path.join(sentinelCertDir, 'proxy-ca-cert.pem'), 'SYNTHETIC_UNTOUCHED_CERT');
fs.writeFileSync(path.join(sentinelCertDir, 'proxy-ca-key.pem'), 'SYNTHETIC_UNTOUCHED_KEY');
const inheritedEnv = { ...process.env, PROXY_CERT_DIR: sentinelCertDir };
const childEnv = {
  ...inheritedEnv,
  PROXY_RUNTIME_DIR: tempDir,
  PROXY_CERT_DIR: path.join(tempDir, '.certs'),
  HPM_DISALLOW_CA_ADOPT: '1',
};

try {
  const script = `
    const cert = require(${JSON.stringify(path.join(repoRoot, 'lib', 'proxy', 'cert'))});
    cert.ensureCert();
    const { X509Certificate } = require('crypto');
    const fs = require('fs');
    const ca = new X509Certificate(fs.readFileSync(cert.CA_CERT_FILE));
    const leaf = new X509Certificate(fs.readFileSync(cert.CERT_FILE));
    console.log(JSON.stringify({
      commonName: cert.CA_COMMON_NAME,
      certDir: cert.CERT_DIR,
      caSubject: ca.subject,
      leafIssuer: leaf.issuer,
      caSerial: ca.serialNumber,
      leafSerial: leaf.serialNumber,
      leafSubjectAltName: leaf.subjectAltName,
      caValid: cert.caCertLooksValid(),
      leafValid: cert.serverCertLooksValid()
    }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const jsonLine = result.stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => line.startsWith('{') && line.includes('"commonName"'));
  assert.ok(jsonLine, `certificate payload missing from child output: ${result.stdout}`);
  const payload = JSON.parse(jsonLine);

  assert.match(payload.commonName, /^HTTPS Proxy Local Root CA [0-9A-F]{10}$/);
  assert.strictEqual(payload.certDir, path.join(tempDir, '.certs'));
  assert.ok(payload.caSubject.includes(`CN=${payload.commonName}`));
  assert.ok(payload.leafIssuer.includes(`CN=${payload.commonName}`));
  assert.notStrictEqual(payload.commonName, 'HTTPS Proxy Local Root CA');
  assert.notStrictEqual(payload.caSerial, '01');
  assert.notStrictEqual(payload.leafSerial, '02');
  assert.match(payload.leafSubjectAltName, /DNS:localhost/);
  assert.match(payload.leafSubjectAltName, /DNS:host\.docker\.internal/);
  assert.match(payload.leafSubjectAltName, /IP Address:127\.0\.0\.1/);
  assert.strictEqual(payload.caValid, true);
  assert.strictEqual(payload.leafValid, true);

  const staleLeafScript = `
    const cert = require(${JSON.stringify(path.join(repoRoot, 'lib', 'proxy', 'cert'))});
    const { X509Certificate } = require('crypto');
    const fs = require('fs');

    cert.ensureCert();
    const staleLeaf = fs.readFileSync(cert.CERT_FILE);
    const staleKey = fs.readFileSync(cert.KEY_FILE);
    fs.rmSync(cert.CA_CERT_FILE, { force: true });
    fs.rmSync(cert.CA_KEY_FILE, { force: true });
    cert.generateSelfSignedCert();
    fs.writeFileSync(cert.CERT_FILE, staleLeaf);
    fs.writeFileSync(cert.KEY_FILE, staleKey);

    const staleValid = cert.serverCertLooksValid();
    cert.ensureCert();
    const ca = new X509Certificate(fs.readFileSync(cert.CA_CERT_FILE));
    const leaf = new X509Certificate(fs.readFileSync(cert.CERT_FILE));
    console.log(JSON.stringify({
      staleValid,
      repairedValid: cert.serverCertLooksValid(),
      repairedLeafVerifyCurrentCa: leaf.verify(ca.publicKey)
    }));
  `;
  const staleResult = spawnSync(process.execPath, ['-e', staleLeafScript], {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
  });
  assert.strictEqual(staleResult.status, 0, staleResult.stderr || staleResult.stdout);
  const stalePayload = JSON.parse(
    staleResult.stdout
      .trim()
      .split(/\r?\n/)
      .find((line) => line.startsWith('{') && line.includes('"staleValid"'))
  );
  assert.strictEqual(stalePayload.staleValid, false);
  assert.strictEqual(stalePayload.repairedValid, true);
  assert.strictEqual(stalePayload.repairedLeafVerifyCurrentCa, true);

  const legacyPrelude = `
    const assert = require('node:assert/strict');
    const cert = require(${JSON.stringify(path.join(repoRoot, 'lib', 'proxy', 'cert'))});
    const fs = require('node:fs');
    const legacy = require(${JSON.stringify(path.join(repoRoot, 'test', 'fixtures', 'synthetic-legacy-ca.json'))});
    const lookalike = require(${JSON.stringify(path.join(repoRoot, 'test', 'fixtures', 'synthetic-lookalike-leaf.json'))});
    const { X509Certificate } = require('node:crypto');
    const der = require(${JSON.stringify(path.join(repoRoot, 'lib', 'proxy', 'certificate-der'))});
  `;
  const legacyScenarios = [
    `
    fs.writeFileSync(cert.CA_CERT_FILE, legacy.cert);
    fs.writeFileSync(cert.CA_KEY_FILE, legacy.key);
    cert.ensureCert();
    assert.equal(fs.readFileSync(cert.CA_CERT_FILE, 'utf8'), legacy.cert);
    assert.equal(fs.readFileSync(cert.CA_KEY_FILE, 'utf8'), legacy.key);
    const firstLeaf = fs.readFileSync(cert.CERT_FILE, 'utf8');
    const firstKey = fs.readFileSync(cert.KEY_FILE, 'utf8');
    cert.ensureCert();
    assert.equal(fs.readFileSync(cert.CERT_FILE, 'utf8'), firstLeaf);
    assert.equal(fs.readFileSync(cert.KEY_FILE, 'utf8'), firstKey);
  `,
    `
    fs.writeFileSync(cert.KEY_FILE, legacy.key);
    assert.equal(cert.serverCertLooksValid(), false);
    cert.ensureCert();
    assert.equal(cert.serverCertLooksValid(), true);
  `,
    `
    fs.writeFileSync(cert.CERT_FILE, lookalike.cert);
    fs.writeFileSync(cert.KEY_FILE, lookalike.key);
    assert.equal(cert.serverCertLooksValid(), false);
    assert.equal(cert.certHasRequiredSubjectAltNames(new X509Certificate(lookalike.cert)), false);
    assert.equal(cert.certHasRequiredSubjectAltNames(null), false);
    cert.ensureCert();
    assert.equal(cert.serverCertLooksValid(), true);
    assert.equal(fs.readFileSync(cert.CA_CERT_FILE, 'utf8'), legacy.cert);
    assert.equal(fs.readFileSync(cert.CA_KEY_FILE, 'utf8'), legacy.key);
  `,
    `
    fs.writeFileSync(cert.CA_CERT_FILE, 'CORRUPT_SYNTHETIC_CA');
    assert.equal(cert._test.extractCaCommonName(legacy.cert), 'HTTPS Proxy Local Root CA');
    const raw = new X509Certificate(legacy.cert).raw;
    const outer = der.children(raw, der.read(raw));
    const fields = der.children(raw, outer[0]);
    const spoofName = der.sequence(der.encode(49, der.sequence(der.encode(6, Buffer.from('550403', 'hex')),
      der.encode(12, Buffer.from('HTTPS Proxy Local Root CA SPOOF')))));
    const spoofTbs = der.sequence(...fields.map((field, index) => index === 5 ? spoofName : raw.subarray(field.start, field.end)));
    const spoof = der.sequence(spoofTbs, ...outer.slice(1).map((field) => raw.subarray(field.start, field.end)));
    assert.equal(cert._test.extractCaCommonName(spoof), null);
    assert.throws(() => cert.generateSelfSignedCert(), { message: 'certificate_existing_ca_invalid' });
    assert.equal(fs.readFileSync(cert.CA_CERT_FILE, 'utf8'), 'CORRUPT_SYNTHETIC_CA');
    assert.equal(fs.readFileSync(cert.CA_KEY_FILE, 'utf8'), legacy.key);
  `,
  ];
  for (const scenario of legacyScenarios) {
    const legacyResult = spawnSync(process.execPath, ['-e', legacyPrelude + scenario], {
      cwd: repoRoot,
      env: childEnv,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.strictEqual(legacyResult.status, 0, legacyResult.stderr || legacyResult.stdout);
  }
  assert.strictEqual(
    fs.readFileSync(path.join(sentinelCertDir, 'proxy-ca-cert.pem'), 'utf8'),
    'SYNTHETIC_UNTOUCHED_CERT'
  );
  assert.strictEqual(
    fs.readFileSync(path.join(sentinelCertDir, 'proxy-ca-key.pem'), 'utf8'),
    'SYNTHETIC_UNTOUCHED_KEY'
  );
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('[cert.test] ok');
