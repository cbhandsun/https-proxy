'use strict';

const http = require('node:http');

function endpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source_config_invalid');
  }
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('source_config_invalid');
  }
  return url;
}

function fetchOriginal(url) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, timeout: 5000 },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 128 * 1024) request.destroy(new Error('source_failed'));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new Error('source_failed')));
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('source_failed'));
          const text = Buffer.concat(chunks).toString('utf8');
          if (
            !text.startsWith('Synthetic original Unicode 中文🙂\r\n') ||
            !/\r\nREQUIRED_MARKER=HPM_PRIVATE_[a-zA-Z0-9-]{16,128}$/.test(text)
          )
            return reject(new Error('source_failed'));
          resolve(text);
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('source_failed')));
    request.on('error', () => reject(new Error('source_failed')));
    request.end('{}');
  });
}

function createSourceHandler(url, read = fetchOriginal) {
  const target = endpoint(url);
  let called = false;
  return async (request) => {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      request.jsonrpc !== '2.0' ||
      !['string', 'number'].includes(typeof request.id) ||
      (typeof request.id === 'number' && !Number.isSafeInteger(request.id))
    )
      throw new Error('source_request_invalid');
    if (request.method === 'initialize')
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hpm-synthetic-source', version: '1.0.0' },
      };
    if (request.method === 'ping') return {};
    if (request.method === 'tools/list')
      return {
        tools: [
          {
            name: 'original',
            description: 'Read the fixed synthetic original once.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      };
    if (
      request.method !== 'tools/call' ||
      !request.params ||
      Object.keys(request.params).some((key) => !['name', 'arguments'].includes(key)) ||
      request.params.name !== 'original' ||
      !request.params.arguments ||
      typeof request.params.arguments !== 'object' ||
      Array.isArray(request.params.arguments) ||
      Object.keys(request.params.arguments).length !== 0 ||
      called
    )
      throw new Error('source_request_invalid');
    called = true;
    const text = await read(target);
    return { content: [{ type: 'text', text }] };
  };
}

// Enforce the byte limit before retaining each segment, including a stream that
// never sends a newline. Async iteration also bounds queued work to one request.
async function* boundedLines(input) {
  let pending = Buffer.alloc(0);
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (pending.length + segment.length > 16384) throw new Error('source_request_invalid');
      pending = Buffer.concat([pending, segment]);
      if (newline < 0) break;
      yield pending.toString('utf8').replace(/\r$/, '');
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  if (pending.length) throw new Error('source_request_invalid');
}

async function main() {
  const handle = createSourceHandler(process.env.HPM_FIXTURE_ENDPOINT);
  for await (const line of boundedLines(process.stdin)) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      throw new Error('source_request_invalid');
    }
    if (request?.method === 'notifications/initialized' && request.id === undefined) continue;
    let response;
    try {
      response = { jsonrpc: '2.0', id: request.id, result: await handle(request) };
    } catch {
      response = {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: { code: -32602, message: 'source_request_invalid' },
      };
    }
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

if (require.main === module)
  main().catch(() => {
    process.stderr.write('source_failed\n');
    process.exitCode = 1;
  });
module.exports = { createSourceHandler, endpoint, fetchOriginal, boundedLines };
