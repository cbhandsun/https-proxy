# WorkBuddy context artifact recovery

## Authorized historical-user archive (2026-10-14)

The ordinary encrypted WorkBuddy Responses-to-Chat route now opts into
controlled archival. This narrowly supersedes the earlier blanket
raw-user-retention contract below. WorkBuddy standalone/trigger local-envelope
compaction now shares the bounded selector as described below; native-provider
state is unchanged. No client-specific Hook is required for this request-local
path. Source implementation is not evidence of production activation.

The shared selector protects system/developer policy, the first human request,
the latest two actual human inputs, caller pins, appended messages and unsafe
tool-exchange intervals. Result-only user messages do not consume those recent
human-input slots. Only exact plain `{role: "user", content: string}` messages
are eligible. Converted Chat inputs may also contain 1-256 exact
`{type: "text", text: string}` blocks with non-whitespace text. Blocks are joined
only for summary citations; stored originals and exact readback preserve the
complete array. Unknown fields, empty inputs and media/mixed messages are
retained. Selection is bounded to 64 originals and 2 MiB per candidate, within a
maximum 16384-message source. Individual storage quotas still apply.

Before removing an eligible original, the existing dedicated summarizer must
produce validated structured state with grounded original-user citations for
every selected source. Requirements use exact source quotes, with existing
revocation and provenance validation. Full original messages are reserved in the
existing artifact transaction. The generated assistant background state carries
an authenticated in-process archive index with locator/scope/digest, original
source positions and `hpm_read_context_artifact` recovery instructions. The
index is not a developer policy, execution approval or verification receipt. The
reader never executes the original external tool. Missing evidence means report
unavailable, do not guess and do not replay.

Only a privately branded index with matching owner, scope, captured source
snapshot, source position and exact original can authorize history replacement.
The private snapshot token retains no full source-history array. JSON clones,
changed markers, foreign identities, changed originals and invalid receipts
cannot. History CAS, strict tool pairing, evidence publication, final byte/token
admission and minimum-benefit checks remain mandatory. Missing coverage, quota
exhaustion, invalid summaries, cancellation, replacement or expired reservations
retain the canonical originals and publish no partial archive.
Deferred/background plans publish only at the existing explicit safe point.
Subsequent narration compaction must retain every older archive-bearing state
unless the bounded, privately authenticated exact-root consolidation below
replaces it. This is not general semantic merging of archived branches.

`userArchiveStatus` is an allowlisted status; `archivedUserMessages` is a
bounded count. Both are available in planning and terminal-outcome diagnostics.
User text, receipts, locators, scope and digests are not added to logs.

This validates grounded references, not semantic completeness: a cited fragment
does not prove that a model extracted every critical constraint from arbitrary
long prose. Real-model summary quality and long-running acceptance remain
`not_verified`. Storage is memory-only with existing quotas/expiry; restart
recovery is not delivered. Ordinary request-local indexes are not transferred to
arbitrary future requests. The authenticated local-envelope path has its own
explicit cross-request transfer contract below. Policy or protected current
input that still exceeds the ceiling is refused, never silently trimmed. The new
path does not promise to recover the previously failed request.

The local regressions exercise exact readback, forged/foreign indexes, source
mutation, malformed references/accessors, quotas, cancellation, concurrent
append/replacement, expired/deferred commits and preservation of prior indexes.
The real handler fixture covers Responses conversion, dedicated summary, archive
publication, WBIPC send, model-requested internal page read and continuation,
without invoking a model, client tool or production configuration. Tests are
discovered by the existing unified unit/CI runner.

### WorkBuddy local-envelope standalone/trigger archive

The encrypted WorkBuddy handler explicitly enables the same bounded archive
selector for its local standalone/trigger bridge. Plain text `{role, content}`
and exact `{type: "message", role: "user", content}` inputs may qualify. Content
may be a nonempty string or at most 256 exact
`{type: "input_text"|"text", text}` blocks, containing non-whitespace text. All
blocks and their original structure are stored intact; citation text joins
blocks exactly as the existing task-state source parser does. Unknown
fields/annotations, other item types, media, empty messages, first/recent users,
policies and unsafe tool intervals remain exact. Selection alone removes
nothing. Native source citations are one-based (`m_1` for input index zero),
reserving `m_0` for top-level instructions; ordinary Chat sources remain
zero-based.

The dedicated summary receives the selected stable source IDs, preserves
constraints and must produce validated original-user citation coverage before
archival. Complete original messages join the existing evidence transaction,
using its hashed owner binding (owner/provider/model/endpoint), receipt kind,
scope, SHA-256 and byte checks. Missing coverage/storage, quota or invalid
receipt leaves all original users in the candidate. No locator enters a summary
cache key; the selected IDs do, so archival and narration-only plans cannot
collide.

