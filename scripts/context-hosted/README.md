# Runner-local context recovery scenarios

These repository-owned fixtures promote the reviewed N08/N09 prototypes. They
use the current checkout and a payload built on the disposable Windows runner.
Local acceptance directories, historical absolute paths, old installer
artifacts, credentials, databases and certificates are not inputs.

The ordinary unit discovery includes `test/context-hosted/*.test.js`, so
`npm run test:unit`, coverage and `npm run verify` run the pure regressions.
These include the original boundary/protocol/cleanup cases, actual-source
closure pin collection without execution, runtime-lock pruning and tamper
controls, and PowerShell parsing without module import. They do not qualify a
real daemon.

`.github/workflows/windows-context-recovery-hosted.yml` runs N08 and N09 on
separate `windows-latest` runners. The workflow requires unified verification
and dependency audit before each runtime job. After those gates:

```powershell
node scripts/prepare-context-hosted-run.js n08
./scripts/qualify-context-hosted.ps1 -Case n08
```

The original N09 job uses `n09` in both positions. The independent sending and
transport-finished ACK jobs use `n09-sending-ack` and `n09-finished-ack`
respectively in both positions. The cancellation terminal jobs use
`n09-withdrawn-ack` and `n09-uncertain-ack` in both positions. The additional
COMMIT-interior jobs use `n09-sending-commit`, `n09-finished-commit`,
`n09-withdrawn-commit` and `n09-uncertain-commit` in both positions. The prepare
command checks the exact GitHub source SHA and tracked source hashes, observes
the actual `npm run release:prepare` exit, then creates a fresh
`$RUNNER_TEMP/hpm-context-n08`, `hpm-context-n09`, or
`hpm-context-n09-sending-ack`, `hpm-context-n09-finished-ack`,
`hpm-context-n09-withdrawn-ack`, `hpm-context-n09-uncertain-ack`, or one of the
four corresponding fixed `hpm-context-n09-*-commit` directories. Each permitted
name is explicitly enumerated; the executable guard does not accept a glob. The
payload's schema-2 manifest, executable, source hashes, release layout and
production dependency lock are verified before the fixed review plan is written.
A collision fails and preserves the existing directory.

Source package-lock and runtime package-lock are different artifacts: production
staging intentionally removes development dependencies. `runtime-lock.js`
validates the projected runtime package/root and each retained package's source
identity and dependency metadata. The source lock remains bound to the exact
checkout; the runtime lock remains bound to the actual payload manifest hash. A
wrong integrity, version, dependency, missing direct package or injected package
rejects.

The fixed shell entry accepts only the scenario enum. Existing hosted-network
code owns port 443, generated CA/leaf material, temporary hosts mapping and the
payload executable's non-loopback firewall block. The negative probe uses an
address actually assigned to the same VM and a PowerShell positive witness. The
original `Invoke-HpmBoundedRuntimeChild` retains its 120000ms deadline, one-byte
stdin grant, bounded pipes, StopAndWait(5000) and kill-on-close. Original
per-daemon control, protocol and deadlines remain unchanged. TLS validation
stays enabled with a pinned runner-local CA. No upstream model account is
contacted.

N08 exercises the six mutation/hold cases, actual business output-byte
observation and authenticated committed before/after root, expiry and
cumulative-budget checks. N09 first uses six distinct private adapters:
committed metadata observation followed by forced kill/restart/read; actual
await-clearAsync ACK followed by forced kill/restart plus four policy
combinations; separate save and revoke durable-ACK cases; same-format backup
rollback after revocation; and forced interruption with the upstream public
final held after a private READ. The outer composition checks each adapter's
observed seed/read/public/ACK counts and single original tool execution.

The fixed child receipt is accepted only after its own cleanup and the original
outer Job's verified cleanup. Failed stop acknowledgement retains firewall
containment; the disposable runner must be discarded. Only fixed receipts and
bounded scope text are printed. No payload, key, database, request body or
original evidence is uploaded.

When the first recovery reaches public generation without an observed READ, the
failed HTTP response may trigger one owned local health query. Only fixed
aggregate-counter classes leave the adapter: 200 means an unavailable binding
was counted, 202 means at least four requests were bound, and 210 means fewer
than four were bound without a counted unavailable binding. Malformed or
conflicting diagnostics remain 224. These counts belong to a fresh isolated
owner with three seed/summary requests; they do not identify a root cause.
Successful recovery and the durable-ACK-to-kill boundary perform no such query.

