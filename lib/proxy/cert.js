const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DATA_DIR } = require('./config');

const CERT_DIR = process.env.PROXY_CERT_DIR || path.join(DATA_DIR, '.certs');
const CA_CERT_FILE = path.join(CERT_DIR, 'proxy-ca-cert.pem');
const CA_KEY_FILE = path.join(CERT_DIR, 'proxy-ca-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'proxy-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'proxy-key.pem');
const CSR_FILE = path.join(CERT_DIR, 'proxy-server.csr');
const SERVER_EXT_FILE = path.join(CERT_DIR, 'proxy-server.ext');
const CA_CNF_FILE = path.join(CERT_DIR, 'proxy-ca.cnf');
const SERVER_CNF_FILE = path.join(CERT_DIR, 'proxy-server.cnf');

function openssl(args, options = {}) {
  const opensslExe = process.env.PROXY_OPENSSL_EXE || 'openssl';
  return execFileSync(opensslExe, args, { stdio: 'pipe', ...options });
}

function writeConfigFiles() {
  fs.writeFileSync(CA_CNF_FILE, [
    '[req]',
    'distinguished_name = req_dn',
    'prompt = no',
    'x509_extensions = v3_ca',
    '',
    '[req_dn]',
    'CN = HTTPS Proxy Local Root CA',
    '',
    '[v3_ca]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always,issuer',
    '',
  ].join('\n'));

  fs.writeFileSync(SERVER_CNF_FILE, [
    '[req]',
    'distinguished_name = req_dn',
    'prompt = no',
    '',
    '[req_dn]',
    'CN = localhost',
    '',
  ].join('\n'));

  fs.writeFileSync(SERVER_EXT_FILE, [
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = DNS:localhost, IP:127.0.0.1',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    '',
  ].join('\n'));
}

function generateCaCert() {
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', CA_KEY_FILE,
    '-out', CA_CERT_FILE,
    '-days', '3650',
    '-nodes',
    '-config', CA_CNF_FILE,
  ]);
}

function generateServerCert() {
  openssl([
    'req', '-newkey', 'rsa:2048',
    '-keyout', KEY_FILE,
    '-out', CSR_FILE,
    '-nodes',
    '-config', SERVER_CNF_FILE,
  ]);

  openssl([
    'x509', '-req',
    '-in', CSR_FILE,
    '-CA', CA_CERT_FILE,
    '-CAkey', CA_KEY_FILE,
    '-CAcreateserial',
    '-out', CERT_FILE,
    '-days', '825',
    '-sha256',
    '-extfile', SERVER_EXT_FILE,
  ]);
}

function generateSelfSignedCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  writeConfigFiles();

  if (!fs.existsSync(CA_CERT_FILE) || !fs.existsSync(CA_KEY_FILE) || !caCertLooksValid()) {
    generateCaCert();
  }

  generateServerCert();
  console.log('[cert] Certificate generated:', CERT_FILE);
  console.log('[cert] Trust CA certificate:', CA_CERT_FILE);
}

function readCertText(file) {
  return openssl(['x509', '-in', file, '-noout', '-text'], { encoding: 'utf8' });
}

function readCertSubject(file) {
  return openssl(['x509', '-in', file, '-noout', '-subject'], { encoding: 'utf8' }).trim();
}

function readCertIssuer(file) {
  return openssl(['x509', '-in', file, '-noout', '-issuer'], { encoding: 'utf8' }).trim();
}

function caCertLooksValid() {
  try {
    if (!fs.existsSync(CA_CERT_FILE) || !fs.existsSync(CA_KEY_FILE)) return false;
    const text = readCertText(CA_CERT_FILE);
    return text.includes('CA:TRUE') && text.includes('Certificate Sign');
  } catch (err) {
    return false;
  }
}

function certHasRequiredSubjectAltNames() {
  try {
    const text = readCertText(CERT_FILE);
    return text.includes('DNS:localhost') && text.includes('IP Address:127.0.0.1');
  } catch (err) {
    return false;
  }
}

function serverCertLooksValid() {
  try {
    if (!fs.existsSync(CERT_FILE) || !fs.existsSync(KEY_FILE)) return false;
    const stat = fs.statSync(CERT_FILE);
    if (stat.size <= 200 || !certHasRequiredSubjectAltNames()) return false;
    const text = readCertText(CERT_FILE);
    if (!text.includes('CA:FALSE')) return false;
    return readCertSubject(CERT_FILE) !== readCertIssuer(CERT_FILE);
  } catch (err) {
    return false;
  }
}

function ensureCert() {
  if (caCertLooksValid() && serverCertLooksValid()) {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  }
  console.log('[cert] Generating local CA signed certificate...');
  try {
    generateSelfSignedCert();
  } catch (e) {
    console.error('[cert] Failed:', e.message);
    console.error('[cert] Make sure openssl is installed');
    process.exit(1);
  }
  return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
}

module.exports = {
  CERT_DIR,
  CA_CERT_FILE,
  CA_KEY_FILE,
  CERT_FILE,
  KEY_FILE,
  generateSelfSignedCert,
  certHasRequiredSubjectAltNames,
  caCertLooksValid,
  serverCertLooksValid,
  ensureCert,
};