Only after final admission, atomic evidence publication and envelope renewal may
the new compact window be returned. Cancellation, expired reservations, invalid
summaries, admission/commit failure and output-transport failure use the
existing rollback/discard paths. Authenticated prior summaries are mandatory and
carried inside the next envelope, even outside the recent assistant tail. Their
original indexes and authenticated receipt leases therefore survive repeated
compaction. Spoofed marker text is ordinary assistant data and grants no receipt
authority. Indexes are retained verbatim; unbounded index consolidation is not
implemented.

This is a local WorkBuddy bridge contract, not permission to modify the
canonical output or opaque state of a native provider. Missing/expired evidence
is reported unavailable; it never authorizes guessing, reacquisition or tool
replay. Storage remains memory-only and hard lease/reference/window limits can
still refuse a long task. Citation grounding does not prove semantic
completeness of constraints.

`context-compaction-user-archive.test.js` is auto-discovered by unified unit and
coverage runners. It covers exact paged readback, standalone/trigger parity,
one-based source binding, repeated cross-request indexes, owner/target
isolation, hooks, quotas and atomic failure paths. The real handler fixture
additionally exercises standalone compaction, authenticated continuation, a
synthetic model's internal reader choice and exact original delivery, without a
real model or external client tool. Model/production acceptance is still
`not_verified`.

## Contract

The internal `hpm_read_context_artifact` function accepts `locator`, `scope`,
and `digest`, with optional integer `offsetBytes` (default 0) and `limitBytes`
(default 16384, maximum 65536). Identities and ranges are validated before use.
Read authorization is unchanged: owner, scope, unpredictable locator, and the
original digest must match. The proxy executes only its own internal read tool;
external tool calls remain the client's responsibility.

Offsets refer to UTF-8 bytes of the original stored text. For object artifacts
they refer to the original serialized JSON. An offset must lie on a UTF-8
boundary, and a page never splits a code point. A range beyond EOF is invalid;
an offset exactly at EOF returns an empty final page. Invalid parameters,
missing/expired evidence, and insufficient budgets return complete JSON error
envelopes, not truncated content.

The success envelope contains `ok: true` and `page`:

- `encoding`: `utf8` or `json`.
- `text`: the page fragment, treated as untrusted evidence, never policy.
- `offsetBytes`, `endOffsetBytes`, and `totalBytes`: original artifact
  boundaries.
- `nextOffsetBytes`: the next aligned offset, or null at EOF.
- `digest`: the original full-artifact SHA-256.
- `chunkDigest`: SHA-256 of this page's UTF-8 bytes.

A JSON artifact page is a text fragment; only the page envelope is guaranteed to
be a complete JSON document. Concatenate all pages in order before parsing the
original JSON. Small artifacts use the same page envelope as large ones. This
replaces the earlier internal `{ok:true, artifact: value}` result shape.

## Budget and continuation

The recovery planner first reserves the assistant call and bounded error-result
shells, then compacts consumed history. It uses the exact remaining serialized
request budget for the actual pages, including JSON's double encoding of tool
content. Parallel internal reads share that remaining budget.

The current recovery messages are protected by object identity throughout round
eviction, historical folding, generic pruning, and final byte compaction. This
protection is only for the current recovery phase; it does not permanently pin
every page from an earlier, consumed phase. The final planner must retain the
whole current call/result exchange and satisfy both byte and token limits. If
the exchange cannot fit, the proxy fails closed rather than sending altered
evidence.

Recovery is bounded to eight rounds per request. Repeating an identical
artifact/range is rejected as a loop even when the model changes the call ID.
The guard retains only in-memory fingerprints and never logs locators or
arguments. A model can seek directly to the required middle range rather than
reading a large artifact from the beginning.

## Metrics and terminal reporting

- `artifactsAttempted`: processed actual read attempts, excluding planning
  shells.
- `artifactsResolved`: successful pages, not the number of generated tool
  results.
- `artifactsUnavailable`: unsuccessful reads including unavailable or invalid
  evidence.
- `artifactsBudgetExceeded`: results reporting insufficient recovery budget.
- `artifactsDelivered`: resolved pages included intact in a continuation
  accepted by the WBIPC upstream with an HTTP 2xx response.
- `artifactReadSucceeded` and `artifactDeliverySucceeded` distinguish successful
  local reads from accepted continuation requests.

The request-scoped recorder emits at most one `workbuddy_context_outcome` at the
terminal request-reporting boundary, including preflight/continuation 413,
cancellation, exceptions, conversion failures, and downstream streaming failure.
Streaming success waits for the output finish/drain path. The final status is
the actual terminal status, not an earlier successful upstream tool-call turn.
Only bounded counters and allowlisted terminal codes are logged; page text,
credentials, locators, scopes, and digests are excluded.

