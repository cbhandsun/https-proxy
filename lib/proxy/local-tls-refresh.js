'use strict';

// The composition root owns the live server collection and certificate source.
// Refresh behavior belongs here so startup and management share one testable
// operation. Do not catch certificate/context errors or log TLS material.
function createLocalTlsRefresh(dependencies) {
  if (
    !dependencies ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(dependencies)) ||
    Reflect.ownKeys(dependencies).some((key) => !['servers', 'ensureCert'].includes(key))
  )
    throw new TypeError('Invalid local TLS refresh dependencies');
  const servers = Object.getOwnPropertyDescriptor(dependencies, 'servers')?.value;
  const ensureCert = Object.getOwnPropertyDescriptor(dependencies, 'ensureCert')?.value;
  if (!Array.isArray(servers) || typeof ensureCert !== 'function')
    throw new TypeError('Invalid local TLS refresh dependencies');
  return function refreshLocalTlsServers() {
    const tlsConfig = ensureCert();
    let refreshed = 0;
    for (const server of servers) {
      if (!server || typeof server.setSecureContext !== 'function') continue;
      server.setSecureContext(tlsConfig);
      refreshed += 1;
    }
    return { refreshed };
  };
}

module.exports = { createLocalTlsRefresh };
