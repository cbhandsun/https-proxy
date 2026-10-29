'use strict';

const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { exact } = require('./boundary.js');
const { checkHostedListener } = require('./hosted-listener.js');
const verified = new WeakSet();
const fail = () => new Error('n08_hosted_probe_rejected');

// Refused/unreachable connections do not establish firewall enforcement.
function isBlockedSocketError(error) {
  if (error === null || typeof error !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return (
    !!descriptor &&
    Object.hasOwn(descriptor, 'value') &&
    (descriptor.value === 'EACCES' || descriptor.value === 'EPERM')
  );
}

// Run only in an owned payload-Node child held behind stdin until its original
// HpmRuntimeBoundaryJob assignment succeeds. No arbitrary URL or HTTP proxy.
async function runHostedProbes(input, listenerLease, onPhase = () => {}) {
  try {
    if (typeof onPhase !== 'function') throw fail();
    // Fixed internal phase protocol only; no input, errors or native replies.
    onPhase(86);
    const options = exact(input, [
      'ownedNode',
      'networkRoot',
      'caSha256',
      'leafSha256',
      'negativeAddress',
      'negativePort',
    ]);
    if (
      process.platform !== 'win32' ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.NODE_OPTIONS ||
      process.env.NODE_PATH ||
      !path.isAbsolute(options.networkRoot) ||
      fs.realpathSync.native(process.execPath).toLowerCase() !==
        fs.realpathSync.native(options.ownedNode).toLowerCase() ||
      !net.isIPv4(options.negativeAddress) ||
      !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(options.negativeAddress) ||
      !Number.isInteger(options.negativePort) ||
      options.negativePort < 1024 ||
      options.negativePort > 65535 ||
      !/^[a-f0-9]{64}$/.test(options.caSha256) ||
      !/^[a-f0-9]{64}$/.test(options.leafSha256)
    )
      throw fail();
    onPhase(87);
    const listener = checkHostedListener(listenerLease, options.ownedNode, options.networkRoot);
    if (
      listener.pid !== process.pid ||
      listener.negativeAddress !== options.negativeAddress ||
      listener.negativePort !== options.negativePort ||
      listener.negativeConnections !== 0
    )
      throw fail();
    onPhase(88);
    const ca = fs.readFileSync(path.join(options.networkRoot, 'ca.pem'));
    if (
      ca.length > 16384 ||
      crypto.createHash('sha256').update(ca).digest('hex') !== options.caSha256
    )
      throw fail();
    onPhase(89);
    const addresses = await dns.lookup('api.openai.com', { all: true });
    if (addresses.length !== 1 || addresses[0].family !== 4 || addresses[0].address !== '127.0.0.1')
      throw fail();
    onPhase(90);
    await new Promise((resolve, reject) => {
      let complete = false;
      const done = (ok) => {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        ok ? resolve() : reject(fail());
      };
      const request = https.request(
        {
          hostname: 'api.openai.com',
          port: 443,
          path: '/__n08_probe',
          method: 'GET',
          agent: false,
          ca,
          rejectUnauthorized: true,
          servername: 'api.openai.com',
          headers: { connection: 'close' },
        },
        (response) => {
          const socket = response.socket;
          const peer = socket.getPeerCertificate();
          if (
            response.statusCode !== 200 ||
            socket.remoteAddress !== '127.0.0.1' ||
            socket.authorized !== true ||
            typeof peer.fingerprint256 !== 'string' ||
            peer.fingerprint256.replaceAll(':', '').toLowerCase() !== options.leafSha256
          ) {
            response.destroy();
            done(false);
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > 64) {
              response.destroy();
              done(false);
            } else chunks.push(chunk);
          });
          response.on('end', () =>
            done(Buffer.concat(chunks).equals(Buffer.from('N08_SYNTHETIC_TLS_OK')))
          );
          response.on('error', () => done(false));
          response.on('aborted', () => done(false));
        }
      );
      const timer = setTimeout(() => {
        request.destroy();
        done(false);
      }, 2000);
      request.on('error', () => done(false));
      request.end();
    });
    // Establish that the controlled non-loopback listener is actually reachable
    // from an unblocked fixed OS verifier before interpreting the Node failure.
    // This child inherits the enclosing original Job; no remote destination or
    // caller-provided script is available, and it carries no fixture credentials.
    onPhase(91);
    const baselineScript = `$ErrorActionPreference='Stop';$c=[Net.Sockets.TcpClient]::new();try{$c.Connect('${options.negativeAddress}',${options.negativePort});[Console]::Out.Write('1')}finally{$c.Dispose()}`;
    const baselineEnvironment = {};
    for (const name of ['SystemRoot', 'WINDIR'])
      if (process.env[name]) baselineEnvironment[name] = process.env[name];
    await new Promise((resolve, reject) => {
      execFile(
        'C:/Program Files/PowerShell/7/pwsh.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', baselineScript],
        {
          windowsHide: true,
          timeout: 2000,
          maxBuffer: 64,
          encoding: 'utf8',
          env: baselineEnvironment,
        },
        (error, stdout, stderr) => {
          if (error || stdout !== '1' || stderr !== '') reject(fail());
          else resolve();
        }
      );
    });
    onPhase(92);
    await new Promise((resolve) => setImmediate(resolve));
    if (
      checkHostedListener(listenerLease, options.ownedNode, options.networkRoot)
        .negativeConnections !== 1
    )
      throw fail();
    // Target is a controlled listener on this hosted VM's own non-loopback RFC1918
    // address, not an Internet endpoint. A connect proves the rule ineffective.
    onPhase(93);
    const blocked = await new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      };
      const socket = net.connect({ host: options.negativeAddress, port: options.negativePort });
      const timer = setTimeout(() => finish(true), 1000);
      socket.once('connect', () => {
        onPhase(95); // A successful connect proves containment ineffective.
        finish(false);
      });
      socket.once('error', (error) => {
        const denied = isBlockedSocketError(error);
        if (!denied) onPhase(96); // Never disclose native error data.
        finish(denied);
      });
    });
    if (!blocked) throw fail();
    onPhase(94);
    if (
      checkHostedListener(listenerLease, options.ownedNode, options.networkRoot)
        .negativeConnections !== 1
    )
      throw fail();
    const proof = Object.freeze({
      probesPassed: true,
      tlsVerified: true,
      nonLoopbackBlocked: true,
      listenerOwned: true,
    });
    verified.add(proof);
    return proof;
  } catch {
    throw fail();
  }
}

module.exports = {
  runHostedProbes,
  isVerifiedNetworkProof: (value) => verified.has(value),
  isBlockedSocketError,
};
