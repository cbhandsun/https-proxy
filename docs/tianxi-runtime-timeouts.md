# Tianxi Native Runtime Deadlines

## Client upgrade compatibility

The authentication adapter accepts complete, digest-pinned file sets for the
original client and XLSmartUI 4.4.1.10081 / WrapPlugin 10.26.0.1212 /
XLAgentCorePlugin 4.4.0.9151. Each set selects its own public-constant offsets;
mixed or unknown files still fail with `tianxi_auth_build_changed`. This reason
is now presented explicitly when automatic authentication fails.

Native Qoder requests use the same validated VPC instance configuration as SDK
requests. The instance comes from the existing native runtime log discovery;
missing or ambiguous configuration fails closed. Credentials remain in pipes
and request memory and are not added to settings files.

Before starting a local tac-server, the adapter probes its configured port for
bind permission. If Windows reserves it, startup tries 49306 and 49307, and the
WebSocket follows the selected port. Exhausted candidates fail explicitly. The
probe releases its listener before startup, so a concurrent port claimant can
still cause startup to fail. Startup allows 15 seconds for the upgraded backend.

## Native runtime deadlines

The direct tac-server agent has a default no-progress deadline of 30 minutes. Native
agents may execute many tools in one request, so their total execution budget is
separate from the existing 120-second idle watchdog. For native queries the idle
watchdog emits a waiting notice while the socket remains open, rather than
aborting and causing the client to restart a potentially active task. Genuine
provider output/tool activity renews the default no-progress deadline. Working
status frames and synthetic waiting notices do not renew it. Expiry cancels the
underlying transport, so waiting notices cannot keep a stalled task alive forever.

An explicit profile `timeoutMs` takes precedence over
`HPM_TIANXI_RUNTIME_TIMEOUT_MS`. Either explicit setting keeps total-deadline
semantics and is not renewed by activity. Numeric strings and numbers from 1
through 2147483647 milliseconds are accepted; invalid
values fall back to the native default. Fixture, file, and generic transport
runtimes retain their five-minute default. The HTTP bridge timeout is unchanged.

When the native stream throws after output has arrived, the bridge preserves
that output but emits `response.incomplete`, not `response.completed`. The
incomplete reason is the fixed code `tianxi_native_stream_interrupted`; the
safe underlying failure code remains in the request-end log. Partial assistant
messages are marked incomplete and are not saved as successful response history.
An explicit provider failure remains `response.failed`.

Native queries now require a provider terminal status. An ACK confirms query
acceptance only; it does not complete the task. Socket closure before a
terminal frame is an interruption even after visible output. Silence alone on
an open native socket is not a terminal condition; the default no-progress deadline
or explicitly configured total deadline still bounds unresponsive requests. Control commands
still accept their matching ACK. A Responses result without a terminal frame is
incomplete even when partial assistant text exists.

## Responses Compatibility

`tianxi/chat` is a text-only route. Use `tianxi/super` with the read-only bridge
enabled for project inspection. Tool catalogs carried by Codex `additional_tools`
or `tool_search_output` input items are checked before history is stripped, just
like top-level tool declarations. Text-only routes reject these requests instead
of returning model-generated tool-call markup as a successful answer. The proxy
does not execute DSML text or silently switch the selected route.

Text parts include `annotations` and `logprobs` arrays; text delta/done events
include `logprobs`. Unavailable provider token usage remains `null`, not invented
token counts. Initial response events include nullable error, incomplete details,
and usage fields. The public response model preserves the client's requested
alias, while the provider payload still uses the internal routed model.

Progress uses the documented `response.reasoning_summary_*` events and reasoning
items with `summary` arrays. The bridge no longer emits the nonstandard
`response.reasoning.delta/done` aliases. Final item events and response output
share IDs, indices, content, and statuses. Provider failures cannot be overridden
by later completion frames.

The first native `WORKING` status is streamed immediately as sanitized status
progress, without waiting for a tool or text frame. It does not commit content or
disable pre-content credential retry. Repeated statuses, including across that
retry, are suppressed. The same sanitized status is retained in final frames so
streamed progress and final Responses output agree. This status is a provider
lifecycle signal, not a model-generated thought summary.

This is a compatibility bridge, not full OpenAI feature parity. Native tools run
on the provider and remain progress summaries, not client function calls. Token
usage, client tool execution, and multimodal inputs are not synthesized. Tianxi
incomplete reasons and error diagnostics remain provider-specific extensions;
strict OpenAI schema consumers need to account for those extensions.

Every native tool start and matched return now emits progress immediately through
the reasoning summary stream, including explicit failure/cancellation flags.
Duplicate IDs are suppressed and native batches are processed up to 128 actions
per frame. Tool names and per-tool counts are visible; parameters, file paths,
raw outputs, and error details are not included in the synthetic progress text.
Provider text buffered during a matched native tool operation is released as
progress on the return frame. Explicit final text remains assistant output.

Reference: https://developers.openai.com/api/reference/resources/responses/streaming-events
