const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const {
  CERT_DIR,
  CA_CERT_FILE,
  CA_COMMON_NAME,
  getCaCommonName,
  CERT_FILE,
  KEY_FILE,
} = require('./cert');

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  clientRes.end(JSON.stringify(payload));
}

function quotePowerShell(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

function encodePowerShellCommand(command) {
  return Buffer.from(String(command || ''), 'utf16le').toString('base64');
}

function runElevatedPowerShell(command, callback) {
  cp.execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShellCommand(command),
    ],
    { windowsHide: true },
    callback
  );
}

function runCertutil(args, callback) {
  cp.execFile('certutil.exe', args, { timeout: 5000, windowsHide: true }, callback);
}

function runPowerShell(args, callback) {
  cp.execFile(
    'powershell.exe',
    args,
    { encoding: 'utf8', timeout: 8000, windowsHide: true },
    callback
  );
}

function launchCertificateImportWizard(certPath) {
  const child = cp.spawn('rundll32.exe', ['cryptext.dll,CryptExtAddCER', certPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function buildManualTrustPendingPayload(error) {
  return {
    ok: false,
    pending: true,
    manualTrustRequired: true,
    output:
      'Windows 需要用户确认根证书信任。已打开系统证书导入向导，请选择“当前用户”并导入到“受信任的根证书颁发机构”，完成后刷新证书状态。',
    error: error && error.message ? error.message : String(error || ''),
  };
}

function normalizeThumbprint(value) {
  return String(value || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
}

function parsePowerShellJsonArray(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function certificateThumbprint(certPath = CA_CERT_FILE) {
  const cert = new X509Certificate(fs.readFileSync(certPath, 'utf8'));
  return normalizeThumbprint(cert.fingerprint);
}

function buildRootStoreThumbprintQuery(thumbprint) {
  const normalized = normalizeThumbprint(thumbprint);
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$thumbprint = ${quotePowerShell(normalized)}`,
    '$stores = @("Cert:\\CurrentUser\\Root", "Cert:\\LocalMachine\\Root")',
    '$result = foreach ($store in $stores) {',
    '  Get-ChildItem -Path $store | Where-Object {',
    '    ($_.Thumbprint -replace "[^0-9A-Fa-f]", "").ToUpperInvariant() -eq $thumbprint',
    '  } | ForEach-Object {',
    '    [pscustomobject]@{ Store = $store; Thumbprint = $_.Thumbprint; Subject = $_.Subject }',
    '  }',
    '}',
    '@($result) | ConvertTo-Json -Compress',
  ].join('\r\n');
}

function buildProxyCaThumbprintsQuery() {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$stores = @("Cert:\\CurrentUser\\Root", "Cert:\\LocalMachine\\Root")',
    '$result = foreach ($store in $stores) {',
    '  Get-ChildItem -Path $store | Where-Object {',
    '    $_.Subject -like "*CN=HTTPS Proxy Local Root CA*"',
    '  } | ForEach-Object {',
    '    [pscustomobject]@{ Store = $store; Thumbprint = $_.Thumbprint; Subject = $_.Subject }',
    '  }',
    '}',
    '@($result) | ConvertTo-Json -Compress',
  ].join('\r\n');
}

function thumbprintsFromStoreEntries(entries) {
  return Array.from(
    new Set(
      (Array.isArray(entries) ? entries : [])
        .map((entry) => normalizeThumbprint(entry && entry.Thumbprint))
        .filter(Boolean)
    )
  );
}

function queryThumbprintInRootStores(thumbprint, execFile, callback) {
  const normalized = normalizeThumbprint(thumbprint);
  if (!normalized) {
    callback(null, false);
    return;
  }

  execFile(
    'certutil.exe',
    ['-user', '-store', 'Root', normalized],
    { encoding: 'utf8', timeout: 5000, windowsHide: true },
    (userErr) => {
      if (!userErr) {
        callback(null, true);
        return;
      }

      execFile(
        'certutil.exe',
        ['-store', 'Root', normalized],
        { encoding: 'utf8', timeout: 5000, windowsHide: true },
        (machineErr) => {
          callback(null, !machineErr);
        }
      );
    }
  );
}

function queryCurrentCaTrusted(execFile, callback) {
  let thumbprint;
  try {
    thumbprint = certificateThumbprint(CA_CERT_FILE);
  } catch (err) {
    callback(err);
    return;
  }
  queryThumbprintInRootStores(thumbprint, execFile, callback);
}

function waitForThumbprintInRootStores(thumbprint, options, callback) {
  const execFile = options && options.execFile ? options.execFile : cp.execFile;
  const rawAttempts = Number(options && options.attempts);
  const rawDelayMs = Number(options && options.delayMs);
  const attempts = Math.max(1, Math.min(20, Number.isFinite(rawAttempts) ? rawAttempts : 8));
  const delayMs = Math.max(0, Math.min(2000, Number.isFinite(rawDelayMs) ? rawDelayMs : 250));
  let remaining = attempts;
  let lastError = null;

  const check = () => {
    queryThumbprintInRootStores(thumbprint, execFile, (err, trusted) => {
      if (!err && trusted) {
        callback(null, true);
        return;
      }
      if (err) lastError = err;
      remaining -= 1;
      if (remaining <= 0) {
        callback(lastError, false);
        return;
      }
      setTimeout(check, delayMs);
    });
  };

  check();
}

function waitForCurrentCaTrusted(options, callback) {
  let thumbprint;
  try {
    thumbprint = certificateThumbprint(CA_CERT_FILE);
  } catch (err) {
    callback(err, false);
    return;
  }
  waitForThumbprintInRootStores(thumbprint, options, callback);
}

function buildCertStatusPayload(exists, trusted, extra = {}) {
  const caThumbprint = fs.existsSync(CA_CERT_FILE) ? certificateThumbprint(CA_CERT_FILE) : '';
  return {
    ok: true,
    exists,
    certDir: CERT_DIR,
    caCertFile: CA_CERT_FILE,
    caCommonName: typeof getCaCommonName === 'function' ? getCaCommonName() : CA_COMMON_NAME,
    caThumbprint,
    trusted: Boolean(trusted),
    nodeExtraCaCertsEnv: caThumbprint ? `NODE_EXTRA_CA_CERTS=${CA_CERT_FILE}` : '',
    ...extra,
  };
}

function windowsChainVerify(callback) {
  if (os.platform() !== 'win32' || !fs.existsSync(CERT_FILE)) {
    callback(null, { verified: os.platform() !== 'win32', output: '' });
    return;
  }
  cp.execFile(
    'certutil.exe',
    ['-user', '-verify', CERT_FILE],
    { encoding: 'utf8', timeout: 8000, windowsHide: true },
    (err, stdout, stderr) => {
      callback(null, {
        verified: !err,
        output: `${stdout || ''}${stderr || ''}`.slice(-2000),
        error: err ? err.message : '',
      });
    }
  );
}

function probeServedTlsCertificate(port, callback) {
  if (!fs.existsSync(CA_CERT_FILE)) {
    callback(null, {
      checked: false,
      verified: false,
      port,
      error: 'CA certificate file is missing',
    });
    return;
  }

  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    callback(null, result);
  };
  const socket = tls.connect(
    {
      host: 'localhost',
      port,
      servername: 'localhost',
      ca: fs.readFileSync(CA_CERT_FILE),
      rejectUnauthorized: true,
    },
    () => {
      const cert = socket.getPeerCertificate(true);
      finish({
        checked: true,
        verified: socket.authorized,
        port,
        authorizationError: socket.authorizationError || '',
        subject: cert && cert.subject ? cert.subject.CN || '' : '',
        issuer: cert && cert.issuer ? cert.issuer.CN || '' : '',
        fingerprint: cert && cert.fingerprint ? normalizeThumbprint(cert.fingerprint) : '',
      });
      socket.end();
    }
  );
  socket.setTimeout(2500, () => {
    socket.destroy();
    finish({ checked: true, verified: false, port, error: 'TLS probe timed out' });
  });
  socket.on('error', (err) => {
    finish({
      checked: true,
      verified: false,
      port,
      error: err && err.message ? err.message : String(err || ''),
      code: err && err.code ? err.code : '',
    });
  });
}

function listProxyCaThumbprints(callback) {
  if (os.platform() !== 'win32') {
    callback(null, []);
    return;
  }

  runPowerShell(
    ['-NoProfile', '-EncodedCommand', encodePowerShellCommand(buildProxyCaThumbprintsQuery())],
    (err, stdout) => {
      if (err) {
        callback(err);
        return;
      }
      try {
        callback(null, thumbprintsFromStoreEntries(parsePowerShellJsonArray(stdout)));
      } catch (parseErr) {
        callback(parseErr);
      }
    }
  );
}

function removeCurrentUserProxyCas(callback) {
  listProxyCaThumbprints((listErr, thumbprints) => {
    if (listErr) {
      callback(listErr);
      return;
    }
    let index = 0;
    const next = () => {
      if (index >= thumbprints.length) {
        callback(null);
        return;
      }
      const thumbprint = thumbprints[index++];
      runCertutil(['-user', '-delstore', 'Root', thumbprint], () => next());
    };
    next();
  });
}

function staleProxyCaThumbprints(callback) {
  let currentThumbprint = '';
  try {
    currentThumbprint = certificateThumbprint(CA_CERT_FILE);
  } catch (err) {
    callback(err);
    return;
  }
  listProxyCaThumbprints((listErr, thumbprints) => {
    if (listErr) {
      callback(listErr);
      return;
    }
    callback(
      null,
      thumbprints.filter((thumbprint) => thumbprint && thumbprint !== currentThumbprint)
    );
  });
}

function removeStaleCurrentUserProxyCas(callback) {
  staleProxyCaThumbprints((listErr, thumbprints) => {
    if (listErr) {
      callback(listErr);
      return;
    }
    let index = 0;
    const next = () => {
      if (index >= thumbprints.length) {
        callback(null, { removed: thumbprints });
        return;
      }
      const thumbprint = thumbprints[index++];
      runCertutil(['-user', '-delstore', 'Root', thumbprint], () => next());
    };
    next();
  });
}

function refreshTlsServers(options = {}) {
  if (typeof options.refreshTlsServers !== 'function') return { refreshed: 0 };
  return options.refreshTlsServers() || { refreshed: 0 };
}

function createCertManagement(options = {}) {
  let lastCertCheckTime = 0;
  let cachedCertTrusted = false;
  let isCheckingCert = false;
  let pendingCertCallbacks = [];
  let certCheckGeneration = 0;

  function invalidateCertTrustedCache() {
    certCheckGeneration += 1;
    lastCertCheckTime = 0;
    isCheckingCert = false;
    const callbacks = pendingCertCallbacks;
    pendingCertCallbacks = [];
    callbacks.forEach((cb) => cb(false));
  }

  function finishCertTrustedCheck(trusted, generation) {
    if (generation !== certCheckGeneration) return;
    cachedCertTrusted = Boolean(trusted);
    lastCertCheckTime = Date.now();
    isCheckingCert = false;

    const callbacks = pendingCertCallbacks;
    pendingCertCallbacks = [];
    callbacks.forEach((cb) => cb(cachedCertTrusted));
  }

  function checkIfCertTrustedWithPowerShell(execFile, generation) {
    queryCurrentCaTrusted(execFile, (err, trusted) => {
      finishCertTrustedCheck(!err && trusted, generation);
    });
  }

  function checkIfCertTrusted(callback) {
    if (os.platform() !== 'win32') {
      if (callback) callback(true);
      return;
    }

    const now = Date.now();
    if (now - lastCertCheckTime < 15000) {
      if (callback) callback(cachedCertTrusted);
      return;
    }

    if (callback) pendingCertCallbacks.push(callback);

    if (isCheckingCert) {
      return;
    }

    isCheckingCert = true;
    const { execFile } = require('child_process');
    const generation = certCheckGeneration;

    checkIfCertTrustedWithPowerShell(execFile, generation);
  }

  function handleLocalCertStatusRequest(clientReq, clientRes) {
    try {
      const exists = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
      checkIfCertTrusted((trusted) => {
        windowsChainVerify((verifyErr, chain) => {
          staleProxyCaThumbprints((staleErr, staleThumbprints = []) => {
            const entries =
              typeof options.getEntryServersSnapshot === 'function'
                ? options.getEntryServersSnapshot()
                : [];
            const httpsEntry = Array.isArray(entries)
              ? entries.find((entry) => entry && entry.enabled !== false && entry.tls !== false)
              : null;
            const tlsPort = Number((httpsEntry && httpsEntry.listenPort) || 3443);
            probeServedTlsCertificate(tlsPort, (probeErr, servedTls) => {
              const sendStatus = (finalServedTls, tlsRefresh = { refreshed: 0 }) => {
                const servedTlsVerified =
                  finalServedTls && finalServedTls.checked
                    ? finalServedTls.verified === true
                    : true;
                const hasStaleCas = staleThumbprints.length > 0;
                sendJson(
                  clientRes,
                  200,
                  buildCertStatusPayload(
                    exists,
                    trusted && (!chain || chain.verified) && servedTlsVerified,
                    {
                      caTrusted: trusted,
                      staleCaThumbprints: staleThumbprints,
                      staleCaWarning: hasStaleCas,
                      staleCaError: staleErr ? staleErr.message || String(staleErr) : '',
                      windowsChainVerified: chain ? chain.verified : trusted,
                      windowsChainError:
                        chain && !chain.verified ? chain.error || chain.output : '',
                      servedTls: finalServedTls,
                      tlsRefreshed: Number(tlsRefresh.refreshed) || 0,
                      tlsRefreshError: tlsRefresh.error || '',
                    }
                  )
                );
              };

              if (
                trusted &&
                servedTls &&
                servedTls.checked &&
                servedTls.verified !== true &&
                servedTls.code === 'CERT_SIGNATURE_FAILURE'
              ) {
                let tlsRefresh = { refreshed: 0 };
                try {
                  tlsRefresh = refreshTlsServers(options);
                } catch (refreshErr) {
                  tlsRefresh = { refreshed: 0, error: refreshErr.message || String(refreshErr) };
                }
                probeServedTlsCertificate(tlsPort, (retryProbeErr, retryServedTls) => {
                  sendStatus(retryServedTls, tlsRefresh);
                });
                return;
              }

              sendStatus(servedTls);
            });
          });
        });
      });
    } catch (err) {
      sendJson(clientRes, 500, { ok: false, error: err.message, certDir: CERT_DIR });
    }
  }

  function handleLocalCertTrustRequest(clientReq, clientRes) {
    try {
      const absoluteCertPath = path.resolve(CA_CERT_FILE);
      removeStaleCurrentUserProxyCas((cleanupErr, cleanup = {}) => {
        runCertutil(['-user', '-addstore', 'Root', absoluteCertPath], (err) => {
          invalidateCertTrustedCache();
          if (err) {
            try {
              launchCertificateImportWizard(absoluteCertPath);
              sendJson(clientRes, 202, {
                ...buildManualTrustPendingPayload(err),
                staleCaCleanupError: cleanupErr ? cleanupErr.message || String(cleanupErr) : '',
                staleCaRemoved: cleanup.removed || [],
              });
            } catch (launchErr) {
              sendJson(clientRes, 500, {
                ok: false,
                manualTrustRequired: true,
                error: launchErr.message || err.message,
                certFile: absoluteCertPath,
                staleCaCleanupError: cleanupErr ? cleanupErr.message || String(cleanupErr) : '',
                staleCaRemoved: cleanup.removed || [],
              });
            }
          } else {
            let tlsRefresh = { refreshed: 0 };
            try {
              tlsRefresh = refreshTlsServers(options);
            } catch (refreshErr) {
              tlsRefresh = { refreshed: 0, error: refreshErr.message || String(refreshErr) };
            }
            waitForCurrentCaTrusted({ execFile: cp.execFile }, (verifyErr, trusted) => {
              cachedCertTrusted = Boolean(trusted);
              lastCertCheckTime = Date.now();
              sendJson(clientRes, trusted ? 200 : 202, {
                ok: Boolean(trusted),
                pending: !trusted,
                trusted: Boolean(trusted),
                output: trusted
                  ? '证书已安装并通过当前用户/系统根证书库校验。'
                  : '证书安装命令已完成，但尚未通过根证书库校验；请稍后刷新状态，或使用系统证书导入向导手动确认信任。',
                error: verifyErr ? verifyErr.message || String(verifyErr) : '',
                tlsRefreshed: Number(tlsRefresh.refreshed) || 0,
                tlsRefreshError: tlsRefresh.error || '',
                staleCaCleanupError: cleanupErr ? cleanupErr.message || String(cleanupErr) : '',
                staleCaRemoved: cleanup.removed || [],
              });
            });
          }
        });
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalCertUntrustRequest(clientReq, clientRes) {
    try {
      const removeCommand =
        "Get-ChildItem 'Cert:\\\\CurrentUser\\\\Root', 'Cert:\\\\LocalMachine\\\\Root' | " +
        "Where-Object Subject -like '*CN=HTTPS Proxy Local Root CA*' | Remove-Item";
      const cmd =
        'Start-Process powershell.exe -ArgumentList ' +
        quotePowerShell('-NoProfile -WindowStyle Hidden -Command ' + removeCommand) +
        ' -Verb RunAs';

      runElevatedPowerShell(cmd, (err) => {
        invalidateCertTrustedCache();
        if (err) {
          sendJson(clientRes, 500, { ok: false, error: err.message });
        } else {
          sendJson(clientRes, 200, { ok: true });
        }
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  return {
    checkIfCertTrusted,
    invalidateCertTrustedCache,
    handleLocalCertStatusRequest,
    handleLocalCertTrustRequest,
    handleLocalCertUntrustRequest,
  };
}

module.exports = {
  createCertManagement,
  _test: {
    encodePowerShellCommand,
    certificateThumbprint,
    normalizeThumbprint,
    parsePowerShellJsonArray,
    buildRootStoreThumbprintQuery,
    buildProxyCaThumbprintsQuery,
    thumbprintsFromStoreEntries,
    queryThumbprintInRootStores,
    waitForThumbprintInRootStores,
    listProxyCaThumbprints,
    removeCurrentUserProxyCas,
    removeStaleCurrentUserProxyCas,
    staleProxyCaThumbprints,
    quotePowerShell,
    buildManualTrustPendingPayload,
  },
};
