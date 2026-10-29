'use strict';

const path = require('node:path');
const { parseEvidenceGatewayArguments } = require('./lib/evidence-gateway-config');
const { bindEvidenceGatewayShutdown } = require('./lib/evidence-gateway-shutdown');
const { readPackagedEvidenceGateway } = require('./lib/evidence-gateway-release-artifact');

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const args = process.argv.slice(2);
      parseEvidenceGatewayArguments(args);
      const artifact = readPackagedEvidenceGateway(path.resolve(__dirname, '..'));
      return require(artifact.file).startEvidenceGateway(args);
    })
    .then(bindEvidenceGatewayShutdown)
    .catch(() => {
      process.stderr.write('evidence_gateway_start_failed\n');
      process.exitCode = 1;
    });
}
