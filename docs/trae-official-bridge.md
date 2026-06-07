# Trae Official Login Bridge Notes

[中文版本](trae-official-bridge.zh-CN.md)

This document records the working solution for Trae International official-login
generation forwarding. It exists because Trae looks OpenAI-like from the outside,
but its successful generation path is not an OpenAI-compatible HTTP backend.

## Problem

The proxy originally exposed Trae official-login model discovery and route
validation, but generation returned a 501-style failure:

```text
Trae official login is connected for local login state, model discovery, and
route validation; generation still needs a Trae AhaNet official-client adapter.
It cannot be forwarded directly to OpenAI /chat/completions.
```

The important correction is that Trae and AGY are separate official-login paths.
AGY is Google / Code Assist and was already working. Trae must use Trae's own
local client path.

## What We Learned

Real Trae chat generation uses this path:

```text
Trae renderer chat UI
  -> TransportManager
  -> ai-agent RPC service=chat method=chat
  -> Trae ai-agent native module
  -> AhaNet
  -> https://coresg-normal.trae.ai/api/agent/v3/create_agent_task
```

Evidence from a real local Trae send:

- Renderer log showed `send chat`, `doRequestWithStream start: service=chat,
  method=chat`, and `TransportManager executeRequest, chat chat`.
- `ai-agent` log showed `service: "chat", method: "chat"` and successful cloud
  task completion.
- Trae's model/detail sync calls use
  `/api/ide/v1/get_detail_param`; that endpoint is not the chat generation
  endpoint.
- The backend chat task endpoint observed in logs is
  `/api/agent/v3/create_agent_task`.
- Port `127.0.0.1:51160` belongs to Trae CKG, not a chat HTTP API.
- Trae's current runtime uses Electron `ahaIpc`; an external Node
  `@aha-kit/ipc` client could not attach to the same chat path.

The useful internal commands found in Trae are:

- `wx.bridge.sendAndWaitResponse`
- `feishu.bridge.sendAndWaitResponse`
- `im.bridge.sendPromptStreaming`

The first two call Trae's internal `sendPromptAndWaitResponse`, which uses
Trae's own `sendToAgent` API and official login state.

## Implemented Architecture

We bridge through Trae itself instead of trying to clone AhaNet.

### Architecture Diagram

```mermaid
flowchart LR
  Chat["OpenAI Chat<br/>3447 /v1/chat/completions"]
  Responses["OpenAI Responses<br/>3445 /v1/responses"]
  Claude["Claude Messages<br/>3443 /v1/messages"]

  Route["HTTPS Proxy Manager<br/>Trae route<br/>for example trae/minimax-m3"]
  Queue["Trae bridge serial queue<br/>traeOfficialBridgeQueue"]
  Adapter["Protocol adapter<br/>OpenAI / Responses / Claude"]

  Bridge["Local HTTP bridge<br/>127.0.0.1:17861/v1/chat"]
  Extension["Trae extension host<br/>local.https-proxy-manager-trae-bridge"]
  Command["wx.bridge.sendAndWaitResponse"]

  Login["Trae official login state"]
  AhaNet["AhaNet"]
  Cloud["Trae cloud<br/>/api/agent/v3/create_agent_task"]

  Chat --> Route
  Responses --> Route
  Claude --> Route
  Route --> Queue
  Queue --> Adapter
  Adapter --> Bridge
  Bridge --> Extension
  Extension --> Command
  Command --> Login
  Login --> AhaNet
  AhaNet --> Cloud
  Cloud -. "final generation" .-> Adapter
  Adapter -. "JSON or compatible SSE" .-> Chat
  Adapter -. "JSON or compatible SSE" .-> Responses
  Adapter -. "JSON or compatible SSE" .-> Claude
```

```text
OpenAI-compatible client
  -> HTTPS Proxy Manager openai-chat / openai-responses / claude entry
  -> Trae route, for example trae/minimax-m3
  -> local HTTP bridge http://127.0.0.1:17861/v1/chat
  -> Trae extension host
  -> wx.bridge.sendAndWaitResponse
  -> Trae official login + AhaNet
```

Code locations:

- Proxy adapter: `openai-proxy.js`
- Trae extension source:
  `tools/trae-openai-bridge-extension/package.json`
  `tools/trae-openai-bridge-extension/extension.js`
- Installed Trae extension:
  `%USERPROFILE%/.trae/extensions/local.https-proxy-manager-trae-bridge-0.1.0`
- Tests: `test/adapter.test.js`

The bridge listens only on localhost:

```text
http://127.0.0.1:17861/health
http://127.0.0.1:17861/v1/chat
http://127.0.0.1:17861/v1/chat/stream
http://127.0.0.1:17861/debug/commands
```

Proxy configuration knobs:

