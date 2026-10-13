const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR, PROJECT_ROOT } = require('./config');
const { X509Certificate } = require('crypto');
const { createLogger } = require('./logger');
const { ensurePrivateDirectorySync, ensurePrivateFileSync } = require('./secure-files');
const { generateCertificatePair, randomSerialHex } = require('./certificate-native');
const { writeCertificateFiles } = require('./certificate-files');

const safeLog = createLogger('cert');
const CERT_DIR = process.env.PROXY_CERT_DIR || path.join(DATA_DIR, '.certs');
const CA_CERT_FILE = path.join(CERT_DIR, 'proxy-ca-cert.pem');
const CA_KEY_FILE = path.join(CERT_DIR, 'proxy-ca-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'proxy-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'proxy-key.pem');
const REQUIRED_SERVER_DNS_NAMES = ['localhost', 'host.docker.internal'];
const CA_COMMON_NAME_SUFFIX = crypto
  .createHash('sha256')
  .update(path.resolve(CERT_DIR).toLowerCase())
  .digest('hex')
  .slice(0, 10)
  .toUpperCase();
const CA_COMMON_NAME = `HTTPS Proxy Local Root CA ${CA_COMMON_NAME_SUFFIX}`;

function getCaCommonName() {
  try {
    if (fs.existsSync(CA_CERT_FILE)) {
      const pem = fs.readFileSync(CA_CERT_FILE, 'utf8');
      const cn = extractCaCommonName(pem);
      if (cn) return cn;
    }
  } catch (_) {}
  return CA_COMMON_NAME;
}

function generateSelfSignedCert() {
  ensurePrivateDirectorySync(CERT_DIR);
  const reuse = caCertLooksValid();
  // A broken/expired existing root requires explicit recovery, not an invisible
  // trust rotation. Valid roots and private keys are never rewritten.
  if (!reuse && (fs.existsSync(CA_CERT_FILE) || fs.existsSync(CA_KEY_FILE))) {
    throw new Error('certificate_existing_ca_invalid');
  }
  const pair = generateCertificatePair(
    CA_COMMON_NAME,
    reuse ? fs.readFileSync(CA_CERT_FILE, 'utf8') : undefined,
    reuse ? fs.readFileSync(CA_KEY_FILE, 'utf8') : undefined
  );
  const files = [];
  if (!pair.reusedCa)
    files.push(
      { path: CA_KEY_FILE, content: pair.caKeyPem, exclusive: true },
      { path: CA_CERT_FILE, content: pair.caCertPem, exclusive: true }
    );
  files.push({ path: KEY_FILE, content: pair.keyPem }, { path: CERT_FILE, content: pair.certPem });
  writeCertificateFiles(files);

  safeLog.info('[cert] Certificate generated:', CERT_FILE);
  safeLog.info('[cert] Trust CA certificate:', CA_CERT_FILE);
}

function validateCaKeyPair(certPath, keyPath) {
  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return false;
    const certPem = fs.readFileSync(certPath, 'utf8');
    const keyPem = fs.readFileSync(keyPath, 'utf8');
    const cert = new X509Certificate(certPem);
    if (!cert.ca) return false;
    if (!extractCaCommonName(certPem)) return false;
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo))
      return false;
    const key = crypto.createPrivateKey(keyPem);
    return (
      key.asymmetricKeyType === 'rsa' && cert.checkPrivateKey(key) && cert.verify(cert.publicKey)
    );
  } catch (err) {
    return false;
  }
}

function extractCaCommonName(certPem) {
  try {
    const cert = new X509Certificate(certPem);
    const names = cert.subject.split('\n').filter((line) => line.startsWith('CN='));
    if (names.length !== 1) return null;
    const value = names[0].slice(3);
    return value.trim() === value && /^HTTPS Proxy Local Root CA(?: [0-9A-F]{10})?$/.test(value)
      ? value
      : null;
  } catch (err) {
    return null;
  }
}