These metrics are transport/recovery evidence. HTTP 200, `finalOk`, or
`terminalCode: completed` is not proof that the user's business task completed
correctly, nor that a model used the delivered evidence correctly. A Responses
`incomplete` terminal can still have HTTP 200.

## Mixed internal/external parallel turns

The WBIPC Responses route separates a mixed parallel turn into a request-local
recovery phase. It validates the whole original turn before any artifact read:
unique bounded call IDs, function-call shape, external names actually offered in
the request, and complete JSON-object argument strings. At most 16 calls are
accepted, with at most eight internal reads. External argument strings are
bounded to 1 MiB each and copied exactly, including whitespace and Unicode.

The proxy holds the original external calls without executing them. Only its
internal artifact tool is offered during recovery, with `tool_choice: auto` and
a fixed, content-free phase instruction. Internal calls and results remain
paired in history; no unresolved external call is sent to the recovery model.
The phase instruction is removed before history is remembered. Original tool
definitions and choice controls are restored for subsequent client turns.

After all requested reads succeeded and a valid internal-only continuation
returns a `stop` acknowledgement, only the original external calls are released
to the client, in their original relative order, with unchanged IDs and argument
strings. The acknowledgement is private, not a user-facing answer or an external
tool result. The ordinary Responses conversion/history path retains the internal
exchange and the released external calls for `previous_response_id`
continuation. `store: false` still disables Responses-history persistence; it
does not gain a hidden response-ID cache through this mechanism.

Unavailable/invalid evidence, insufficient budgets, duplicate/reused call IDs,
read loops, cancellation, upstream errors, malformed or truncated responses, and
unexpected external calls during the private phase fail closed. None release the
held external calls or manufacture their outputs. Pure external turns are
unchanged; the lower-level artifact continuation still accepts only internal
calls, so it cannot silently drop external work if used without this phase.

This preserves a parallel turn, not a dependency graph or semantic replanner. If
external arguments depend on recovered evidence, the model must request an
internal-only read before generating the dependent external call. The proxy does
not rewrite an already generated external call using later evidence. A
successful acknowledgement/delivery is not proof of business correctness.
Original tool-turn usage is retained; this phase does not introduce aggregated
billing accounting for all hidden recovery rounds.

## Evidence leases and quota isolation

The default idle lease is 30 minutes. Successful full/page reads, or an explicit
owner/scope/locator/digest-checked `renew`, extend it without changing the
locator or digest. The default hard lifetime is two hours from creation;
configuration can extend it up to 24 hours, never below the idle lease. A failed
read, invalid range, budget error, or wrong digest cannot renew evidence.
Expired receipts cannot be resurrected. Clock rollback or an invalid clock
clears retained records and refuses admission until the clock is valid again.

The default scope quota is 4 MiB / 64 records; the provider-profile quota is 8
MiB / 128 records, within the unchanged global 16 MiB / 256 record limit and 1
MiB item limit. Effective byte quotas are at least the configured item limit;
scope quotas cannot exceed owner quotas, which cannot exceed global quotas.
These are artifact-scope quotas, not proof of stable task/principal identity.
Creating fresh scopes cannot bypass the profile quota.

Live receipts are no longer FIFO eviction candidates, even for the requesting
scope. Admission failure returns no locator, preserves all live receipts, and
uses the existing `rerun_or_reread_original_tool` receipt directive. Expiration,
authorized discard/session discard, or `close` releases capacity. Expiration
cleanup remains lazy on store operations; it is not a timed physical erasure
guarantee for an idle process. `close` clears all retained content immediately.

The internal tool description asks for original-source reacquisition with
permitted tools or an explicit unavailable report, never invented evidence. The
proxy does not execute external tools to reacquire evidence, automatically rerun
potentially side-effecting commands, or infer a business task's completion.
Merely mentioning a receipt does not renew it; only successful access/explicit
renewal does. This batch does not add a task heartbeat.

## Capacity learning from every accepted dispatch

Each WBIPC dispatch with `ok: true` and an HTTP 2xx response records the bytes
actually sent, including intermediate artifact/mixed-phase continuations. It
does not wait for final conversion or task success. A later rejection preserves
up to eight recent accepted sizes per key, for five minutes, and uses the
largest sample below the latest rejection margin as a floor for the conservative
reduction. Older or future-dated samples are ignored. The configured ceiling and
latest rejection/probe ceiling still apply; success does not renew a rejection's
TTL. The learning cache defaults to 256 keys (configurable up to 4096); adding a
key cannot grow it without bound. Evicting capacity knowledge is not
evidence-store eviction and does not invalidate artifact receipts.

