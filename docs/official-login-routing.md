# Official Login Routing Notes

This note captures the implementation rules for official-login routes. Official
login is not the same as API key mode: credentials, model discovery, and request
shape must follow the upstream official client that owns the login session.

## Core Rule

Keep each official-login route internally consistent:

- Credential source, model list, model ID, and generation endpoint must come from
  the same upstream product path.
- Do not mix public API model lists with official client backends.
- Do not trust a friendly display name until it has been mapped to the real
  backend model ID used by that official client.
- Route tests should validate that the target model is supported by the current
  official-login path, not only that credentials can reach a generic model-list
  endpoint.

## Google Official / AGY

Google official routes are implemented as Antigravity / Code Assist routes.

Credential handling:

- Prefer Antigravity official login state over public Gemini API key files.
- Treat `ya29.` tokens as official OAuth access tokens, not Gemini API keys.
- Refresh expired AGY tokens with the AGY OAuth client when a refresh token is
  available.
- Do not overwrite official-login credentials with arbitrary client-supplied API
  keys.

Model discovery:

- Use the Code Assist backend:
  `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`
- Do not use public Gemini model discovery as the source of truth for AGY.
- Prefer AGY display names for non-Gemini models in public model lists, for
  example:
  `Claude Sonnet 4.6 (Thinking)`
  `Claude Opus 4.6 (Thinking)`
  `GPT-OSS 120B (Medium)`

Generation:

- Convert requests into the Code Assist request shape.
- Use the Code Assist generation endpoints instead of public Gemini
  `generateContent` when the route is official-login + Google + AGY.
- Keep internal aliases for compatibility, but expose AGY-facing model names to
  users where possible.

Important mappings:

| Public route label | Backend model |
| --- | --- |
| `Gemini 3.5 Flash (Medium)` | `gemini-3.5-flash-low` |
| `Gemini 3.5 Flash (High)` | `gemini-3-flash-agent` |
| `Gemini 3.5 Flash (Low)` | `gemini-3.5-flash-extra-low` |
| `Claude Sonnet 4.6 (Thinking)` | `claude-sonnet-4-6` |
| `Claude Opus 4.6 (Thinking)` | `claude-opus-4-6-thinking` |
| `GPT-OSS 120B (Medium)` | `gpt-oss-120b-medium` |

## OpenAI Official / Codex

OpenAI official routes are implemented as Codex official-login routes.

Credential handling:

- Read Codex credentials from `~/.codex/auth.json`.
- Prefer `tokens.access_token` when present.
- Treat JWT-looking `eyJ...` tokens as official login tokens, not API keys.
- When the `openai-official` profile has no configured API key, infer
  `official-login` and load local Codex credentials.

Target handling:

- The user-facing profile may stay configured as `https://api.openai.com/v1`.
- For official-login Codex requests, internally switch to:
  `https://chatgpt.com/backend-api/codex`
- Chat/completions compatibility should be converted to Codex responses requests
  before calling the backend.

Model discovery:

- Do not use ChatGPT Web `/backend-api/models` as the Codex generation source of
  truth.
- Use `~/.codex/models_cache.json` for Codex-supported models.
- Only expose models that are both:
  `supported_in_api: true`
  and not hidden (`visibility != "hide"`).

Current expected Codex API models from the local cache:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`

Known non-routable examples:

- `gpt-5-5` is a ChatGPT Web-style model ID and should not be routed to Codex.
- `o3` may appear in Web model lists but is not accepted by the Codex responses
  path here.
- `gpt-5.3-codex-spark` exists in the cache but is not exposed when
  `supported_in_api` is false.
- `codex-auto-review` is not exposed when hidden.

## Trae International Official

Credential source:

- Trae International stores official login state under:
  `%APPDATA%/Trae/User/globalStorage/storage.json`
- Auth entries are VS Code SecretStorage / Electron safeStorage encrypted values,
  such as:
  - `iCubeAuthInfo://icube.cloudide`
  - `iCubeAuthInfo://usertag`
  - `iCubeAuthInfo://icube-dc:<device-id>`
- These values are not plain Bearer/API keys. Do not copy them into generic
  OpenAI/Gemini auth headers.

Proxy provider shape:

- Use a dedicated profile/provider:
  - `id`: `trae-official`
  - `protocol`: `trae`
  - `authMode`: `official-login`
  - `targetUrl`: `https://coresg-normal.trae.ai`
