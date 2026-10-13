'use strict';

const { parseEvidenceGatewayArguments } = require('./lib/evidence-gateway-config');
const { bindEvidenceGatewayShutdown } = require('./lib/evidence-gateway-shutdown');

if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const args = process.argv.slice(2);
      parseEvidenceGatewayArguments(args);
      return require('./lib/evidence-gateway-runtime').startEvidenceGateway(args);
    })
    .then((runtime) => bindEvidenceGatewayShutdown(runtime))
    .catch(() => {
      process.stderr.write('evidence_gateway_start_failed\n');
      process.exitCode = 1;
    });
}
