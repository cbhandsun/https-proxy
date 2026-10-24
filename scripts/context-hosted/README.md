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
and dependency audit before either runtime operation. After those gates:

```powershell
node scripts/prepare-context-hosted-run.js n08
./scripts/qualify-context-hosted.ps1 -Case n08
```

The N09 job uses `n09` in both positions. The prepare command checks the exact
GitHub source SHA and tracked source hashes, observes the actual
`npm run release:prepare` exit, then creates a fresh
`$RUNNER_TEMP/hpm-context-n08` or `hpm-context-n09` directory. The payload's
schema-2 manifest, executable, source hashes, release layout and production
dependency lock are verified before the fixed review plan is written. A
collision fails and preserves the existing directory.

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
cumulative-budget checks. N09 uses four distinct private adapters: committed
metadata observation followed by forced kill/restart/read; actual
await-clearAsync ACK followed by forced kill/restart plus four policy
combinations; and separate save and revoke durable-ACK cases. The outer
composition checks each adapter's observed seed/read/public/ACK counts and
single original tool execution.

The fixed child receipt is accepted only after its own cleanup and the original
outer Job's verified cleanup. Failed stop acknowledgement retains firewall
containment; the disposable runner must be discarded. Only fixed receipts and
bounded scope text are printed. No payload, key, database, request body or
original evidence is uploaded.

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
after revoke, and cleanup of all four adapters. These are bounded scenario
evidence; commit/publication in progress, backup rollback, installation
lifecycle, full N09, 24-hour capacity, real providers and production activation
remain outside these scenarios. Existing `n08Qualified:false` and
`n09Complete:false` flags are preserved; a successful hosted run proves only its
described cases. Source preparation alone proves no runtime result. The
always-running workflow summary prints a passed scenario scope only for the
matching successful job. It reports the remaining exclusions for every outcome.

Local verification passed 251 tests across the promoted scenarios and synthetic
OS pipe suite, with no failures or skips on Windows. Scoped ESLint, Prettier,
unified CI governance and the 1393-file JavaScript syntax check also passed.
These checks do not execute the hosted daemon scenarios or establish installed
client acceptance; the workflow must still complete its own full verification
and actual scenario execution.