- `officialLoginProvider(profile)` must classify this as `trae`, not `openai`
  or `google`.
- `resolveOfficialCredentials` should treat Trae official login as a managed
  local-login provider and should not accept arbitrary client API keys for this
  route.

Model discovery:

- Use Trae's own state DB:
  `%APPDATA%/Trae/User/globalStorage/state.vscdb`
- Read `ItemTable` model cache keys, especially:
  - `<user>_AI.agent.model.model_list_map`
  - `<user>_AI.agent.model.model_list`
  - `AI.agent.modelList`
  - `AI.modelList`
- Prefer the newer per-user `model_list_map` cache over older global keys.
- Expose friendly display names for discovery, but keep a display-to-backend map
  so routes target real Trae model IDs.

Implemented local APIs:

- `/v1/local/trae/status`
  reports whether Trae exists locally, whether encrypted official auth entries
  are present, whether SQLite can be loaded, and how many models were found.
- `/v1/local/models/list`
  returns Trae models from `state.vscdb` with:
  - `source: trae-state-cache`
  - `authMode: official-login`
  - `modelMap` from display names to backend model IDs.
- `/v1/local/route/test`
  validates a requested Trae model against the local cache instead of making a
  fake OpenAI/Gemini upstream probe.

Current local Trae route style:

- Use `trae/` prefix aliases for unambiguous SDK usage.
- Keep key Trae display names as public model IDs when they are what the UI
  shows and do not collide with existing routes.
- Examples:
  - `trae/gpt-5.4` -> `gpt-5.4`
  - `trae/gpt-5.2` -> `gpt-5.2`
  - `trae/gemini-3-pro` -> `gemini-3-pro`
  - `trae/kimi-k2-0905` -> `kimi-k2-0905`
  - `Dola-Seed-2.0-Code` -> `Dola-Seed-2.0-Code`
  - `MiniMax-M3` -> `minimax-m3`
  - `MiniMax-M2.7` -> `minimax-m2.7`
  - `Kimi-K2.5` -> `kimi-k2.5`
  - `DeepSeek-V3.2` -> `deepseek-v3.2`

Generation bridge:

- Trae official generation is now implemented by a local Trae extension bridge,
  not by direct generic OpenAI forwarding.
- Real Trae chat requests go through the renderer/workbench command path into
  `ai-agent`, then through AhaNet to Trae cloud agent endpoints such as
  `/api/agent/v3/create_agent_task`.
- The local bridge listens on `127.0.0.1:17861` and calls Trae's existing
  command `wx.bridge.sendAndWaitResponse` inside the Trae extension host.
- The proxy calls this bridge for Trae official OpenAI Chat, OpenAI Responses,
  and Claude Messages requests, then wraps the result back into the requested
  entry protocol.
- Full operational notes are in `docs/trae-official-bridge.md`.

Implemented local APIs:

- `/v1/local/trae/bridge/status`
  checks whether the local Trae bridge extension is reachable and which Trae
  command it will call.

Important generation constraints:

- Do not call `https://coresg-normal.trae.ai` directly from the proxy for chat
  completions. Direct HTTP misses Trae's Electron Aha IPC, local session context,
  official-login state, and AhaNet behavior.
- Do not reuse AGY / Google official-login adapters for Trae. AGY is Google /
  Code Assist; Trae is its own official client path.
- Current streaming mode is compatibility streaming: the bridge waits for
  Trae's final response and emits protocol-compatible SSE chunks. It is not
  token-level AhaNet streaming yet.

## Route-List Hygiene

Public `/v1/models` should avoid duplicate aliases when a better official
display name exists. Keep compatibility aliases inside conversion logic, but do
not present every alias as a selectable model.

Good public AGY examples:

- `Claude Sonnet 4.6 (Thinking)`
- `Claude Opus 4.6 (Thinking)`
- `GPT-OSS 120B (Medium)`

Avoid exposing duplicate AGY aliases such as:

- `claude-sonnet-4-6-thinking`
- `claude-opus-4-6-thinking`
- `gpt-oss-120b-medium`
- `gpt-oss-120b`

## Debugging Checklist

1. Identify the profile and auth mode: `api-key` or `official-login`.
2. Confirm the credential source being used.
3. Confirm the model-list source matches the generation backend.
4. Confirm the public route model maps to a real backend model ID.
5. Send a small generation request through the actual route.
6. If a model fails, check whether it came from a different upstream product path
   before adding aliases.