- `TRAE_BRIDGE_HOST` defaults to `127.0.0.1`
- `TRAE_BRIDGE_PORT` or `TRAE_OPENAI_BRIDGE_PORT` defaults to `17861`
- `TRAE_BRIDGE_URL` or `TRAE_OPENAI_BRIDGE_URL` can override the base URL
- `TRAE_BRIDGE_TIMEOUT_MS` defaults to 5 minutes
- `TRAE_BRIDGE_LIVE_HEARTBEAT_MS` controls proxy-side live heartbeat interval,
  default 2 seconds
- `TRAE_BRIDGE_LOG_PROGRESS=0` disables Trae local-log progress side-channel
- `TRAE_BRIDGE_RAW_PROGRESS=comment` or `1` maps Raw Stream Patch events to API
  SSE comments, disabled by default
- `TRAE_BRIDGE_BUSY_RETRY_ATTEMPTS` controls retries when the Trae session is
  busy or running, default 30
- `TRAE_BRIDGE_BUSY_RETRY_DELAY_MS` controls the busy retry delay, default
  1000ms

## Request Conversion

For OpenAI Chat Completions, OpenAI Responses, and Claude Messages:

1. Match the public model route to the `trae-official` profile.
2. Normalize the model, for example `trae/minimax-m3` -> `minimax-m3`.
3. Convert the incoming protocol request into an OpenAI Chat-like message list.
4. Convert messages into a single Trae prompt with role labels:
   `System`, `Developer`, `User`, `Assistant`, `Tool`.
5. Extract data URL images into bridge image payloads when present.
6. POST `{ prompt, images, model, stream, metadata }` to the local Trae bridge.
7. Wrap Trae's final text as the requested protocol:
   - OpenAI Chat `chat.completion`
   - OpenAI Responses `response`
   - Claude Messages `message`
8. For `stream: true`, emit protocol-compatible SSE chunks.

Streaming requests now use `/v1/chat/stream`, which calls Trae's
`im.bridge.sendPromptStreaming` command when it is available. The local bridge
converts Trae's cumulative text callback into `text_delta` SSE events and
unconfirmed Trae interactions into `interaction` SSE events. The proxy then
maps those events back to OpenAI Chat, OpenAI Responses, or Claude Messages
streaming responses.

This is still not a raw token-level AhaNet stream. The first implementation
does not pretend that Trae's internal tools are client-side tool calls; it emits
them as visible text markers so the client can see the Trae-side process without
running the same tool twice.

Trae's public streaming command usually calls back with text only after the
final `ReplyUser` plan item is available, so intermediate UI thinking or tool
execution steps do not always become `text_delta` events. The bridge emits a
`progress` SSE heartbeat every 2 seconds while Trae is running. The proxy maps
that heartbeat to OpenAI/Responses SSE comments or Claude `ping` events. This
heartbeat only proves the Trae-side run is still active; it does not expose
hidden reasoning.

Further investigation found that Trae's renderer and ai-agent logs record some
process state earlier than `im.bridge.sendPromptStreaming` returns text:

- `[ai-chat][sendToAgent]`: the request entered the Trae session.
- `[tooling] ... start/end`: a Trae-side IDE tool or command started/finished.
- `[ai-chat][PlanItemStreamParser] confirm_info received`: plan-item
  confirmation status.
- `first token flushed thought`: the model reached first token. The reasoning
  text in this log line is intentionally not forwarded.
- `[AgentStatus] received` and `plan final token cost`: agent completion and
  timing.

During live streams, the proxy tails only newly appended lines from the current
Trae log files and maps safe summaries to `source:"trae-log"` progress events.
OpenAI Chat and Responses expose these as SSE comments, for example:

```text
: trae-progress {"source":"trae-log","kind":"tool_start","command":"icube.common.commands.tooling.listFolder"}
```

Claude remains protocol-compatible and maps these log-progress events to
`ping`. The side-channel does not forward command output bodies or reasoning
snippets; it only provides earlier operational status from Trae's own local
logs.

If the streaming command returns `Now session is not waiting input`, busy, or
running, the bridge retries according to `TRAE_BRIDGE_BUSY_RETRY_ATTEMPTS` and
`TRAE_BRIDGE_BUSY_RETRY_DELAY_MS`, and emits `phase:"busy"` SSE progress while
waiting. If streaming still fails, it falls back to `wx.bridge.sendAndWaitResponse`.
If stream headers have already been sent, later errors are written as visible
bridge busy/error markers and the stream is closed normally, instead of leaving
the client with a silent gap or abrupt disconnect.

The proxy serializes Trae bridge calls. Trae's current chat session can reject
parallel sends with `Now session is not waiting input`, so concurrent requests
from different proxy ports are queued before hitting the local bridge.

## Validation Commands

Check that Trae sees the extension:

```powershell
trae --list-extensions --show-versions | Select-String -Pattern 'https-proxy-manager'
```

Expected:

```text
local.https-proxy-manager-trae-bridge@0.1.0
```

Check the bridge directly:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:17861/health' -TimeoutSec 3
```

Expected JSON includes:

```json
{
  "ok": true,
  "command": "wx.bridge.sendAndWaitResponse",
  "port": 17861
}
```

Discover bridge and streaming commands currently visible to Trae's extension
host:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:17861/debug/commands' -TimeoutSec 3
```

Important fields:

- `waitCommand`: the wait/final-response command used for non-streaming calls.
- `streamCommand`: the streaming command used for live streaming when present.
- `streamingCommands`: whether streaming candidates are available.
- `discoveredCommands`: related commands exposed by the current Trae runtime.

Check through the proxy management API:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:1430/v1/local/trae/bridge/status' -TimeoutSec 5
```

Direct bridge smoke test:

```powershell
$payload = @{ prompt = '请只回复 OK'; model = 'minimax-m3' } | ConvertTo-Json
Invoke-WebRequest `
  -UseBasicParsing `
  -Uri 'http://127.0.0.1:17861/v1/chat' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body $payload `
  -TimeoutSec 240
```

Expected:

```json
{"ok":true,"command":"wx.bridge.sendAndWaitResponse","text":"OK"}
```

Full OpenAI Chat proxy test on port `3447`:

```powershell
$payload = @{
  model = 'trae/minimax-m3'
  messages = @(@{ role = 'user'; content = '请只回复 OK_FROM_PROXY' })
  stream = $false
} | ConvertTo-Json -Depth 8

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri 'https://127.0.0.1:3447/v1/chat/completions' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body $payload `
  -SkipCertificateCheck `
  -TimeoutSec 240
```

Expected response shape:

```json
{
  "object": "chat.completion",
  "model": "minimax-m3",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "OK_FROM_PROXY"
      }
    }
  ]
}
```

Full OpenAI Responses proxy test on port `3445`:

```powershell
$payload = @{
  model = 'trae/minimax-m3'
  input = '请只回复 RESPONSES_OK'
  stream = $false
} | ConvertTo-Json -Depth 8

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri 'https://127.0.0.1:3445/v1/responses' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body $payload `
  -SkipCertificateCheck `
  -TimeoutSec 240
```

Full Claude Messages proxy test on port `3443`:

```powershell
$payload = @{
  model = 'trae/minimax-m3'
  max_tokens = 64
  messages = @(@{ role = 'user'; content = '请只回复 CLAUDE_OK' })
  stream = $false
} | ConvertTo-Json -Depth 8

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri 'https://127.0.0.1:3443/v1/messages' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body $payload `
  -SkipCertificateCheck `
  -TimeoutSec 240
```

Full OpenAI Chat streaming proxy test:

```powershell
$payload = @{
  model = 'trae/minimax-m3'
  messages = @(@{ role = 'user'; content = '请只回复 STREAM_OK' })
  stream = $true
} | ConvertTo-Json -Depth 8

Invoke-WebRequest `
  -UseBasicParsing `
  -Uri 'https://127.0.0.1:3447/v1/chat/completions' `
  -Method POST `
  -ContentType 'application/json; charset=utf-8' `
  -Body $payload `
  -SkipCertificateCheck `
  -TimeoutSec 240
```

Expected content type is `text/event-stream`, with chunks ending in:

```text
data: [DONE]
```

## Ports And Entries

The local proxy can expose multiple protocol entries. In the current setup:

- `https://localhost:3443/v1` is the Claude entry.
- `https://localhost:3445/v1` is the OpenAI Responses entry.
- `https://localhost:3447/v1` is the OpenAI Chat entry.

Trae official bridge now supports:

- `3443 /v1/messages`
- `3445 /v1/responses`
- `3447 /v1/chat/completions`

Use the protocol path that matches the entry. Calling `/v1/chat/completions` on
the Claude entry still returns a path mismatch by design.

## Raw Stream Patch Diagnostic Mode

`im.bridge.sendPromptStreaming` is the public bridge command. It can reliably
surface cumulative text, `interaction` events, and heartbeats, but it usually
does not expose the earlier plan/tool/timing events that Trae shows in its own
UI. For deeper debugging, we verified a temporary patch against Trae's installed
workbench bundle.

The deepest working hook found so far is:

```text
Trae workbench.desktop.main.js
  -> TransportManager.executeStreamRequest
  -> this._client.sendStreamRequest("request_stream", packet, onData, onError, onEnd)
  -> onData(f)
  -> f.data.event / f.data.payload
```

This is the first renderer-side stop after the Aha RPC `request_stream` returns.
It can expose events such as:

- `metadata`
- `model_config`
- `token_usage`
- `timing_events`
- `plan_item`
- `done`

A minimal direct bridge stream request for `请只回复 OK。` produced:

```text
RAW_EVENT_COUNT=18
TEXT_DELTA_COUNT=1
```

That confirms `raw_event` can arrive before the final `text_delta`.

### Install And Verify

Install the experimental patch:

```powershell
node scripts/patch-trae-raw-stream.js
```

The script patches and backs up:

- `%LOCALAPPDATA%/Programs/Trae/resources/app/out/vs/workbench/workbench.desktop.main.js`
- `%LOCALAPPDATA%/Programs/Trae/resources/app/node_modules/@byted-icube/ai-modules-chat/dist/index.mjs`

Restart Trae after patching, then check command registration:

```powershell
Invoke-RestMethod http://127.0.0.1:17861/debug/commands |
  ConvertTo-Json -Depth 6
```

Expected field:

```json
{
  "rawStreamCommand": "im.bridge.subscribeRawStream"
}
```

Inspect the raw queue snapshot:

```powershell
Invoke-RestMethod http://127.0.0.1:17861/debug/raw-stream |
  ConvertTo-Json -Depth 8
```

Check direct SSE output:

```powershell
$body = @{ prompt = '请只回复 OK。' } | ConvertTo-Json -Compress
$response = Invoke-WebRequest `
  -Uri http://127.0.0.1:17861/v1/chat/stream `
  -Method POST `
  -ContentType 'application/json' `
  -Body $body `
  -TimeoutSec 120

([regex]::Matches($response.Content, '^event: raw_event', 'Multiline')).Count
```

To expose these process events at the OpenAI / Responses / Claude API layer,
restart the proxy with:

```powershell
$env:TRAE_BRIDGE_RAW_PROGRESS = 'comment'
```

The proxy keeps them out of assistant text and writes SSE comments instead:

```text
: trae-raw {"source":"trae-raw","event":"plan_item","agentStatus":"running","toolName":"finish"}
```

Standard SDKs may ignore SSE comments. `curl`, `Invoke-WebRequest`, or a custom
SSE client can see them. This is intended for debugging, not as a default mode.

### Safety Boundary

Raw payloads can contain prompt text, model config, token counts, `ak` / `sk`,
`reasoning_content`, `thought`, and other sensitive internals. The bridge
therefore recursively redacts before forwarding:

- token, authorization, API key, secret, `ak`, and `sk` fields become
  `[redacted]`
- reasoning, thought, prompt, content, and text-like fields keep only
  `{ redacted: true, chars: N }`
- large objects are depth, array, and key-count limited
- `/v1/chat/stream` forwards only Aha RPC events with `service:"chat"` and
  `method:"chat"`, filtering non-chat RPCs and duplicate UI-layer events

### Integrity Warning And Rollback

This mode edits Trae's installed files. Trae can show:

```text
Trae 安装似乎损坏。请重新安装。
```

That is Trae's integrity check detecting the patched install, not a bridge code
failure. This mode is useful for temporary diagnostics and proof-of-capability,
but it should not be treated as the default product path.

Rollback:

```powershell
node scripts/unpatch-trae-raw-stream.js
```

Restart Trae after rollback. The deep `rawStreamCommand` / `raw_event` path will
disappear, and the install-integrity warning should disappear as well. For
normal operation, prefer the public bridge command, log side-channel, and
heartbeat progress; keep Raw Stream Patch as a Debug-mode switch.

## Troubleshooting

If `/v1/local/trae/bridge/status` returns `ECONNREFUSED`:

1. Confirm the extension is installed:
   `trae --list-extensions --show-versions`
2. Reload the Trae window or restart Trae.
3. Check `http://127.0.0.1:17861/health`.
4. Confirm no other process owns port `17861`.

If the bridge is healthy but generation fails:

1. Send a tiny direct bridge prompt first.
2. Make sure Trae itself is logged in and can send a message in the UI.
3. Check the latest Trae logs under:
   `%APPDATA%/Trae/logs/<timestamp>/window1/renderer.log`
   `%APPDATA%/Trae/logs/<timestamp>/Modular/ai-agent_*_stdout.log`
4. Look for:
   `send chat`
   `service: "chat", method: "chat"`
   `ChatStreamFrontResponseReporter status Success`

If a request fails with an entry path error:

- Match path to port:
  - Claude: `3443 /v1/messages`
  - Responses: `3445 /v1/responses`
  - Chat: `3447 /v1/chat/completions`

## Regression Tests

Run:

```powershell
npm test
```

The test suite includes:

- OpenAI Chat request to Trae bridge prompt conversion.
- data URL image extraction for Trae bridge payloads.
- Trae bridge text wrapping into OpenAI `chat.completion`.
