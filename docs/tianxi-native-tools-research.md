# Tianxi tools: closer-to-native integration research

Updated 2026-10-30 (America/Los_Angeles). The user has now requested switching
to the native client-tool adapter. The earlier experiments below remain
historical evidence; the current opt-in deployment is described first.

## Current local switch

A dedicated authenticated gateway binds `127.0.0.1:3096`. It uses the same
Tianxi account and SDK MCP transport, returns the model's raw native tool source
unchanged, and leaves execution and permissions with Codex. It does not execute
Shell or patches itself. The original HTTPS Proxy provider and its model catalog
remain available in the backed-up configuration; the original proxy is not
restarted or replaced by this sidecar.

The default Codex provider is `tianxi_native`, selecting `tianxi/qwen3.8-flash`.
All 12 current Tianxi SDK aliases are exposed through the same bounded native
tool adapter, sourced directly from `TIANXI_SDK_MODELS` rather than a separate
two-model allowlist. Only the selected upstream model ID changes. Default choice
remains Qwen3.8-Flash, independent of catalog order. A regression covers native
call/result continuation and the exact selected upstream ID for every alias
using an injected provider. Qwen3.8-Flash and DeepSeek-Flash additionally have
real Codex CLI acceptance; this does not establish identical model quality or
live all-model acceptance. This is an explicitly requested experimental switch,
not a claim of full desktop or all-model production acceptance.

Runtime configuration, a byte-exact original config backup, proposed config,
model metadata and rollback script are under `%USERPROFILE%/.codex/tianxi-native`.
That directory has an ACL restricted to the current user and SYSTEM. Tianxi
credentials remain in memory/pipes; the saved random local bearer only authorizes
this loopback gateway. `rollback.ps1` checks hashes before restoring the original
configuration so later user edits are not silently overwritten.

### Tools are loaded on demand

With the existing user plugins enabled, Codex's `functions.exec` description
contains approximately 812,000–824,000 characters. Sending the entire description
to Tianxi on every turn is unnecessary. The adapter now retains it locally,
verifies the seven pinned core native tool contracts, sends those contracts
unchanged, and provides an SDK-local read-only documentation tool for bounded
12,000-character pages. It supports text lookup and offsets. All original
documentation remains retrievable byte-for-byte, including MCP/app tools. The
SDK's existing 32 KiB description, 256 KiB catalog and 64 KiB result budgets are
unchanged. This feature is distinct from raising a budget or truncating unknown
tool contracts. Unsupported or changed core contracts fail explicitly.

The live admission measured 12 SDK tool entries and **26,352 bytes** for the
tool catalog, rather than forwarding the original 824,290-character description.
System instructions are separate (44,610 bytes in that run). These are observed
request sizes, not universal constants. Existing plugins/MCP entries are not
disabled by this switch. Documentation availability does not establish that every
external app connection works.

### Sessions and boundaries

Continuation IDs are owned by authenticated local entry, available Codex
`session_id` header and model. Equal initial requests and consumed outputs are
deduplicated; changed output, wrong ownership or changed catalogs are rejected.
The gateway permits four active SDK tasks and 64 retained tasks, with a five-minute
retention limit. Each SDK task retains the existing 180-second deadline and
32-call limit. Disconnect cancels waiting work. Restart discards in-memory pending
tasks rather than claiming to recover them.

A new user turn starts a fresh SDK task from the complete text transcript sent
by Codex. Assistant and tool history remains labelled data, never system text;
this is not identical to a provider with a native role-aware history API.
Historical tool outputs are excluded from the new task's pending-call checks.
Regression tests cover continuation in the second turn, not just its creation.
Opaque reasoning/compaction, image input, automatic truncation, server-side
`previous_response_id` and arbitrary custom grammars remain unsupported. Long
sessions can reach these explicit limits; the adapter is not yet a general
replacement for the complete Responses API.

### Verification

