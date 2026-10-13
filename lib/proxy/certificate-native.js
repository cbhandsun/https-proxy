'use strict';

const crypto = require('node:crypto');
const der = require('./certificate-der');
const { X509Certificate } = crypto;
const SIGNATURE_ALGORITHM = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
const OIDS = {
  basic: '551d13',
  usage: '551d0f',
  extended: '551d25',
  san: '551d11',
  ski: '551d0e',
  aki: '551d23',
};

function invalid() {
  throw new Error('certificate_generation_failed');
}

function boundedPem(value) {
  if (typeof value !== 'string' || !value.length || value.length > 32 * 1024) invalid();
  return value;
}

function oid(hex) {
  return der.encode(6, Buffer.from(hex, 'hex'));
}

function name(commonName) {
  return der.sequence(
    der.encode(49, der.sequence(oid('550403'), der.encode(12, Buffer.from(commonName))))
  );
}

function time(milliseconds) {
  const date = new Date(milliseconds);
  const iso = date.toISOString();
  const digits = iso.slice(0, 19).replace(/[-:T]/g, '') + 'Z';
  return der.encode(
    date.getUTCFullYear() < 2050 ? 23 : 24,
    Buffer.from(date.getUTCFullYear() < 2050 ? digits.slice(2) : digits, 'ascii')
  );
}

function extension(id, value, critical = false) {
  return der.sequence(
    oid(OIDS[id]),
    ...(critical ? [der.encode(1, Buffer.from([255]))] : []),
    der.encode(4, value)
  );
}

function subjectKeyId(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const fields = der.children(spki, der.read(spki));
  const bits = fields[1];
  if (fields.length !== 2 || bits.tag !== 3 || spki[bits.content] !== 0) invalid();
  // RFC 5280 method 1; SHA-1 here is an identifier, never a signature algorithm.
  return crypto
    .createHash('sha1')
    .update(spki.subarray(bits.content + 1, bits.end))
    .digest();
}

function issuerFields(cert) {
  if (!(cert instanceof X509Certificate)) invalid();
  const raw = cert.raw;
  const root = der.read(raw);
  const outer = der.children(raw, root);
  if (root.tag !== 48 || root.end !== raw.length || outer.length !== 3 || outer[0].tag !== 48)
    invalid();
  const fields = der.children(raw, outer[0]);
  const version = fields[0]?.tag === 160 ? 1 : 0;
  const serial = fields[version];
  const subject = fields[version + 4];
  if (serial?.tag !== 2 || subject?.tag !== 48) invalid();
  let keyId = subjectKeyId(cert.publicKey);
  const extensions = fields.find((field) => field.tag === 163);
  if (extensions) {
    const wrapper = der.children(raw, extensions);
    if (wrapper.length !== 1 || wrapper[0].tag !== 48) invalid();
    let found = false;
    for (const item of der.children(raw, wrapper[0])) {
      if (item.tag !== 48) invalid();
      const parts = der.children(raw, item, 3);
      if (parts[0]?.tag !== 6) invalid();
      if (raw.subarray(parts[0].content, parts[0].end).toString('hex') !== OIDS.ski) continue;
      if (found) invalid();
      found = true;
      const value = parts.at(-1);
      if (value.tag !== 4) invalid();
      const inner = der.read(raw, value.content, value.end);
      if (
        inner.tag !== 4 ||
        inner.end !== value.end ||
        inner.end - inner.content < 1 ||
        inner.end - inner.content > 64
      )
        invalid();
      keyId = raw.subarray(inner.content, inner.end);
    }
  }
  return {
    subject: raw.subarray(subject.start, subject.end),
    serial: raw.subarray(serial.content, serial.end),
    keyId,
  };
}

function randomSerialHex() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 127;
  if (!bytes[0]) bytes[0] = 1;
  return bytes.toString('hex').toUpperCase();
}