This fixes the observed 234606-byte acceptance followed by a 241295-byte
rejection incorrectly shrinking the local target to 168906 bytes and blocking a
smaller 212211-byte request. The successful floor prevents that local lockout;
it is not a promise that a differently shaped request or all later recovery
pages will be accepted. The host's actual `E_PAYLOAD_TOO_LARGE` remains a
fail-closed boundary.

## Explicit client-owned full-history recovery adapter

The proxy's local-compaction replay failure can return
`error.recovery.action: resend_full_history` with
`replay_external_tools: false`. This remains a proxy-specific error contract,
not a native Codex automatic-retry hook. The user authorized an independent,
explicitly enabled client adapter on 2026-10-11. The implementation is
`lib/client/context-recovery-client.js`; it is not loaded by the proxy or
injected into installed Codex. Restarted/expired proxy state cannot be recovered
from an unreadable local checkpoint alone.

The adapter defaults to `enabled: false`. A client explicitly supplies its
already-authorized loopback `/v1/responses` endpoint, model, provider-profile
identity, thread identity and existing local-proxy authorization headers. It
does not read credentials/configuration, provision keys, select a model, rewrite
policy or gain authorization from those identity labels. Actual gateway
authorization and host channel approval remain necessary.

Enabling recovery now also requires `targetBinding`, obtained from the client's
already-authorized resolved gateway configuration. Its exact fields are `owner`
(profile ID), `provider: workbuddy-wbipc`, `model` (resolved upstream model, not
necessarily its client alias), and `endpoint` (the normalized
protocol/host/port/path used by the gateway). The client sends only a versioned
digest in `x-hpm-context-target`; no target credential is part of this binding.

The proxy's central dispatch checks that pin against the actual authenticated
prepared WorkBuddy/WBIPC profile/model/endpoint before every dispatch, including
recovery and ordinary failover attempts. A different profile, endpoint, model,
provider or credential mechanism returns content-free HTTP 409
`context_target_mismatch` before a provider handler runs. The header is stripped
from forwarded headers, and the proxy acknowledges successful pin validation in
its response. The client refuses automatic recovery unless that response
acknowledgement matches its pin; old gateways which ignore the header cannot
silently trigger a full-history resend. Other endpoints and the direct-body
forwarding bypass cannot evade this check.

This is route pinning, not additional authentication or an atomic pin of the
underlying WorkBuddy account/session identity. Existing entry authorization, the
host's approved channel and its actual account permissions still apply;
arbitrary owner/thread labels and digests do not grant them. Gateways without
this route-pin implementation are not certified for automatic recovery.

Before sending a compacted request, the trusted client captures the complete
original input for that exact request. `complete: true` is the client's
provenance assertion, **not proof that an opaque checkpoint contained those
originals**. The adapter cannot detect an omitted pre-compaction prefix that the
client falsely claims was complete. Integrators must retain originals from
before compaction, including every current-turn/revocation item; never populate
this field from `thread/resume`, a generated summary or guessed tool outputs
alone.

Capture validates bounded plain JSON without invoking getters or `toJSON`,
policy roles, supported message/media shapes, unique complete function/custom
tool call/result pairs, and ordered exact presence of retained wire-input items.
Foreign opaque compaction and compaction triggers are unsupported for recovery.
The in-memory capability binds the entire request, including instructions, tools
and controls, to this client instance. Changes to request/model/thread/
profile/endpoint require a fresh capability. No history is written to disk or
sent to the proxy until the explicitly authorized rebuild.

Each client holds at most 16 snapshots and 8 MiB of serialized original input.
Each original/rebuilt request is capped at 2 MiB (configurable only downward),
2048 original items and the shared JSON parser's depth/node bounds. Admission
refusal does not evict valid history. Call `discard` after request completion
and `close` at client-session end; no timed physical erasure is promised.

Recovery allows **one** additional dispatch for an allowlisted 400/502 JSON
compaction error containing both `resend_full_history` and
`replay_external_tools: false`. It replaces `input` with exact originals and
removes stale `previous_response_id`; every other request field, policy role,
call/result ID, argument string, model and endpoint is retained. The second
response is returned even if it fails again. Missing/discarded history,
concurrent duplicate sends, cancellation, unsupported input and quota failures
fail closed. There is no external-tool executor.

Successful SSE responses are returned untouched. SSE failures after HTTP 200,
ordinary errors, network failures, timeouts and unapproved-channel errors never
trigger replay. Redirects are refused. Error inspection is bounded to 16 KiB /
five seconds; transport exceptions have content-free messages. A caller
`AbortSignal` covers both dispatches and stream consumption.

