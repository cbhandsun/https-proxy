'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const {
  BRIDGE_TOOL,
  RESULT_READERS,
  tianxiResultReaderName,
} = require('./tianxi-tool-result-continuation');
const { REFERENCE_PATTERN } = require('./tianxi-tool-result-cache');
const { formatTianxiToolResult, TIANXI_RESULT_TOOLS } = require('./tianxi-progress-presentation');
const {
  parseTianxiResultDetails,
  formatTianxiResultDetails,
} = require('./tianxi-tool-result-details');

const STATUSES = new Set(['in_progress', 'completed', 'failed', 'canceled', 'incomplete']);
const TOOLS = new Set(TIANXI_RESULT_TOOLS);
const { AbortSignal } = globalThis;

function resultEndpoint(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1'
  ) {
    throw new Error('Invalid local result endpoint');
  }
  return url.href.replace(/\/$/, '') + '/responses';
}

function readResultCredential(authPath) {
  if (!fs.existsSync(authPath)) return '';
  const stat = fs.statSync(authPath);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Invalid local auth file');
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const value = auth?.OPENAI_API_KEY || auth?.tokens?.access_token || auth?.tokens?.id_token || '';
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error('Invalid local credential');
  }
  return value;
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error('Missing result body');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) throw new Error('Result body too large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function createTianxiResultReader(options = {}) {
  if (options.model != null && options.model !== 'tianxi/super') {
    throw new Error('Invalid result model');
  }
  const endpoint = resultEndpoint(options.baseUrl || 'http://127.0.0.1:3085/v1');
  const authPath = options.authPath || path.join(os.homedir(), '.codex', 'auth.json');
  const credential = options.credential || (() => readResultCredential(authPath));
  const fetchResult = options.fetch || globalThis.fetch;
  const wait =
    options.wait ||
    ((signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(done, 1000);
        function done() {
          signal.removeEventListener('abort', abort);
          resolve();
        }
        function abort() {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new Error('Canceled'));
        }
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }));
  const timeoutMs =
    Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
      ? Math.min(options.timeoutMs, 60 * 60 * 1000)
      : 60 * 60 * 1000;
  return async function readResult(reference, signal) {
    if (typeof reference !== 'string' || !REFERENCE_PATTERN.test(reference)) {
      throw new Error('Invalid result reference');
    }
    const deadline = AbortSignal.timeout(timeoutMs);
    const activeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    while (!activeSignal.aborted) {
      const key = credential();
      const requestSignal = AbortSignal.any([activeSignal, AbortSignal.timeout(10000)]);
      const response = await fetchResult(endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: requestSignal,
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: 'Bearer ' + key } : {}),
        },
        body: JSON.stringify({
          model: options.model || 'tianxi/super',
          input: '',
          stream: false,
          metadata: { tianxi_result_reference: reference, tianxi_result_format: '2' },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Result unavailable');
      }
      const data = await readBoundedJson(response);
      if (
        data?.object !== 'tianxi.tool_result' ||
        data.reference !== reference ||
        !TOOLS.has(data.tool) ||
        !Number.isSafeInteger(data.ordinal) ||
        data.ordinal < 1 ||
        data.ordinal > 512 ||
        !STATUSES.has(data.status) ||
        !STATUSES.has(data.taskStatus)
      ) {
        throw new Error('Invalid result record');
      }
      const safe = {
        reference,
        tool: data.tool,
        ordinal: data.ordinal,
        status: data.status,
        taskStatus: data.taskStatus,
        ...(data.details !== undefined
          ? { details: parseTianxiResultDetails(data.tool, data.details) }
          : {}),
      };
      if (safe.status !== 'in_progress' || safe.taskStatus !== 'in_progress') return safe;
      await wait(activeSignal);
    }
    throw new Error('Result deadline reached');
  };
}

function createTianxiResultMcpServer(readResult) {
  let activeReads = 0;
  const server = new Server(
    { name: 'tianxi-progress', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(RESULT_READERS).map(([name, title]) => ({
      name,
      title,
      description:
        'Read an existing Tianxi operation status by opaque reference. Never executes tools or reads workspace files.',
      inputSchema: {
        type: 'object',
        properties: { reference: { type: 'string', pattern: REFERENCE_PATTERN.source } },
        required: ['reference'],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = request.params.arguments;
    if (
      !Object.hasOwn(RESULT_READERS, request.params.name) ||
      !args ||
      Object.keys(args).length !== 1 ||
      typeof args.reference !== 'string' ||
      !REFERENCE_PATTERN.test(args.reference)
    ) {
      return { isError: true, content: [{ type: 'text', text: 'Invalid result reference.' }] };
    }
    if (activeReads >= 128) {
      return { isError: true, content: [{ type: 'text', text: 'Tianxi result bridge is busy.' }] };
    }
    activeReads++;
    try {
      const record = await readResult(args.reference, extra.signal);
      if (record?.reference !== args.reference) throw new Error('Invalid result reference');
      if (
        request.params.name !== BRIDGE_TOOL &&
        request.params.name !== tianxiResultReaderName(record.tool)
      )
        throw new Error('Result category mismatch');
      const text =
        formatTianxiToolResult(record.tool, record.ordinal, record.status, record.taskStatus) +
        formatTianxiResultDetails(record.tool, record.details);
      return {
        isError: record.status !== 'completed',
        content: [{ type: 'text', text }],
      };
    } catch (_error) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Tianxi result is unavailable or expired.' }],
      };
    } finally {
      activeReads--;
    }
  });
  return server;
}

async function runTianxiResultMcp(options = {}) {
  const server = createTianxiResultMcpServer(createTianxiResultReader(options));
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 })
  );
  return server;
}

module.exports = {
  resultEndpoint,
  readResultCredential,
  createTianxiResultReader,
  createTianxiResultMcpServer,
  runTianxiResultMcp,
};
