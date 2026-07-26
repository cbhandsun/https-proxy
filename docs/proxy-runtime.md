# Proxy Module Map

The proxy runtime currently uses a flat CommonJS module directory so existing
entry points and release packaging can resolve modules without aliases. File
names express their ownership:

- `config-*`, `runtime-*`, `server-*`: process lifecycle and configuration.
- `entry-*`, `routing`, `route-*`: local entry authentication and route
  selection.
- `protocol-*`, `stream-*`, `sse*`: protocol conversion and streaming.
- `management-*`, `local-handlers`, `handlers/`: local management API.
- `auth-*`, `profile-auth`, `secret-crypto`: credential boundaries.
- `request-*`, `upstream-*`, `proxy-transport`, `http-*`: outbound transport.
- `diagnostics`, `metrics`, `usage*`, `audit*`, `logger`: observability.
- `claude-*`, `google-*`, `openai-*`, `trae-*`: provider and tool integrations.
- `env-tools`, `tool-*`, `mcp-hub`, `prompts-sync`: local developer tooling.

New modules must use the existing domain prefix or live in `handlers/` when they
implement a management route family. Avoid generic names such as `utils2.js`,
and keep `openai-proxy.js` as a composition root rather than adding business
logic to it.