`scripts/probe-tianxi-native-gateway.js` uses the running gateway and loads the
real user configuration, including plugins. It edits a disposable fixture with
actual Codex native command and patch tools and verifies a fresh marker. It
does not modify project files. The initial full-config attempts failed and are
retained. They exposed the oversized tool documentation and a loaded-only catalog
bug: optional `tools` must be omitted, rather than synthesized as `undefined`,
before safe normalization. Both now have regressions.

The subsequent Qwen full-config run passed with an actual file change, exact
marker, exit 0 and no deadline extension:
`.codex-tmp/tianxi-native-persistent-qwen-catalog-fix.json` (147.391 seconds).
The `--defaults` variant tests the saved default provider/model without provider
or model invocation overrides. Desktop app reload and external app operations
must still be distinguished from this CLI evidence.

Both post-switch checks passed:

- Qwen3.8-Flash with saved defaults: 152.935 seconds, actual file change and
  readback, exact marker, exit 0, no deadline extension.
- DeepSeek-Flash through the same persistent gateway: 114.463 seconds, the same
  acceptance checks passed.

Sanitized receipt: `.codex-tmp/tianxi-native-switch-acceptance.json`.
The default configuration and original backup hashes match their receipts.
A hidden current-user Windows Startup shortcut starts the gateway from this
repository after login. Its shortcut was created and checked; logout/reboot was
not performed. Keep the repository at its current path. Gateway process 98636
was healthy after acceptance with zero recorded request failures.
The desktop app must be reopened to load the new provider; this running chat
has not been silently migrated. For rollback, run the installed
`%USERPROFILE%/.codex/tianxi-native/rollback.ps1` and reopen Codex. The rollback
guard refuses to overwrite later configuration edits.

The latest 369 Tianxi/model tests pass. The new tests are discovered by the existing
unified unit-test/CI entry. Focused ESLint, syntax, CI/release governance and diff
checks apply to this increment. The complete frontend/Rust/release/installed-app
suite has not been run; no dependencies or quality thresholds were changed.

The original research record follows.

## Finding

The installed, digest-pinned Qoder CLI supports an in-process SDK MCP channel.
The installed AgentServer SDK registers `sdkMcpServers` during `initialize` and
handles `mcp_message` control requests with a `mcp_response` JSON-RPC envelope.
This is a structured tool channel; it does not parse executable tool calls out
of assistant prose. The proof uses the existing Tianxi account refresh, keeps
credentials in pipes/memory, selects the requested model, and disables Qoder's
built-in tools with `--tools ''`.

The current production read-only path instead uses the native Qoder external-tool
channel and compiles three fixed reading operations into client Shell calls.
The SDK MCP path can carry arbitrary registered JSON-schema tools, including
multiline string inputs. It is a better foundation for preserving Codex's own
tool names, arguments and result continuations without generating read commands.

MCP is the tool transport here. It does not provide a model, execute commands,
or establish correctness by itself. The first experiment uses a fixed fixture
handler. A second, real Codex CLI experiment now returns the model's original
JavaScript to Codex for execution and retains the client's execution controls.

## Live evidence

All successful runs use the same four-call sequence: read a disposable fixture,
submit an exact raw multiline patch, receive an intentional tool error and retry,
then verify the fixture. The final answer must equal a fresh random marker known
only to the verification handler. The handler checks exact patch bytes and order;
it never evaluates model code, accepts user paths, or changes project files.

| Selected model | SDK-observed model | Tool calls | Raw patch | Failure/retry and final marker |
| --- | --- | --- | --- | --- |
| `dfmodel` | DeepSeek-Flash | 4 | exact | passed |
| `qfmodel` | Qwen3.8-Flash | 4 | exact | passed |
| `dmodel` | DeepSeek-V4-Pro | 4 | exact | passed |
| `mmodel` | MiniMax-M3.1-Flash | 4 | exact | passed after fixing probe final-answer classification |

