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

## Upstream DNS hardening

`upstream-dns.js` provides the resolver used by the outbound HTTPS agents.
It queries trusted resolvers directly instead of relying on the OS resolver
chain, keeps a short per-host cache, and only accepts routable public
addresses.

This exists because the Windows DNS client may hand a poisoned answer from one
configured server (for example a router that resolves `chatgpt.com` to an
unrelated host). TLS then fails with `ERR_TLS_CERT_ALTNAME_INVALID` and the
proxy returns 502 even though the internet connection itself is fine.

Operational notes:

- `appSettings.upstreamDnsServers` accepts an ordered array of literals or a
  comma-separated string. Order is priority; the first server that answers with
  a public address wins.
- An explicitly empty list (`[]` or `""`) disables the feature and restores
  system resolution. A missing field keeps the built-in trusted list.
- Single-label names and `.local`/`.internal`/`.lan` style names always use
  system resolution, so intranet hosts keep working.
- When all trusted servers fail, the resolver falls back to system resolution
  and logs at debug level, so a broken DNS egress degrades instead of failing
  the request outright.
- Certificate mismatches and unreachable addresses invalidate the cache entry
  for that host, so the retry re-resolves instead of reusing the bad address.
- Pre-handshake TLS failures are retryable even for POST without an
  `Idempotency-Key`, because the request body was never transmitted.
- Failures while the TLS handshake is still in progress count as
  pre-transmission too, even when the error code is `ECONNRESET`. TLS buffers
  application data until the handshake completes, so a reset during the
  handshake guarantees no HTTP bytes reached the upstream. This is detected
  from the connection state, not the error code, so a reset on an established
  or reused connection still requires the normal idempotency contract.
