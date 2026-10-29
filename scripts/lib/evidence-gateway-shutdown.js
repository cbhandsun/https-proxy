'use strict';

// Local process lifecycle only. Shutdown never retries a tool, reopens evidence,
// prints an exception, or changes the owner's client/provider configuration.
function bindEvidenceGatewayShutdown(runtime, host = process) {
  let completion = null;
  function dispose() {
    host.removeListener('SIGINT', stop);
    host.removeListener('SIGTERM', stop);
    host.stdin?.removeListener('end', stop);
    host.stdin?.removeListener('close', stop);
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
  // The SDK stdio server listens for data/errors, but does not close on EOF.
  // Retaining its downstream child would keep an abandoned gateway alive.
  host.stdin?.on('end', stop);
  host.stdin?.on('close', stop);
  if (host.stdin?.readableEnded || host.stdin?.destroyed) stop();
  return { dispose, stop };
}

module.exports = { bindEvidenceGatewayShutdown };