MiniMax's first probe completed all four operations but failed the exact-answer
check, which compared aggregated intermediate commentary and final text. A
regression reproduced this classification bug. The harness now records final
assistant text separately and applies the same exact-marker check to it. The
subsequent live run had 225 aggregate text characters and a 36-character exact
final marker. Keep the initial failed result; it is not evidence that all model
responses always succeed. These runs establish feasibility, not reliability or
latency parity across workloads or all 12 models.

Sanitized local JSON evidence is in `.codex-tmp/tianxi-sdk-native-tools-*.json`.
Only model IDs, counts, methods, lengths and acceptance flags are reported;
prompts, patch contents, markers and credentials are omitted.

Reproduce one paid/live provider run using existing Tianxi credentials:

```powershell
node scripts/probe-tianxi-sdk-native-tools.js --live dfmodel
```

Regression tests are automatically discovered by the unified unit-test entry:

```powershell
node --require ./test/helpers/physical-test-temp.cjs --test test/tianxi-sdk-mcp-experiment.test.js
```

## Real Codex CLI experiment (2026-10-30)

`scripts/probe-tianxi-codex-native.js` starts an authenticated, loopback-only
Responses adapter and the installed Codex CLI 0.160.1. It uses a disposable
workspace and invocation-only provider/model-catalog overrides. It does not
write Codex configuration, change `CODEX_HOME`, restart production, disable
execpolicy rules, bypass approvals, or disable the execution sandbox. Apps and
multi-agent features are disabled for this narrowly scoped experiment.

The actual CLI supplies its native `functions.exec` catalog. The selected Tianxi
model emits raw JavaScript; the adapter returns it as a Responses custom call,
and Codex runs `tools.exec_command` / `tools.apply_patch`. The adapter does not
compile model read operations into shell commands. One SDK task remains pending
across Responses requests while Codex returns each actual tool result.

Earlier runs with the real Tianxi DeepSeek-Flash provider established:

- Codex accepted the original custom call and executed its own Shell tool.
- Text-part array outputs, rather than just strings, resumed the same SDK task.
- Multi-request continuation and the exact random marker check succeeded in
  earlier runs, but edits did not persist. Exit code zero and an exact answer
  therefore remain insufficient for acceptance.
- `apply_patch` reached the native tool and returned explicit permission/path
  rejection. Those earlier runs failed full acceptance; the configuration fix
  and later successful runs are recorded below.

A deterministic injected-provider control also reproduced native patch rejection
with both relative and absolute fixture paths, while using `:workspace`, explicit
`--cd` / `--add-dir`, and trust scoped to the disposable directory. It reports
`realProvider: false`; it isolates the client execution problem and is not
Tianxi acceptance. The exact native error is:

```text
patch rejected: writing outside of the project; rejected by user approval settings
```

