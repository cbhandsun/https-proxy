'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const { DEFAULT_MAX_PORT, DEFAULT_MIN_PORT, findAvailablePorts } = require('./helpers/test-ports');

async function listen(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return server;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const ports = await findAvailablePorts(3);
  assert.equal(new Set(ports).size, 3);
  assert.ok(ports.every((port) => port >= DEFAULT_MIN_PORT && port <= DEFAULT_MAX_PORT));

  const [occupiedPort] = await findAvailablePorts(1);
  const blocker = await listen(occupiedPort);
  try {
    await assert.rejects(
      findAvailablePorts(1, {
        minPort: occupiedPort,
        maxPort: occupiedPort,
        maxAttempts: 1,
      }),
      /Unable to find 1 available ports/
    );
  } finally {
    await close(blocker);
  }

  await assert.rejects(findAvailablePorts(0), /count must be an integer/);
  await assert.rejects(
    findAvailablePorts(2, { minPort: 15000, maxPort: 15000 }),
    /port range must contain/
  );

  console.log('test port allocation regression tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
