const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-cert-test-'));

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
    env: { ...process.env, PROXY_RUNTIME_DIR: tempDir },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const jsonLine = result.stdout
    .trim()
    .split(/\r?\n/)
    .find((line) => line.startsWith('{'));
  const payload = JSON.parse(jsonLine);

  assert.match(payload.commonName, /^HTTPS Proxy Local Root CA [0-9A-F]{10}$/);
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
    env: { ...process.env, PROXY_RUNTIME_DIR: tempDir },
    encoding: 'utf8',
  });
  assert.strictEqual(staleResult.status, 0, staleResult.stderr || staleResult.stdout);
  const stalePayload = JSON.parse(
    staleResult.stdout
      .trim()
      .split(/\r?\n/)
      .find((line) => line.startsWith('{'))
  );
  assert.strictEqual(stalePayload.staleValid, false);
  assert.strictEqual(stalePayload.repairedValid, true);
  assert.strictEqual(stalePayload.repairedLeafVerifyCurrentCa, true);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('[cert.test] ok');
