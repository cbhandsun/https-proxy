'use strict';

// Counts execution at the HTTP boundary, independently of provider and TCP
// keep-alive state. No request, socket, credential or content is retained.
function createInboundActivity() {
  let http = 0;
  let upgrades = 0;
  function begin(kind) {
    if (kind === 'http') http++;
    else upgrades++;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (kind === 'http') http--;
      else upgrades--;
    };
  }
  return Object.freeze({
    beginHttp: () => begin('http'),
    beginUpgrade: () => begin('upgrade'),
    snapshot: () =>
      Object.freeze({
        activeHttpRequests: http,
        activeUpgradeConnections: upgrades,
        idle: http === 0 && upgrades === 0,
      }),
  });
}

const inboundActivity = createInboundActivity();
module.exports = { createInboundActivity, inboundActivity };
