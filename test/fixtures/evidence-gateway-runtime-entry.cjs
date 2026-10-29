'use strict';

// Exercise the exported source module as well as the separately tested bundled
// CLI. Never select this fixture from owner-facing launch configuration.
const { startEvidenceGateway } = require('../../scripts/lib/evidence-gateway-runtime');
const { bindEvidenceGatewayShutdown } = require('../../scripts/lib/evidence-gateway-shutdown');
startEvidenceGateway(process.argv.slice(2))
  .then(bindEvidenceGatewayShutdown)
  .catch(() => {
    process.stderr.write('evidence_gateway_start_failed\n');
    process.exitCode = 1;
  });
