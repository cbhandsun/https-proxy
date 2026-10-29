'use strict';

const { callable, settle } = require('./context-recovery-daemon-http-boundary');
const fail = () => new Error('installed_client_matrix_failed');

async function writeInstalledBusinessReply(active, current, response, reply) {
  try {
    if (current.beforeReply !== undefined) {
      if (
        !callable(current.beforeReply) ||
        (await settle(current.beforeReply(reply), 'installed_client_matrix_failed')).value !==
          true ||
        active.current !== current ||
        response.destroyed
      )
        throw fail();
    }
    const partial = reply.stream === true && current.afterPrefix !== undefined;
    if (
      partial &&
      (!callable(current.afterPrefix) ||
        !Number.isSafeInteger(current.prefixBytes) ||
        current.prefixBytes < 1 ||
        current.prefixBytes >= reply.wire.length)
    )
      throw fail();
    response.writeHead(200, { 'content-type': reply.contentType, connection: 'close' });
    if (partial) {
      response.write(reply.wire.subarray(0, current.prefixBytes));
      if (
        (await settle(current.afterPrefix(), 'installed_client_matrix_failed')).value !== true ||
        active.current !== current ||
        response.destroyed
      )
        throw fail();
      response.end(reply.wire.subarray(current.prefixBytes));
    } else response.end(reply.wire);
  } catch {
    throw fail();
  }
}

module.exports = { writeInstalledBusinessReply };
