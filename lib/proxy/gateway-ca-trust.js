const { X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_CONTAINER = 'openclaw-gateway';
const CONTAINER_CA_PATH = '/home/node/.openclaw/certs/https-proxy-ca.pem';
const SYSTEM_CA_PATH = '/usr/local/share/ca-certificates/https-proxy-ca.crt';
const GATEWAY_ENTRYPOINT_PATH = '/home/node/.openclaw/scripts/gateway-entrypoint.sh';
const MAX_CA_BYTES = 1024 * 1024;

function validateContainerName(value) {
  const container = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) {
    throw new Error('container name has invalid format');
  }
  return container;
}

function validateCaCertificate(cert, now = Date.now()) {
  if (!cert || cert.ca !== true) {
    throw new Error('proxy CA certificate must have CA basic constraints');
  }
  if (now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo)) {
    throw new Error('proxy CA certificate is not currently valid');
  }
  if (typeof cert.fingerprint256 !== 'string' || !cert.fingerprint256) {
    throw new Error('proxy CA certificate fingerprint is unavailable');
  }
  return cert;
}

function readAndValidateCa(caPath) {
  const absolutePath = path.resolve(caPath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 200 || stat.size > MAX_CA_BYTES) {
    throw new Error(`proxy CA file has an invalid size: ${absolutePath}`);
  }
  const cert = validateCaCertificate(new X509Certificate(fs.readFileSync(absolutePath, 'utf8')));
  return { absolutePath, fingerprint256: cert.fingerprint256 };
}

function runDocker(args, spawn = spawnSync) {
  const result = spawn('docker', args, {
    encoding: 'utf8',
    shell: false,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '')
      .trim()
      .slice(-2000);
    throw new Error(`docker ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function installGatewayCa(options = {}) {
  const container = validateContainerName(options.container || DEFAULT_CONTAINER);
  const readCa = options.readCa || readAndValidateCa;
  const ca = readCa(options.caPath);
  const run = options.runDocker || runDocker;

  const inspect = run(['inspect', '-f', '{{.State.Running}}', container]);
  if (String(inspect.stdout || '').trim() !== 'true') {
    throw new Error(`container is not running: ${container}`);
  }

  run(['exec', container, 'mkdir', '-p', path.posix.dirname(CONTAINER_CA_PATH)]);
  run(['cp', ca.absolutePath, `${container}:${CONTAINER_CA_PATH}`]);
  run(['exec', container, 'cp', CONTAINER_CA_PATH, SYSTEM_CA_PATH]);
  run(['exec', container, 'update-ca-certificates']);
  run([
    'exec',
    container,
    'node',
    '-e',
    `const{X509Certificate}=require('node:crypto');const fs=require('node:fs');const c=new X509Certificate(fs.readFileSync(${JSON.stringify(CONTAINER_CA_PATH)}));if(!c.ca||c.fingerprint256!==${JSON.stringify(ca.fingerprint256)})process.exit(1)`,
  ]);

  if (options.configureNodeTrust !== false) {
    run([
      'exec',
      container,
      'node',
      '-e',
      `const fs=require('node:fs');const p=${JSON.stringify(GATEWAY_ENTRYPOINT_PATH)};const marker='# HTTPS_PROXY_USE_SYSTEM_CA';let s=fs.readFileSync(p,'utf8');if(Buffer.byteLength(s)>1048576)throw new Error('entrypoint too large');if(!s.includes('--use-system-ca')){const line='export NODE_OPTIONS="\${NODE_OPTIONS:-} --use-system-ca" '+marker+'\\n';s=s.startsWith('#!')?s.replace(/^(#![^\\n]*\\n)/,'$1'+line):line+s;const t=p+'.tmp-'+process.pid;fs.writeFileSync(t,s,{mode:fs.statSync(p).mode});fs.renameSync(t,p)}`,
    ]);
  }

  if (options.restart !== false) {
    run(['restart', container]);
  }

  if (options.verifyNodeTls !== false) {
    const port = Number(options.verifyPort || 3445);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('verify port must be an integer between 1 and 65535');
    }
    run([
      'exec',
      container,
      'node',
      '--use-system-ca',
      '-e',
      `const tls=require('node:tls');const s=tls.connect({host:'host.docker.internal',port:${port},servername:'host.docker.internal',rejectUnauthorized:true},()=>{if(!s.authorized)process.exit(1);s.end()});s.setTimeout(5000,()=>s.destroy(new Error('TLS verification timed out')));s.on('error',e=>{process.stderr.write(String(e.code||e.message));process.exit(1)})`,
    ]);
  }

  return { caPath: ca.absolutePath, container, containerCaPath: CONTAINER_CA_PATH };
}

module.exports = {
  CONTAINER_CA_PATH,
  DEFAULT_CONTAINER,
  GATEWAY_ENTRYPOINT_PATH,
  SYSTEM_CA_PATH,
  installGatewayCa,
  readAndValidateCa,
  runDocker,
  validateCaCertificate,
  validateContainerName,
};
