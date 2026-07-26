const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const { X509Certificate } = require('crypto');
const { createLogger } = require('./logger');

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

let forgeModule = null;
function getForge() {
  if (!forgeModule) forgeModule = require('node-forge');
  return forgeModule;
}

function generateSelfSignedCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const forge = getForge();

  let caCert, caKey;
  if (caCertLooksValid()) {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_FILE, 'utf8'));
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_FILE, 'utf8'));
  } else {
    const { publicKey: caPub, privateKey: caPriv } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const caKeys = {
      publicKey: forge.pki.publicKeyFromPem(caPub),
      privateKey: forge.pki.privateKeyFromPem(caPriv),
    };
    caCert = forge.pki.createCertificate();
    caCert.publicKey = caKeys.publicKey;
    caCert.serialNumber = randomSerialHex();
    caCert.validity.notBefore = new Date();
    caCert.validity.notAfter = new Date();
    caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);
    const caAttrs = [{ name: 'commonName', value: CA_COMMON_NAME }];
    caCert.setSubject(caAttrs);
    caCert.setIssuer(caAttrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true, pathLenConstraint: 0 },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyid: true, always: true, issuer: true },
    ]);
    caCert.sign(caKeys.privateKey, forge.md.sha256.create());
    caKey = caKeys.privateKey;

    fs.writeFileSync(CA_KEY_FILE, forge.pki.privateKeyToPem(caKey));
    fs.writeFileSync(CA_CERT_FILE, forge.pki.certificateToPem(caCert));
  }

  // Generate Server
  const { publicKey: srvPub, privateKey: srvPriv } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keys = {
    publicKey: forge.pki.publicKeyFromPem(srvPub),
    privateKey: forge.pki.privateKeyFromPem(srvPriv),
  };
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: 'host.docker.internal' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyid: true, issuer: true },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  fs.writeFileSync(KEY_FILE, forge.pki.privateKeyToPem(keys.privateKey));
  fs.writeFileSync(CERT_FILE, forge.pki.certificateToPem(cert));

  safeLog.info('[cert] Certificate generated:', CERT_FILE);
  safeLog.info('[cert] Trust CA certificate:', CA_CERT_FILE);
}

function caCertLooksValid() {
  try {
    if (!fs.existsSync(CA_CERT_FILE) || !fs.existsSync(CA_KEY_FILE)) return false;
    const cert = new X509Certificate(fs.readFileSync(CA_CERT_FILE, 'utf8'));
    if (!cert.ca) return false;
    if (!cert.subject.includes(`CN=${CA_COMMON_NAME}`)) return false;
    if (Date.now() > Date.parse(cert.validTo)) return false;
    return true;
  } catch (err) {
    return false;
  }
}

function certHasRequiredSubjectAltNames(cert) {
  try {
    const ext = cert.extensions.find((e) => e.name === 'subjectAltName');
    if (!ext) return false;
    const dnsNames = new Set(
      ext.altNames.filter((altName) => altName.type === 2).map((altName) => altName.value)
    );
    const hasIp = ext.altNames.some((a) => a.type === 7 && a.ip === '127.0.0.1');
    return REQUIRED_SERVER_DNS_NAMES.every((name) => dnsNames.has(name)) && hasIp;
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
    if (!cert.issuer.includes(`CN=${CA_COMMON_NAME}`)) return false;
    if (!cert.verify(caCert.publicKey)) return false;
    if (Date.now() > Date.parse(cert.validTo)) return false;
    const subjectAltName = cert.subjectAltName || '';
    if (!REQUIRED_SERVER_DNS_NAMES.every((name) => subjectAltName.includes(`DNS:${name}`))) {
      return false;
    }
    if (!subjectAltName.includes('IP Address:127.0.0.1')) return false;
    return true;
  } catch (err) {
    return false;
  }
}

function randomSerialHex() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes.toString('hex').toUpperCase();
}

function ensureCert() {
  if (caCertLooksValid() && serverCertLooksValid()) {
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  }
  safeLog.info('[cert] Generating local CA signed certificate...');
  try {
    generateSelfSignedCert();
  } catch (e) {
    safeLog.error({ err: e }, '[cert] Certificate generation failed');
    process.exit(1);
  }
  return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
}

module.exports = {
  CERT_DIR,
  CA_CERT_FILE,
  CA_KEY_FILE,
  CA_COMMON_NAME,
  CERT_FILE,
  KEY_FILE,
  REQUIRED_SERVER_DNS_NAMES,
  randomSerialHex,
  generateSelfSignedCert,
  certHasRequiredSubjectAltNames,
  caCertLooksValid,
  serverCertLooksValid,
  ensureCert,
};
