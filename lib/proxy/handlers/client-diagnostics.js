'use strict';

function attachClientDiagnostics(clientRes, prepared, target, path, body, protocol, entry) {
  const bodyDiagnostics =
    body && body.__hpmDiagnostics && typeof body.__hpmDiagnostics === 'object'
      ? body.__hpmDiagnostics
      : undefined;
  const providerContext =
    prepared?.contextManagement && typeof prepared.contextManagement === 'object'
      ? {
          provider: String(prepared.contextManagement.provider || 'unknown'),
          applied: prepared.contextManagement.applied === true,
          explicit: prepared.contextManagement.explicit === true,
          reason: String(prepared.contextManagement.reason || 'unknown'),
        }
      : undefined;
  const hpmDiagnostics = providerContext
    ? { ...(bodyDiagnostics || {}), providerContext }
    : bodyDiagnostics;
  const previous =
    clientRes && clientRes.__diagnostics && typeof clientRes.__diagnostics === 'object'
      ? clientRes.__diagnostics
      : {};
  clientRes.__diagnostics = {
    ...previous,
    protocol,
    route: prepared.model,
    target,
    upstreamPath: path,
    profile: prepared.profile && prepared.profile.id,
    ...(entry ? { entryProtocol: entry } : {}),
    hpmDiagnostics: hpmDiagnostics || previous.hpmDiagnostics,
  };
}

function attachPreparedDiagnostics(clientRes, prepared, upstreamPath, body, options = {}) {
  if (!clientRes || !prepared) return;
  const profile = prepared.profile || {};
  const protocol = options.protocol || profile.protocol || 'openai';
  const target =
    options.target ||
    (prepared.rewriteTo && prepared.rewriteTo !== '-' ? prepared.rewriteTo : prepared.model);
  attachClientDiagnostics(
    clientRes,
    prepared,
    target,
    upstreamPath,
    body,
    protocol,
    options.entryProtocol
  );
  if (!clientRes.__diagnostics.hpmDiagnostics && options.missingReason) {
    clientRes.__diagnostics.contextDiagnosticsMissingReason = String(options.missingReason);
  }
}

function updateClientDiagnostics(clientRes, fields = {}) {
  if (!clientRes) return;
  const previous =
    clientRes.__diagnostics && typeof clientRes.__diagnostics === 'object'
      ? clientRes.__diagnostics
      : {};
  clientRes.__diagnostics = {
    ...previous,
    ...fields,
    hpmDiagnostics:
      fields.hpmDiagnostics && typeof fields.hpmDiagnostics === 'object'
        ? fields.hpmDiagnostics
        : previous.hpmDiagnostics,
  };
}

function attachGeminiDiagnostics(clientRes, prepared, target, path, body, entry) {
  attachClientDiagnostics(clientRes, prepared, target, path, body, 'gemini', entry);
}

module.exports = {
  attachClientDiagnostics,
  attachPreparedDiagnostics,
  updateClientDiagnostics,
  attachGeminiDiagnostics,
};
