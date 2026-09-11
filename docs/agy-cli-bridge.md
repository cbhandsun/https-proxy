# Official AGY CLI bridge (Windows preview)

This optional backend runs the installed official `agy.exe`; it does not extract
IDE OAuth tokens or construct Code Assist requests. The existing Google routes
are unchanged.

## Verify

Sign in once with the official `agy` CLI, then run `npm run agy:verify`.
This explicitly makes real model requests using the signed-in account and its
quota. It starts an isolated copy of HTTPS Proxy and the bridge on local ports,
verifies single-turn chat, supplied conversation history, SSE, and rejection of
unsupported tool parameters, then stops both services. Production configuration
and installed binaries are not modified. A content-free report is written to
`.hpm-runtime/agy-validation.json` after all checks pass.

Offline regression tests are in `test/agy-bridge.test.js` and are automatically
discovered by the existing `npm run test:unit` CI entry. Live checks are separate
because they need an interactive user's official login and consume quota.

## Run separately

Create a private file containing a random bearer token of at least 32 characters.
Do not commit the token or put it in shell history. Set `HPM_AGY_TOKEN_FILE` to
its absolute path, then run `npm run agy:bridge`.

- Listener: `http://127.0.0.1:17863/v1` (override with `HPM_AGY_PORT`).
- Executable: `%LOCALAPPDATA%/agy/bin/agy.exe` (override with an absolute
  `HPM_AGY_EXECUTABLE` path).
- Model: `agy/gemini-3.7-flash-high`.
- APIs: authenticated `GET /v1/models` and `POST /v1/chat/completions`.

To connect through HTTPS Proxy, add a **separate** `agy-cli` profile using the
OpenAI protocol, API-key authentication, the listener URL above, and the bridge
token. Add a model route from `agy/gemini-3.7-flash-high` to the same model name on
that profile. Keep `google-official` and existing routes unchanged. The client
uses its usual HTTPS Proxy entry key, not the private bridge token. Its entry
key must explicitly permit the new profile if profile restrictions are enabled.

For a direct local Cherry Studio test, use the bridge URL, bridge token, and
model above. Disable optional generation parameters and tool features for this
preview; unsupported fields return 400 rather than being silently ignored.
This preview is for a trusted local user, not public multi-user hosting.

## Boundaries

- Text-only `system` (first message only), `user`, and `assistant` history.
  CLI stdin accepts user prompts rather than native OpenAI role envelopes, so
  history is serialized into a transcript. This is not exact system-role or
  token-accounting compatibility, and requests do not share a CLI session.
- Only `model`, `messages`, `stream`, and `stream_options.include_usage` are
  accepted. Images, audio, files, tools, temperature, max_tokens, response_format,
  and other unsupported controls are rejected before launching the CLI.
- One generation at a time; concurrent work gets 429. A request has a 60-second
  process deadline, 128-KiB input limit, 4-MiB output limit and bounded stderr.
- SSE translates CLI response deltas when available. CLI versions may emit the
  entire answer in one event; token-by-token latency is not guaranteed. Errors
  after HTTP headers are SSE error events, never a successful finish.
- Disconnects/timeouts terminate the spawned CLI process tree. This cannot
  guarantee cancellation of work already accepted by Google's remote backend.

## Security and privacy

Every request gets a private temporary Windows user-profile directory and an
empty workspace. A separate CLI settings file denies all documented file,
command, unsandboxed-command, URL/browser and MCP permission namespaces.
`--sandbox`, `--mode plan`, and `--disable-slash-commands` are always supplied;
`--dangerously-skip-permissions` is never supplied. Requests go over stdin, not
shell commands or process arguments. Provider API keys and custom model-base-URL
environment variables are not inherited.

The bridge also rejects a run if the CLI reports a tool step. This is defense in
depth: observing output is not itself a preventative security boundary. The CLI's
own permission enforcement remains a dependency. Revalidate it after upgrades;
do not describe this as an OS sandbox isolating the entire Google agent service.

The official Windows keyring supplies the login; no tokens are copied into the
temporary profile. CLI diagnostics are not forwarded to clients or proxy logs.
Bridge request logs contain only request IDs, status and fixed error codes.
Temporary CLI files are removed after process exit; cleanup failures are surfaced.
Official agent services may retain conversation data under their own policies;
this bridge does not claim to erase Google's or the official client's history.

References: [headless interface](https://antigravity.google/docs/cli/headless/),
[permissions](https://antigravity.google/docs/cli/permissions/),
[authentication](https://antigravity.google/docs/cli/install/).