function tryAdoptInstalledCa() {
  if (process.platform !== 'win32') return false;
  // Never adopt host installed CA in isolated/temporary test runs
  if (
    process.env.PROXY_RUNTIME_DIR ||
    process.env.PROXY_CERT_DIR ||
    process.env.HPM_DISALLOW_CA_ADOPT === '1'
  ) {
    return false;
  }
  const defaultDevCertDir = path.resolve(PROJECT_ROOT, '.hpm-runtime', '.certs').toLowerCase();
  if (path.resolve(CERT_DIR).toLowerCase() !== defaultDevCertDir) {
    return false;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return false;
  const installedCertsDir = path.join(
    localAppData,
    'HTTPS Proxy Manager',
    '.hpm-runtime',
    '.certs'
  );
  if (path.resolve(installedCertsDir).toLowerCase() === path.resolve(CERT_DIR).toLowerCase()) {
    return false;
  }
  const installedCaCert = path.join(installedCertsDir, 'proxy-ca-cert.pem');
  const installedCaKey = path.join(installedCertsDir, 'proxy-ca-key.pem');
  if (!validateCaKeyPair(installedCaCert, installedCaKey)) return false;

  try {
    ensurePrivateDirectorySync(CERT_DIR);
    fs.copyFileSync(installedCaCert, CA_CERT_FILE);
    fs.copyFileSync(installedCaKey, CA_KEY_FILE);
    ensurePrivateFileSync(CA_KEY_FILE);
    safeLog.info('[cert] Adopted root CA from installed app runtime:', installedCaCert);
    return true;
  } catch (err) {
    safeLog.warn('[cert] Failed to adopt root CA from installed app runtime');
    return false;
  }
}

function caCertLooksValid() {
  try {
    if (!fs.existsSync(CA_CERT_FILE) || !fs.existsSync(CA_KEY_FILE)) return false;
    return validateCaKeyPair(CA_CERT_FILE, CA_KEY_FILE);
  } catch (err) {
    return false;
  }
}

function certHasRequiredSubjectAltNames(cert) {
  try {
    if (!(cert instanceof X509Certificate)) return false;
    return (
      REQUIRED_SERVER_DNS_NAMES.every(
        (name) => cert.checkHost(name, { subject: 'never', wildcards: false }) === name
      ) && cert.checkIP('127.0.0.1') === '127.0.0.1'
    );
  } catch (err) {
    return false;
  }
}

function serverCertLooksValid() {
  try {
    if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) return false;
    const stat = fs.statSync(CERT_FILE);
    if (stat.size <= 200) return false;
    const cert = new X509Certificate(fs.readFileSync(CERT_FILE, 'utf8'));
    const caCert = new X509Certificate(fs.readFileSync(CA_CERT_FILE, 'utf8'));
    if (cert.ca) return false;
    if (!cert.checkIssued(caCert) || !cert.verify(caCert.publicKey)) return false;
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo))
      return false;
    if (!cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(KEY_FILE, 'utf8'))))
      return false;
    return certHasRequiredSubjectAltNames(cert);
  } catch (err) {
    return false;
  }
}

function ensureCert() {
  ensurePrivateDirectorySync(CERT_DIR);
  if (!caCertLooksValid()) {
    tryAdoptInstalledCa();
  }
  if (fs.existsSync(CA_KEY_FILE)) ensurePrivateFileSync(CA_KEY_FILE);
  if (fs.existsSync(KEY_FILE)) ensurePrivateFileSync(KEY_FILE);
  if (caCertLooksValid() && serverCertLooksValid()) {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  }
  safeLog.info('[cert] Generating local CA signed certificate...');
  try {
    generateSelfSignedCert();
  } catch (e) {
    safeLog.error('[cert] Certificate generation failed');
    process.exit(1);
  }
  return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
}

module.exports = {
  CERT_DIR,
  CA_CERT_FILE,
  CA_KEY_FILE,
  CA_COMMON_NAME,
  getCaCommonName,
  CERT_FILE,
  KEY_FILE,
  REQUIRED_SERVER_DNS_NAMES,
  randomSerialHex,
  generateSelfSignedCert,
  certHasRequiredSubjectAltNames,
  caCertLooksValid,
  serverCertLooksValid,
  ensureCert,
  _test: {
    validateCaKeyPair,
    extractCaCommonName,
    tryAdoptInstalledCa,
  },
};