Failed ACK handshakes preserve a finite stage through the signed mailbox and
local wrappers. Stages 140/141 identify command-file reading/verification;
142/143/144 identify runtime binding, root/expiry identity, and
producer-revision mismatch; 145/146 identify revoke execution and a rejected
completion result; 147 identifies original save observation; 148/149 identify
receipt validation and publication; 150/151/152 identify client
submit/bootstrap-file checks, armed-control checks, and receipt checks; 153
identifies the unchanged 15-second operation budget or invalid clock; 154/155
identify command validation and synchronous client-method failure; 156/157
identify host dispatch and awaited hook rejection. A known inner stage survives
wrapping. A stage is diagnostic only: no receipt, signature, identity,
accounting, timeout or cleanup assertion is relaxed. Arbitrary exception
properties and text are never inspected or forwarded; the optional failure stage
is authenticated in the control signal. An existing failed recovery HTTP phase
retains priority over secondary polling failure. A stage identifies where
rejection was observed, not necessarily its root cause.

Committed metadata observation is not a host save/revoke durable ACK. The
separate `runDurableSaveOrRevokeAfterAck` driver requires a passive, synchronous
callable capability, validates its operation/PID/accounting-bound ACK, then
force-kills without intervening adapter I/O. Save checks exact reads and
nondecreasing accounting after same-directory restart; revoke checks denial
before and after all four policy combinations. Its receipts explicitly remain
`adapter-orchestration-only`; a pure test alone grants no live qualification.
The hosted business adapter supplies the capability through the runner payload's
runtime hooks and private mailbox. A boolean advertisement, HTTP completion or
committed-file observation cannot enable it. The `n09-ack` contract and observer
validate signed, PID/epoch/sequence bound commands and receipts, observe the
successful original save ACK factory, and await strict success from the bound
sessions' original `revokeAsync` method. Their pure tests cover rejection,
cleanup, late ACKs and accounting regression. Their standalone observer receipts
remain `observer-boundary-only` with `liveDaemonProved:false`. In a successful
hosted run, the fixed composition additionally requires both actual adapter
ACKs, same-directory new-PID restart, read/accounting checks after save, denial
after revoke, and cleanup of all eight adapters. The backup case first verifies
an exact business read, force-stops the owned Job, and holds a bounded copy of
only the encrypted database and wrapped key in memory. It verifies a normal
same-directory restart and exact read, then receives the actual revoke ACK and
immediately force-stops that owner. Only after confirmed termination may it
restore those two files, preserving their identities and ACLs; it never reads or
restores the independent OS anchor. The final same-directory restart must be
alive with unchanged enabled/persistent configuration, explicitly unavailable
persistent recovery, and an HTTP 503 rejection with zero upstream requests.
Timeout, process death, disabled configuration and unrelated failures cannot
qualify. Active journals, path replacement, hardlinks, oversized files and
partial write failures reject; partial restoration is never advertised as
atomic. The sixth case first proves an exact read, completes another private
READ, and holds the independent public final upstream. It requires zero public
bytes before and after forced termination, an observed transport error rather
than a timeout or cancellation, a new PID in the same directory, and exact
original recovery after restart with nondecreasing durable revision and budgets.
External tools execute exactly once. This upstream response hold does not
qualify a kill inside SQLite COMMIT or a durable publication transition.

The seventh and eighth cases add a prepared SQLite COMMIT boundary with forced
kill and positive release controls. They hold a real DELETE-journal reader and
require both read-admission blocking and a fresh authenticated observation of
the one pending prepared `save-reference-state`, bound to the original owner,
root, expiry and exact revision within the original shared 750 ms. Ambiguous,
stale, compensating or late observations reject. Forced kill precedes any
additional adapter I/O; the restarted default owner recovers the hot journal
before metadata inspection and must retain the exact original revision and
accounting. The release control requires the complete public HTTP result and
original completion barrier, then a revision increase and exact recovery after
another same-directory restart. Both retain zero external tool replays.

The ninth and tenth original N09 cases hold the prepared write after the real
storage ACK producer but before its original opaque ACK is delivered. They
require an authenticated held challenge and a readonly durable snapshot with
exactly one revision advance, unchanged budget and original expiry, and zero
public bytes. Forced kill must preserve that exact version after default-owner
reopen; positive release still requires the actual public answer and completion
barrier. A released probe alone is never a host-save acknowledgement.

`n09-sending-ack` adds two independent cases under its own unchanged 120-second
Job, with the original ten-case job retained. Its group is bound to the hashed
review and execution plans and strict two-case receipt. The same authenticated
root must first complete the exact prepared predecessor ACK; the held sending
write must then produce a total advance of exactly two revisions with unchanged
held budget and expiry. Wrong group, version, ordinal, predecessor, public bytes
or incomplete cleanup rejects. Both groups keep the original 750ms witness,
five-second internal hold, source/manifest closure and default storage owner.
The WFP guard admits only the additional fixed runner-local executable path,
retaining its original platform, environment and physical ancestor checks.