The OpenAI repository contains similar Windows reports:
[in-workspace MCP writes](https://github.com/openai/codex/issues/35730) and
[CLI workspace patch rejection](https://github.com/openai/codex/issues/37522).
Those reports concern other versions/entry points; they corroborate a known
failure class, not the root cause of this installation or the original
production incident. No full-access or shell-write fallback was used to turn
the failed patch into a successful acceptance result.

### Root cause correction and successful native acceptance

The isolated CLI used `--ignore-user-config`, which also omitted this machine's
existing `[windows] sandbox = "elevated"` selection. A workspace permission
profile alone does not select the native Windows sandbox implementation needed
by `apply_patch`. Explicitly restoring `windows.sandbox="elevated"` for this
invocation resolved the patch rejection. This enables the existing Windows
sandbox implementation; it does not give model commands administrator privileges
or turn off filesystem/network boundaries. Default user configuration was not
edited and no sandbox setup/reinstallation command was run.

The earlier attribution to a Windows path/version defect was premature. In this
experiment, the omitted sandbox backend explains the rejected patches; the
similar upstream issues do not prove an installation/version regression.
See the [official Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox).

The real Codex client sometimes yields `functions.exec` while a sandboxed tool
continues. The probe now accepts native `functions.wait` only for cell identities
observed in its own returned runtime output, with bounded wait/output arguments.
This scope assertion is not a JavaScript security boundary; the actual client
enforces permissions. The adapter preserves function arguments and task continuity.

| Real Tianxi model | Actual native tools | File changed | Exact marker | CLI exit | Full acceptance |
| --- | --- | --- | --- | --- | --- |
| Qwen3.8-Flash | Shell, apply_patch, wait | yes | yes | 0 | passed |
| DeepSeek-Flash (repeat) | Shell, apply_patch, wait | yes | yes | 0 | passed |

The first sandbox-enabled DeepSeek run changed the file and returned the exact
marker, but the CLI was stopped at the unchanged 180-second deadline and exited
1. It remains a failed run. Successful runs satisfy all criteria, including exit
0; no deadline or acceptance requirement was relaxed. These two passes establish
a bounded feasibility proof, not success rates, all-model support, desktop
acceptance or a production rollout.

An injected-provider diagnostic wrapper remained alive after its CLI had ended.
Probe shutdown now explicitly closes its own outstanding HTTP connections before
awaiting session/process cleanup; a regression uses an unfinished request body.
The precise cause of the original stalled teardown was not fully isolated. The
earlier wrapper was terminated by its verified owned PID after its CLI had ended.
This does not affect the production process.

Reproduced compatibility boundaries have regressions:

1. Accept bounded `input_text` output arrays without accepting image payloads,
   unknown properties or oversized output. Original output shape/type is included
   in replay fingerprints; wrong owner/model, forged IDs, duplicate outputs and
   changed history fail before pending output is consumed.
2. Compare unchanged history independently of JSON member order and message IDs.
   Preserve tool namespaces and raw custom source. New user/developer turns and
   unknown catalog changes are explicitly unsupported rather than dropped.
3. Codex changes the `functions.exec` documentation after execution, adding
   deferred-tool/MCP documentation. Two inspected description revisions are
   pinned by SHA-256. All seven original nested tool contracts are byte-identical;
   checked-in native fixtures verify that fact. Only those revisions compare as
   equivalent; the initial full description still goes to the SDK. This does not
   establish general dynamic tool discovery or arbitrary description updates.
4. In this installed CLI, the older `--sandbox workspace-write` experiment still
   advertised read-only access. The invocation-only `default_permissions=":workspace"`
   configuration advertised workspace-write. The fixture directory alone is
   trusted/added for the invocation. Both the permission profile and native
   Windows sandbox backend are now explicit. A regression ensures that ignoring
   user configuration cannot silently omit the required backend again.

Safe reports include acceptance flags, known error codes, tool names, counts,
and fixed context/shape diagnostics. They exclude credentials, request headers,
prompts, source programs, file contents and the random marker. Test-only injected
providers are explicitly reported as `realProvider: false` and cannot pass live
provider acceptance.

```powershell
node scripts/probe-tianxi-codex-native.js --live dfmodel
node --require ./test/helpers/physical-test-temp.cjs --test test/tianxi-native-responses-adapter.test.js test/tianxi-sdk-mcp-experiment.test.js
```

The successful real-provider reports are
`.codex-tmp/tianxi-codex-native-qfmodel-windows-sandbox.json` and
`.codex-tmp/tianxi-codex-native-dfmodel-windows-sandbox-repeat.json`. Earlier
failed reports are retained, including the deadline failure in
`.codex-tmp/tianxi-codex-native-dfmodel-windows-sandbox.json`. The four-model
fixture successes above must not be described as four-model native Codex acceptance.

Additional official permission references:

- [Permission profiles and legacy sandbox settings](https://learn.chatgpt.com/docs/permissions)
- [Non-interactive CLI permissions](https://learn.chatgpt.com/docs/non-interactive-mode)

Validation of this research increment: 357 Tianxi/model tests passed, including
27 SDK MCP/native-adapter tests. Focused coverage of the adapter, probe policy
helpers and SDK MCP modules is 99.12% lines / 91.59% branches; this excludes the installed CLI and
the live CLI subprocess harness and is not end-to-end production coverage.
Focused ESLint, CI governance and release governance passed. The production
health/model-list read returned HTTP 200 with PID 80220 unchanged and all 12
current catalog aliases present (plus compatibility aliases). No deployment,
production restart or default-provider change occurred. Desktop acceptance and
the complete repository CI/release suite were not run for this increment.
The repository-wide syntax command was stopped after it traversed historical
`.hpm-acceptance` staged payload copies; it did not finish. A separate syntax
check covers all 13 research source/test JavaScript files. No syntax exclusions,
CI rules, coverage thresholds or acceptance requirements were changed.

## What counts as native

Codex's documented custom-provider wire protocol is Responses. Its tools include
JSON-schema function calls and free-text custom calls, including grammar-constrained
inputs. The SDK MCP probe is not a Tianxi-hosted Responses endpoint. No directly
usable, documented Tianxi Responses inference endpoint has been verified in this
investigation. Absence of that evidence does not establish that no such endpoint
exists.

Official protocol references:

- [Codex configuration reference: model providers and wire_api](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Function calling and free-text custom tools](https://developers.openai.com/api/docs/guides/function-calling)

Preferred target: Codex tool definitions → bounded schema/name adaptation → selected
Tianxi model via SDK → structured call → Codex execution → unchanged result → same
SDK task continuation. Tools should retain their actual purpose and arguments;
the adapter should not replace them with three fixed reading operations.

The Qoder SDK still owns an inner agent loop and model request formatting. Even
after successful Codex integration, this path should be called a native client-tool
adapter, not a direct Tianxi implementation of OpenAI's entire Responses API.

## Remaining acceptance before production adoption

1. Expand the bounded real-CLI catalog adaptation beyond the pinned native exec
   description revisions and prove dynamic tool discovery. The original fixture
   experiment uses three fixed definitions; the real CLI experiment uses the
   client's actual catalog.
2. Map SDK structured calls to Responses `function_call` or `custom_tool_call`
   items with the original names and byte-preserved arguments. In particular, a
   string field carrying a patch does not prove arbitrary custom-tool grammar
   support. The real-CLI adapter accepts the inspected nonempty-source Lark
   grammar only for `functions.exec`; unknown grammars are explicitly rejected.
3. Preserve complete instructions and role-aware history. The original fixture
   uses a small standalone system prompt. The real-CLI adapter retains
   initial host instructions but coalesces system/developer text and supports
   only one initial task, not full role/history fidelity, compaction or reconnect.
4. Own pending calls by authenticated entry/profile/model/session, validate output
   IDs, prevent duplicate side effects, and keep the same SDK process while Codex
   returns results. Cover task cancellation, failed execution, large results,
   parallel batches, transport interruption and process-exit confirmation.
5. Validate real Codex Shell, edit/apply_patch, tool discovery and available MCP
   calls through the desktop client. Screenshots and fixture callbacks cannot
   substitute for that acceptance.
6. Compare stability and latency against the existing route under the same workload,
   then add an opt-in route with rollback and retain the current proven path until
   the new route passes. No production configuration was changed by this experiment.

## Harness boundaries

The channel allows at most 128 definitions, a 256 KiB catalog, 32 tool calls,
256 JSON-RPC request identities and 64 KiB text results. It validates tool schemas
and arguments, rejects external schema references and unsafe patterns, snapshots
data without executing getters, denies unknown tools and deduplicates equal
request IDs. Changed replays are rejected. Errors use fixed text. Account identity
is checked before client dispatch and again before results are returned.

The subprocess uses an isolated workspace and the existing CLI digest check.
It only terminates its own child tree. Cleanup follows observed child exit;
unconfirmed exit fails explicitly rather than deleting active runtime files.
Cancellation ends waiting and is passed to the handler. A handler with side
effects must itself honor cancellation; transport cancellation cannot undo an
already completed operation.