function certificate(
  publicKey,
  signingKey,
  subject,
  issuer,
  authority,
  isCa,
  notBefore,
  notAfter,
  serial
) {
  const keyId = subjectKeyId(publicKey);
  const aki = der.sequence(
    der.encode(128, authority.keyId),
    der.encode(161, der.encode(164, issuer)),
    der.encode(130, authority.serial)
  );
  const extensions = [
    extension(
      'basic',
      isCa
        ? der.sequence(der.encode(1, Buffer.from([255])), der.positiveInteger(Buffer.from([0])))
        : der.sequence(),
      true
    ),
    extension('usage', der.encode(3, Buffer.from(isCa ? [1, 6] : [5, 160])), true),
    extension('ski', der.encode(4, keyId)),
    extension('aki', aki),
  ];
  if (!isCa)
    extensions.push(
      extension('extended', der.sequence(oid('2b06010505070301'))),
      extension(
        'san',
        der.sequence(
          der.encode(130, Buffer.from('localhost', 'ascii')),
          der.encode(130, Buffer.from('host.docker.internal', 'ascii')),
          der.encode(135, Buffer.from([127, 0, 0, 1]))
        )
      )
    );
  const tbs = der.sequence(
    der.encode(160, der.positiveInteger(Buffer.from([2]))),
    der.positiveInteger(serial),
    SIGNATURE_ALGORITHM,
    issuer,
    der.sequence(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
    der.encode(163, der.sequence(...extensions))
  );
  const signature = crypto.sign('sha256', tbs, {
    key: signingKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  const raw = der.sequence(
    tbs,
    SIGNATURE_ALGORITHM,
    der.encode(3, Buffer.concat([Buffer.from([0]), signature]))
  );
  const pem = `-----BEGIN CERTIFICATE-----\n${raw
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  const cert = new X509Certificate(pem);
  if (cert.ca !== isCa || !cert.verify(crypto.createPublicKey(signingKey))) invalid();
  return pem;
}

function keys() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

// Synchronous to preserve the existing startup contract. No disk, trust-store,
// subprocess or logging access. Existing CA subject DER is copied byte-for-byte.
function generateCertificatePair(commonName, caCertPem, caKeyPem, now = new Date()) {
  try {
    if (
      typeof commonName !== 'string' ||
      commonName.length > 60 ||
      commonName.trim() !== commonName ||
      !/^HTTPS Proxy Local Root CA(?: [0-9A-F]{10})?$/.test(commonName)
    )
      invalid();
    const timestamp = Date.prototype.getTime.call(now);
    const year = new Date(timestamp).getUTCFullYear();
    if (!Number.isFinite(timestamp) || year < 2000 || year > 2100) invalid();
    if ((caCertPem === undefined) !== (caKeyPem === undefined)) invalid();
    const reusedCa = caCertPem !== undefined;
    let caKey;
    if (reusedCa) {
      caKey = crypto.createPrivateKey(boundedPem(caKeyPem));
      boundedPem(caCertPem);
    } else {
      const pair = keys();
      caKey = pair.privateKey;
      const subject = name(commonName);
      const serial = Buffer.from(randomSerialHex(), 'hex');
      const expiry = new Date(timestamp);
      expiry.setUTCFullYear(expiry.getUTCFullYear() + 10);
      caCertPem = certificate(
        pair.publicKey,
        caKey,
        subject,
        subject,
        { keyId: subjectKeyId(pair.publicKey), serial },
        true,
        timestamp - 60000,
        expiry.getTime(),
        serial
      );
      caKeyPem = caKey.export({ type: 'pkcs8', format: 'pem' });
    }
    const ca = new X509Certificate(caCertPem);
    if (
      caKey.asymmetricKeyType !== 'rsa' ||
      !ca.ca ||
      !ca.checkPrivateKey(caKey) ||
      !ca.verify(ca.publicKey) ||
      Date.parse(ca.validFrom) > timestamp ||
      Date.parse(ca.validTo) <= timestamp
    )
      invalid();
    const issuer = issuerFields(ca);
    const pair = keys();
    const expiry = new Date(timestamp);
    expiry.setUTCFullYear(expiry.getUTCFullYear() + 2);
    const certPem = certificate(
      pair.publicKey,
      caKey,
      name('localhost'),
      issuer.subject,
      issuer,
      false,
      Math.max(timestamp - 60000, Date.parse(ca.validFrom)),
      Math.min(expiry.getTime(), Date.parse(ca.validTo)),
      Buffer.from(randomSerialHex(), 'hex')
    );
    const leaf = new X509Certificate(certPem);
    if (
      !leaf.checkPrivateKey(pair.privateKey) ||
      !leaf.checkIssued(ca) ||
      leaf.checkHost('localhost') !== 'localhost' ||
      leaf.checkHost('host.docker.internal') !== 'host.docker.internal' ||
      leaf.checkIP('127.0.0.1') !== '127.0.0.1'
    )
      invalid();
    return {
      caCertPem,
      caKeyPem,
      certPem,
      keyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      reusedCa,
    };
  } catch {
    invalid();
  }
}

module.exports = { generateCertificatePair, randomSerialHex, issuerFields };
