'use strict';

function attachClientDiagnostics(clientRes, prepared, target, path, body, protocol, entry) {
  const hpmDiagnostics =
    body && body.__hpmDiagnostics && typeof body.__hpmDiagnostics === 'object'
      ? body.__hpmDiagnostics
      : undefined;
  clientRes.__diagnostics = {
    protocol,
    route: prepared.model,
    target,
    upstreamPath: path,
    profile: prepared.profile && prepared.profile.id,
    ...(entry ? { entryProtocol: entry } : {}),
    hpmDiagnostics,
  };
}

function attachGeminiDiagnostics(clientRes, prepared, target, path, body, entry) {
  attachClientDiagnostics(clientRes, prepared, target, path, body, 'gemini', entry);
}

module.exports = {
  attachClientDiagnostics,
  attachGeminiDiagnostics,
};
