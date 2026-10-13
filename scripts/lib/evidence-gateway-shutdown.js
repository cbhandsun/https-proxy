'use strict';

// Local process lifecycle only. Shutdown never retries a tool, reopens evidence,
// prints an exception, or changes the owner's client/provider configuration.
function bindEvidenceGatewayShutdown(runtime, host = process) {
  let completion = null;
  function dispose() {
    host.removeListener('SIGINT', stop);
    host.removeListener('SIGTERM', stop);
  }
  function stop() {
    if (completion) return completion;
    dispose();
    completion = Promise.resolve()
      .then(() => runtime.close())
      .catch(() => {
        host.stderr.write('evidence_gateway_close_failed\n');
        host.exitCode = 1;
      });
    return completion;
  }
  host.on('SIGINT', stop);
  host.on('SIGTERM', stop);
  return { dispose, stop };
}

module.exports = { bindEvidenceGatewayShutdown };
