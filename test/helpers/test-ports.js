'use strict';

const net = require('node:net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MIN_PORT = 12000;
const DEFAULT_MAX_PORT = 30000;
const DEFAULT_MAX_ATTEMPTS = 100;
const RETRYABLE_LISTEN_ERRORS = new Set(['EACCES', 'EADDRINUSE']);

function validateInteger(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

function randomPort(minPort, maxPort) {
  return minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
}

function probePort(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

async function findAvailablePorts(
  count,
  {
    host = DEFAULT_HOST,
    minPort = DEFAULT_MIN_PORT,
    maxPort = DEFAULT_MAX_PORT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  } = {}
) {
  validateInteger('count', count, 1, 100);
  validateInteger('minPort', minPort, 1024, 65535);
  validateInteger('maxPort', maxPort, minPort, 65535);
  validateInteger('maxAttempts', maxAttempts, count, 10000);

  if (typeof host !== 'string' || host.trim() === '' || host.includes('\0')) {
    throw new TypeError('host must be a non-empty string without null bytes');
  }
  if (maxPort - minPort + 1 < count) {
    throw new RangeError('port range must contain at least count unique ports');
  }

  const ports = new Set();
  let lastError;
  for (let attempt = 0; attempt < maxAttempts && ports.size < count; attempt += 1) {
    const port = randomPort(minPort, maxPort);
    if (ports.has(port)) continue;
    try {
      await probePort(port, host);
      ports.add(port);
    } catch (error) {
      if (!RETRYABLE_LISTEN_ERRORS.has(error?.code)) throw error;
      lastError = error;
    }
  }

  if (ports.size !== count) {
    const error = new Error(
      `Unable to find ${count} available ports in ${minPort}-${maxPort} after ${maxAttempts} attempts`
    );
    if (lastError) error.cause = lastError;
    throw error;
  }
  return [...ports];
}

module.exports = {
  DEFAULT_MAX_PORT,
  DEFAULT_MIN_PORT,
  findAvailablePorts,
};