`n09-finished-ack` independently holds the transport-finished durable write
before delivery of its original ACK, after the genuine prepared and sending
predecessor ACKs. The held snapshot must advance exactly three revisions with
the original budget and expiry. The original HTTP request must already have
received the exact complete public answer; its byte count and digest are bound
within the same 750ms witness. This transport fact is distinct from the final
publication completion barrier. Kill/reopen must preserve the exact held
revision and recover the original; the release control must additionally await
the original publication completion barrier. No replacement HTTP request or
model retry is issued. A separate hashed plan, fixed executable path, two-case
receipt and original 120-second Job retain isolation from the other groups. This
new group still requires its own Windows execution result.

`n09-withdrawn-ack` and `n09-uncertain-ack` each use two fresh adapters and
their own original 120-second Job. The authenticated trigger stops after
prepared or sending respectively, before the original HTTP handler resumes. The
client must close its actual request transport with zero public bytes; the host
independently requires the matching original response close, after its original
abort listener, with no public headers or successful response finish. Only then
may the signed trigger release advance the original lifecycle into withdrawn or
uncertain. The final held ACK uses a different challenge and later ordinal, with
exact two- or three-version advance and unchanged budget/expiry. The kill case
reopens the same directory and checks the exact durable version before reading
the original. The release case additionally waits for original cleanup and the
final cancellation outcome, not merely an early failure-stage counter. Neither
case grants positive public completion or a host-save ACK from its control
receipt. New fixed paths and hashed plans retain all original platform/physical
source, Job, TLS and egress requirements. These groups require their own Windows
execution results; pure adapter tests do not qualify them.

These are bounded scenario evidence. Other publication COMMIT interiors
(`sending`, `transport-finished`, `uncertain`, `withdrawn`), other daemon
durable-ACK interiors, historical-layout backup migration, installation
lifecycle, full N09, 24-hour capacity, real providers and production activation
remain outside these scenarios. Existing `n08Qualified:false` and
`n09Complete:false` flags are preserved; a successful hosted run proves only its
described cases. Source preparation alone proves no runtime result. The
always-running workflow summary prints a passed scenario scope only for the
matching successful job. It reports the remaining exclusions for every outcome.

Historical verification of earlier promoted scenarios passed 251 tests across
the promoted scenarios and synthetic OS pipe suite, with no failures or skips on
Windows. Scoped ESLint, Prettier, unified CI governance and the 1393-file
JavaScript syntax check also passed. Those historical checks do not qualify the
new sending group or establish installed client acceptance; the workflow must
still complete its own full verification and actual scenario execution.

ACK business progress uses fixed numeric markers only: 247 waits for the signed
held signal, 248 observes the finished public wire, and 249 releases the final
ACK control. Marker 250 is emitted only after the original 750ms witness has
expired following valid durable accounting. Existing readonly markers 174–184
remain unchanged. A last marker identifies a reached step, not a unique root
cause; no deadline is reset or extended and no failed path gains a receipt.

The COMMIT boundary module now has an explicit target-transition entry in
addition to its unchanged prepared entry. It binds the pending observer sample
to exactly one generation, root, original expiry and predecessor revision, plus
physical read-admission blockage in the same original 750ms window. A target
label alone never proves predecessor ACKs or a live daemon: every transition
composition must pause its real predecessor, acquire the reader, release into
the intended write and pass their own runtime controls. Malformed root IDs,
versions without a safe successor and overridden rejected promises reject before
they can confer an observation receipt.

The four non-prepared COMMIT groups now have a fixed daemon composition. A
normal sending/finished case first holds the real prepared/sending ACK, obtains
a reader at its exact durable predecessor, then releases that original ACK into
the target write. A cancelled withdrawn/uncertain case holds its authenticated
trigger, observes actual client closure, obtains the predecessor reader, and
releases the trigger into the original cleanup write. Both require the exact
pending transition and physical read-admission blockage under the unchanged
750ms witness. The finished case independently binds the exact completed public
wire; cancelled cases require zero public bytes. Forced interruption must reopen
through the default owner and preserve the exact predecessor version before
reading the original. A release control must finish the original publication or
cancellation cleanup; cancelled cases also pass the final terminal ACK control.
No synthetic clock, writer replacement, model call or retry is added.

Each new group uses its own two fresh adapters and original 120-second Job,
explicit review-plan group, fixed executable path and strict two-case receipt.
The original six runtime groups remain present; the formal ten-group matrix
still requires the complete same-SHA source gates. These new compositions need
their own actual Windows results. Local protocol fixtures, reader-lock tests and
receipt parsers do not qualify the full N09, five-second stability, installed
clients, real providers or 24-hour capacity.
