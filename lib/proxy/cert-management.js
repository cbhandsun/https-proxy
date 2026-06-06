const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const {
  CERT_DIR,
  CA_CERT_FILE,
  CERT_FILE,
  KEY_FILE,
} = require('./cert');

function sendJson(clientRes, statusCode, payload) {
  clientRes.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*'
  });
  clientRes.end(JSON.stringify(payload));
}

function createCertManagement() {
  let lastCertCheckTime = 0;
  let cachedCertTrusted = false;
  let isCheckingCert = false;
  let pendingCertCallbacks = [];

  function invalidateCertTrustedCache() {
    lastCertCheckTime = 0;
  }

  function finishCertTrustedCheck(trusted) {
    cachedCertTrusted = Boolean(trusted);
    lastCertCheckTime = Date.now();
    isCheckingCert = false;

    const callbacks = pendingCertCallbacks;
    pendingCertCallbacks = [];
    callbacks.forEach(cb => cb(cachedCertTrusted));
  }

  function checkIfCertTrustedWithPowerShell(execFile) {
    const psCmd = "$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine'); $store.Open('ReadOnly'); $certs = $store.Certificates | Where-Object { $_.Subject -match 'HTTPS Proxy Local Root CA' }; if ($certs) { if ($certs.Count) { $certs.Count } else { 1 } } else { 0 }; $store.Close(); exit 0";

    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { encoding: 'utf8', timeout: 5000, windowsHide: true }, (err, stdout) => {
      try {
        const count = parseInt((stdout || '').trim(), 10);
        finishCertTrustedCheck(count > 0);
      } catch (e) {
        finishCertTrustedCheck(false);
      }
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

    execFile('certutil.exe', ['-store', 'Root', 'HTTPS Proxy Local Root CA'], { encoding: 'utf8', timeout: 2500, windowsHide: true }, (err) => {
      if (!err) {
        finishCertTrustedCheck(true);
        return;
      }
      if (err.code === 'ENOENT') {
        checkIfCertTrustedWithPowerShell(execFile);
        return;
      }
      if (typeof err.code === 'number' || typeof err.code === 'string') {
        finishCertTrustedCheck(false);
        return;
      }
      checkIfCertTrustedWithPowerShell(execFile);
    });
  }

  function handleLocalCertStatusRequest(clientReq, clientRes) {
    try {
      const exists = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
      checkIfCertTrusted((trusted) => {
        sendJson(clientRes, 200, { ok: true, exists, certDir: CERT_DIR, trusted });
      });
    } catch (err) {
      sendJson(clientRes, 500, { error: err.message });
    }
  }

  function handleLocalCertTrustRequest(clientReq, clientRes) {
    try {
      const absoluteCertPath = path.resolve(CA_CERT_FILE);
      const cmd = `Start-Process powershell -ArgumentList '-NoProfile -WindowStyle Hidden -Command Import-Certificate -FilePath \\"${absoluteCertPath}\\" -CertStoreLocation \\"Cert:\\\\LocalMachine\\\\Root\\"' -Verb RunAs -Wait`;

      cp.exec(`powershell -NoProfile -Command "${cmd}"`, (err) => {
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

  function handleLocalCertUntrustRequest(clientReq, clientRes) {
    try {
      const cmd = `Start-Process powershell -ArgumentList '-NoProfile -WindowStyle Hidden -Command Get-ChildItem \\"Cert:\\\\CurrentUser\\\\Root\\", \\"Cert:\\\\LocalMachine\\\\Root\\" | Where-Object Subject -like \\"*CN=HTTPS Proxy Local Root CA*\\" | Remove-Item' -Verb RunAs`;

      cp.exec(`powershell -NoProfile -Command "${cmd}"`, (err) => {
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
};