Client integration (CommonJS, Node 22; existing auth stays in memory):

```js
const {
  createContextRecoveryClient,
} = require('./lib/client/context-recovery-client');
const client = createContextRecoveryClient({
  enabled: true,
  endpoint: authorizedLocalResponsesUrl,
  model: currentModel,
  owner: authorizedProfileId,
  threadId: currentThreadId,
  targetBinding: authorizedResolvedWorkBuddyBinding,
  headers: existingLocalProxyHeaders,
});
const history = client.capture({
  request: currentRequest,
  originalInput: clientOwnedCompleteOriginalInput,
  complete: true,
});
try {
  const response = await client.send(currentRequest, { history, signal });
  await consumeResponseWithoutAutomaticallyExecutingTools(response);
} finally {
  client.discard(history);
  client.close();
}
```

Supported originals are Responses messages and complete function/custom-tool
exchanges. Unsupported native tool types, opaque reasoning and chat-format tool
messages are rejected rather than heuristically reconstructed. Normal native
compact output must still be used unchanged; this adapter is not a substitute
for OpenAI's opaque-state handling. The implemented repository adapter does not
certify adoption by installed Codex or actual host-approved task completion.

Official
[Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
documents `thread/resume` as reopening a stored client thread. It does not
establish automatic handling of this proxy-specific recovery action or that the
client's stored history still includes all pre-compaction evidence. Official
[OpenAI Compaction documentation](https://developers.openai.com/api/docs/guides/compaction)
requires passing the entire standalone compact output as the canonical next
window; do not substitute an arbitrarily edited local history for native opaque
state. Client integration and actual host-authorized completion therefore need
their own acceptance, separate from local protocol fixtures.

## Deliberately unchanged boundaries

Artifact storage is still in memory. Restart loses old receipts; durable restart
recovery is not implemented or enabled. It requires explicit opt-in retention,
protected key management, authenticated encryption, bounded disk quotas/expiry,
and corruption/I/O/concurrent-writer handling. Do not reuse
credential-encryption fallbacks that could expose content or store a plaintext
key beside ciphertext. Missing or expired evidence returns unavailable, never a
fabricated page.

Owner remains the provider profile, not a separately authenticated tenant or
task principal. Mixed parallel turns are supported on the WBIPC Responses route
through the bounded phase above, not by proxy execution of external tools. Local
standalone compaction bridging and structured task-state extraction are
implemented; their current evidence and remaining actual-client/model gates are
tracked in `context-compaction-delivery.md`. No third-party summary envelope is
represented as OpenAI-native encrypted compaction state.

## Regression entrypoints

### Bounded WorkBuddy task-state fallback

An oversized original history must not prevent semantic task-state planning just
because archived tool messages exceed the 2048-message source limit or immutable
policy exceeds the 192 KiB source limit. The single-request path is unchanged
when it fits. Otherwise, the planner selects original user text and eligible old
assistant narration, excluding raw tool evidence and policy that remains
verbatim in the main request. User messages, recent work and unsafe/incomplete
tool intervals are not removed by this fallback.

`workbuddy-task-state-summary.js` admits every chunk before dispatch, including
a worst-case carry reserve, against the existing byte/token budgets. It permits
at most 16 summary requests, 2 MiB of selected source text and 8 MiB of
aggregate request bytes, within the unchanged coordinator deadline. An
indivisible source that does not fit is refused, not sliced. There is no
automatic summary retry. Additional chunks can consume additional model usage
only when this code is activated; local regression fixtures do not call a model.

Each chunk retains original message positions as citation IDs. Positions are
identifiers rather than a retained-message count: retained source count/byte
limits remain unchanged. Incremental carry can cite only registered original
sources, retaining exact prior requirements and chronological user revisions.
Only sources cited by validated state remain in the carry capability; this does
not convert prior model text into a user or policy source. Cancellation,
invalid/forgotten requirements, provider failure, stale history or rejected
final admission never publishes partial state or evidence.
`taskStateSummaryChunks` records the planned chunk count, not model success or
actual billed calls.

Capacity learning now preserves recent accepted requests strictly smaller than a
rejected request even when their sizes differ by less than the transport probe
margin. The margin still limits unproven probes. Equal/smaller rejection,
configured ceilings, profile/model isolation, accepted-sample expiry and learned
capacity expiry still apply. A restart is not required to expire old capacity
learning; activating edited source remains a separate production operation.

`workbuddy-task-state-summary.test.js` is auto-discovered by the unified unit/CI
and coverage entrypoints and covers chunking, stable source IDs, revocation,
source capability safety, cancellation, invalid/future references, input and
aggregate budgets, and visible producer failures. Task-state planner and
capacity-controller regressions cover the concrete long-history/policy and
near-rejection acceptance failures. These fixture results do not certify the
failing production conversation or real-model behavior.

`context-artifact-page.test.js`, `context-artifact-tool.test.js`,
`context-outcome-metrics.test.js`, `workbuddy-context-recovery.test.js`,
`workbuddy-context-recovery-route.test.js`, and
`workbuddy-responses-flow.test.js`, together with
`workbuddy-mixed-tool-phase.test.js` and `workbuddy-mixed-tool-route.test.js`,
`context-artifact-lifecycle.test.js`, `context-capacity-controller.test.js`, and
`workbuddy-context-capacity-route.test.js`, are discovered by the unified unit
and coverage entrypoints. They cover Unicode/escaping, ranges,
digest/owner/scope rejection, TTL, low budgets, middle-range recovery, multiple
reads, read loops, actual delivery counters, cancellation, conversion failure,
413, and terminal uniqueness without an upstream call or credentials. Mixed-turn
tests also exercise JSON and SSE output, real Responses conversion and history
continuation, exact external arguments/order/IDs, multiple private reads,
partial read failures, transient-policy removal, and `store: false`.
Lifecycle/capacity tests add idle renewal/hard expiry, failed reads not
renewing, profile/scope/global entry and byte quotas, no eviction on denied
admission, authorized cleanup, closed/restarted memory stores, clock anomalies,
original source reacquisition directives, recent/stale accepted capacity
samples, and an accepted continuation followed by rejection and a smaller next
request.

## Assistant progress inside a recorded tool batch

WorkBuddy admission now repairs assistant-only progress interleaved with outputs
for an already recorded call in the same batch. Distinct outputs remain ordered
and conflicting/error records remain explicit; identical records may be
deduplicated. Progress messages retain their exact content, role and relative
order after the paired tool results. A tool-side annotation records original
output message indices and a bounded range of deferred progress, so normalized
placement cannot be mistaken for the original chronology or proof of success.
Already canonical history is returned unchanged.

This is not general history reconstruction. User, system and developer messages
and explicit empty call lists remain hard boundaries. A new batch cannot supply
missing results for an incomplete earlier batch; the narrow completed-call
supplement exception is described below. Unknown calls, missing results, reused
call IDs, malformed content, unsafe object hooks and existing
count/traversal/byte limits still reject the request. No tool is executed or
retried. Final provider preparation and every native send continue to validate
strictly without performing a repair.

Safe diagnostics add only the numeric `deferredAssistantMessages` count and a
fixed rejection `phase`: `converted_history`, `provider_preparation` or
`wbipc_send`. Call IDs, fingerprints and content are not logged.
`workbuddy-tool-history-interleaving.test.js` is discovered by the unified
unit/CI and coverage runners; the Responses-flow fixture also checks conversion,
compaction, the mocked native send boundary and content-free diagnostics. These
tests do not establish that a particular production screenshot was caused by
interleaving, or certify recovery of the original conversation. Production
activation and real-model acceptance remain separate checks.

## Content-free rejection structure diagnostics

Rejection logs now contain `historyDiagnostics`: bounded message/call counts,
the first failing message index, and (when known) the matching call's original
index, number of recorded outputs, and the index/type of the boundary that
closed its batch. `orphanRelation` distinguishes `no_prior_call` from
`closed_call_batch`. A missing result also identifies its closing boundary,
including `end_of_history`. These observations do not relax admission or repair
history across a user/policy/new-call boundary.

At `converted_history` only, `conversionDiagnostics` counts recognized source
call/output items and converted chat calls/results. It reports how many source
and converted calls match the failing result without logging their identifiers.
This includes nested chat-style calls and source calls without explicit names;
an unnamed source call is not itself proof of conversion loss because existing
name inference may succeed. First matching indices refer to their respective
arrays, not a shared time sequence. `usesPreviousResponseId` distinguishes a
request that may incorporate process-local continuation history, so raw and
converted totals must not be compared as an unconditional conservation rule.

Inspection reads own data descriptors, never invokes getters or `toJSON`, and
does not traverse output text, arguments, policy, or media. A shared
262144-entry scan budget bounds work; `sourceScanComplete` and
`convertedScanComplete` are false when inspection is incomplete. Partial counts
cannot prove that a call is absent. Only fixed labels, booleans and bounded
integers leave the diagnostic module. Names, IDs, hashes, locators, credentials
and content are excluded. No request body is captured, old chat file is opened,
or external tool is executed/replayed. Diagnostics are server-side, not added to
the client error payload.

`workbuddy-tool-history-diagnostics.test.js` is auto-discovered by the unified
unit/CI and coverage runners. It tests source/converted correlations, every
closing boundary, end-of-history failures, empty/invalid/maximal structures,
shared scan exhaustion, getters/hooks, safe error extraction and non-mutation.
The Responses-flow fixture verifies the same metadata at rejection and proves
that invalid histories never reach the mocked native transport. These tests and
a healthy restarted process do not establish recovery of the failing production
task; a fresh affected-client request is needed for correlation.

## Late supplemental outputs after a subsequent tool-call batch

A fresh production rejection (`d216e7145e26`, 2026-10-14T15:12:49.309Z) reported
complete source/converted scans: 4318 call records, 4599 result records, one
uniquely matching call and two matching results. The failing result at converted
message index 9023 matched the completed call at index 9019, whose first result
preceded the next call batch at index 9021. No previous-response cache was used
and conversion retained the matching call. This identifies the rejection as an
overly strict completed-call/new-batch boundary, not evidence of lost calls or a
compression failure. It does not explain why the client produced two results, or
establish that either result proves tool success.

Repair now retains a request-local capability for an already complete batch's
globally unique calls across subsequent call batches in the same uninterrupted
assistant/tool segment. A supplemental result must match that capability; all
existing data/fingerprint/resource checks and the 64-result-per-call ceiling
still apply. It is combined into the original paired result. Distinct records,
their source indices, errors and disagreement are retained; identical records
may be deduplicated. Subsequent calls and their arguments/order are unchanged.
An explicit note says that normalized placement is not original chronology and
cannot imply that later calls or narration observed outputs recorded later.
`lateResultsAcrossCallBatches` records the count, without identifiers/content.

User/system/developer messages and explicit empty call lists revoke every such
capability. Missing results before the next batch, unknown calls, reused call
IDs, malformed data and exhausted limits still fail closed. Strict provider and
native-send validation performs no such repair. No call or result is invented,
and no external tool is executed or replayed by the proxy.

Locally generated qualification and record-status notes have non-wire WeakMap
provenance, retained only on unchanged notes and exact checked history clones.
Client marker text cannot acquire it. Byte-fallback folding reserves those notes
intact and includes their bytes in final hard admission; it can refuse an
impossible budget, never crop away the causal/error qualifications to fit. This
does not permanently pin a historical exchange: complete old exchanges may still
be archived/evicted normally, including their full recorded notes.

`workbuddy-tool-history-late-results.test.js` and
`workbuddy-tool-history-notes.test.js` are auto-discovered by unified unit/CI
and coverage runners. They cover late/parallel/repeated/conflicting records,
ordering, idempotence, immutable originals, revocation, missing/ambiguous calls,
limits/hooks, exact clone provenance, marker spoofing, hard-budget refusal and
conversion/compaction composition. The Responses-flow fixture exercises a mocked
native dispatch retaining both records and intact qualifications. Production
activation and original-client continuation are separate checks.

## Required policy/user context lower bound

### Bounded exact archive-root consolidation

Adjacent genuine archive-bearing states can share a flat root without losing
their original snapshot-local namespaces, requirements, revisions or evidence
receipts. Existing fitting roots keep version 1; only an otherwise oversized
candidate attempts version 2, interning exactly equal state entries and retaining
every occurrence. Both decode to the same original payloads. The root stays at
32 KiB, with a separate 2 MiB aggregate expanded-data ceiling. Exact escaped
UTF-8 byte counting precedes canonical fingerprint allocation, so small indexed
roots cannot trigger unbounded expansion before refusal. Irreducible roots
remain unchanged rather than silently losing state.

If a complete genuine archive-state run cannot fit one root, bounded partition
fallback can retain multiple flat exact roots instead of abandoning all possible
consolidation. It splits only at original message boundaries, keeps no-gain or
indivisible originals, and preserves the same whole-run 2,048-snapshot/2-MiB
source admission limits. Identity-deduplicated collection avoids repeated large
flattened arrays. Each attempted encoding charges its source bytes against the
derived logarithmic-level work ceiling; overlap consumes that allowance again.
Exhaustion retains exact originals rather than expanding resources or dropping
state. Final request admission and history/evidence publication remain atomic
across all subgroup replacements. Synthetic regressions verify eight exact
snapshot/readback pairs, cancellation/publication rollback, policy disablement,
barriers/pins and the 64-message overlap work limit, with zero model requests.

Only existing private history/source/owner/scope capabilities authorize this
consolidation. Decoding, marker replay and JSON clones grant none. Policy/user
barriers, caller pins and pending-tool intervals cannot be crossed. Original
receipts remain subject to expiry and exact scoped reads; this does not persist
evidence across process restart or reconcile every previously compacted branch.
The synthetic planner/history regression verifies exact payload round trips,
original readback, repeated consolidation and denied foreign reads with zero
model requests. Real-provider semantic and production acceptance remain separate.

### Runtime-review integration and recovery progress

The 2026-10-15 runtime review is reconciled in
`docs/context-compaction-delivery.md`; its traffic counts are not fresh acceptance
for the current source. Fixed summary-failure reasons, safe phase/chunk timing,
growth reserve, exact-input cooldown and validated semantic progress reuse belong
to this existing recovery path, not a second compaction mechanism.

Timeout-resumable progress is computation only. A full checkpoint entry quota
now permits a strictly farther source-matched prefix to replace older matching
uncommitted progress atomically, without evicting committed/foreign entries,
regressing on a late save, renewing TTL or borrowing byte capacity. A later
request still reparses the state against fresh exact sources. Successful
history/evidence publication remains separate; failed or cancelled planning does
not publish archives. Default and one-entry synthetic regressions verify two
timeouts followed by complete history/evidence recovery and ten exact-original
readbacks, with no original tool execution or replay.

The evidence store is memory-only. Its default 30-minute idle lease can be renewed
only through the authorized lifecycle path and remains bounded by a two-hour hard
lifetime; process restart loses it. Missing evidence is explicitly unavailable,
never inferred or regenerated by replaying a side-effecting tool. Durable restart
recovery, fresh real-provider semantic acceptance and version-bound production
activation remain open, separately authorized work.

### Lower-bound safeguard

This section describes the lower-bound-only safeguard. Separately authorized
controlled historical-user archival can now replace eligible older originals
with source-covered structured state plus exact, scoped readback evidence; it
does not weaken policy/current-input protection. The integrated delivery ledger
is `docs/context-compaction-delivery.md`. Timeout-resumable semantic progress is
only computation reuse, never an archive receipt or permission to drop a user.

Main-request compaction and task-state summaries preserve system/developer
policy and original user messages unchanged. Completed tool exchanges and old
narration can be archived, but repeatedly shrinking those cannot admit a request
whose required policy/user messages alone exceed the hard byte or token ceiling.
Result-only native user/tool exchanges are not counted as original user
requirements; mixed messages and empty user inputs are counted. Legacy user-role
checkpoints that the existing planner validates and may rebuild are excluded
from this conservative bound too. This does not grant provenance, change
retention or prove fit; invalid marker strings remain ordinary user input.

The planner reports numeric, content-free `requiredContextMessageBytes`,
`requiredContextEstimatedTokens`, policy/user message counts and their
serialized bytes. Array framing/separators are included in the combined byte
measurement. Tools, request controls, checkpoints and all other messages are
excluded: this is a conservative lower bound, never a complete candidate or
proof of fit. Unknown/unsafe data, resource exhaustion or an incomplete
measurement reports `requiredContextMeasured: false` and cannot justify a
lower-bound rejection. Measurement reuses the bounded data-only validator and
executes no getters, coercion or `toJSON` hooks; no text, names, IDs or
credentials are logged.

A measured lower bound exceeding either hard ceiling is classified as
`required_context_too_large` (policy-only byte overflow retains the existing
`immutable_context_too_large` classification). A narration summary cannot reduce
these required messages, so task-state preparation skips that futile model
request and repeated working-set planning. `workingSetPlanningSkipped`
distinguishes this early rejection from a failed compacted candidate; the
original request remains the measured final body in that case. Invalid summaries
remain rejected normally when a summary could help. Hard limits, raw policy/user
retention, evidence/history rollback and strict tool-pair admission are
unchanged. Client 413 responses keep the existing code and original-body
measurements, add attempted-candidate and required-context numeric measurements
when available, and explain this distinct boundary.

Production request `1ba80b34917e` (2026-10-14T15:52:45.992Z) reached context
planning after the late-result repair. It attempted to evict 4315 completed tool
rounds but its candidate was 432281 bytes / 102658 estimated tokens against
393216 bytes / 98304 tokens. Policy alone occupied 248029 bytes. The task-state
summary candidate was invalid and history/evidence transactions rolled back.
These logs do not contain the exact remaining user-context byte breakdown; the
new lower-bound classification of that original request is not yet verified.
Synthetic pressure tests reproduce the old generic refusal and futile summary
and verify the new classification/short circuit without inspecting old chats,
contacting a model or replaying any external tool.

`workbuddy-required-context.test.js` and the Responses-flow regression are
discovered by the unified unit/CI and coverage runners. They cover exact bytes,
Unicode/escaping, empty/invalid/extreme structures, marker spoofing, safe hooks,
byte/token pressure, mixed/result-only users, transactional rollback, a useful
summary path and local 413 without native dispatch. This repair improves
classification and avoids unnecessary summary work; it does not authorize
archiving original user requirements or certify recovery of the affected task.
