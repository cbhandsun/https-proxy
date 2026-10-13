'use strict';

// Synthetic contract probe only. Never emits metadata values or credentials.
const { createHash } = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const digest = (value) =>
  typeof value === 'string' ? createHash('sha256').update(value).digest('hex') : null;
const server = new Server(
  { name: 'identity-probe', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
let hookCalls = 0;
let lastHook = null;
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [
    {
      name: 'probe_identity',
      description: 'Synthetic local identity contract probe.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
  if (request.params.name === 'capture_hook_only') {
    hookCalls++;
    lastHook = {
      metaKeys: Object.keys(request.params._meta ?? {}).sort(),
      inputKeys: Object.keys(request.params.arguments ?? {}).sort(),
      eventName:
        request.params.arguments?.hook_event_name === 'PostToolUse' ? 'PostToolUse' : 'other',
      sessionDigest: digest(request.params.arguments?.session_id),
    };
    return { content: [{ type: 'text', text: '{}' }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pid: process.pid,
          hookCalls,
          lastHook,
          requestMetaKeys: Object.keys(request.params._meta ?? {}).sort(),
          contextKeys: Object.keys(extra).sort(),
          contextInfoKeys: Object.keys(extra.requestInfo ?? {}).sort(),
          sessionIdDigest: digest(extra.sessionId),
          threadEnvDigest: digest(process.env.CODEX_THREAD_ID),
          sessionEnvDigest: digest(process.env.CODEX_SESSION_ID),
          metaDigests: Object.fromEntries(
            Object.entries(request.params._meta ?? {})
              .filter(([key]) => /thread|session|hook/i.test(key))
              .map(([key, value]) => [key, digest(value)])
          ),
        }),
      },
    ],
  };
});
server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write('identity_probe_start_failed\n');
  process.exitCode = 1;
});
