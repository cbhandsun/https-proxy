# Offline legacy recovery enrollment

The packaged runtime includes `lib/proxy/context-recovery-enroll-cli.js`. It exposes the existing offline enrollment owner for an encrypted SQLite store created before independent rollback anchors were required. Normal proxy startup continues to refuse an unanchored store. Installation, startup, management HTTP and recovery workers do not enroll it automatically.

Stop every process using the store. Use the same Windows account that created its DPAPI key. Keep the existing directory and files in place: moving the directory changes its independent anchor identity. Do not delete an existing anchor, replace the key, copy a checkpoint over a newer store, or remove revocations to make enrollment succeed.

Run the following from the installed runtime directory with its bundled Node executable. Replace the example absolute directory with the existing recovery storage directory; do not select the application installation directory or a new directory.

```powershell
.\runtime\node\node.exe .\lib\proxy\context-recovery-enroll-cli.js preview --directory 'C:\absolute\existing\recovery-store'
```

Preview acquires the exclusive writer lock, unwraps the existing key and authenticates a read-only SQLite snapshot. Its stdout is one JSON line containing only `fingerprint`, `scopeCount` and `maxTime`. It does not return originals, keys, scope identifiers or the directory. It does not enroll the store or modify checkpoint bytes; existing path protection may be reapplied. Missing directories and required files are refused rather than replaced.

The fingerprint binds the authenticated store identity, path/key identities, clock and complete scope revision/revocation metadata. Preview establishes integrity of the supplied snapshot. **It cannot prove that an unanchored legacy snapshot is the newest historical copy.** Review its provenance and last-write history before accepting it as the starting point for independent rollback protection. Enrollment cannot reconstruct a missing revocation history.

After review, use the exact fingerprint from that preview:

```powershell
.\runtime\node\node.exe .\lib\proxy\context-recovery-enroll-cli.js enroll --directory 'C:\absolute\existing\recovery-store' --fingerprint '<64 lowercase hexadecimal characters from preview>'
```

Enrollment obtains a fresh lock, unwraps the key again, authenticates the current snapshot and compares its fingerprint. A changed snapshot invalidates the earlier preview. A successful compare-and-swap creates anchor revision one and prints exactly `{"enrolled":true}`. The checkpoint and original expiry metadata remain unchanged by this offline operation. Restart with the current compatible application and verify recovery before normal use. Before returning ready, the current owner seals the authenticated schema-three format in a SQLite transaction and persists its independent anchor. This layout change preserves existing encrypted state/blob rows, revisions, revocations, budgets and expiry metadata. A failed transition never returns a ready owner.

Failure exits with status one and prints only `context_recovery_enrollment_failed` to stderr. Contention, tampering, stale fingerprints, existing anchors and cleanup failures never return success. If anchor commit succeeded but cleanup failed, the anchor remains committed; do not delete it or blindly repeat enrollment. Investigate through the normal anchored reopen path. No command retries or falls back to an unanchored runtime.

Legacy preview/enrollment accepts only schema one or two. A sealed schema-three store with a missing anchor is refused even with an earlier preview fingerprint; the legacy command cannot recreate its lost authority. Do not delete anchors to make a modern store appear eligible.

Schema-one/two readers must refuse the authenticated schema-three store without changing bytes. The installed acceptance sequence now requires that behavior from the pinned old baseline and requires the current package to reopen afterward. This new-format candidate still needs its own hosted qualification; earlier same-format compatibility results do not prove it. This boundary does not prevent an old binary from opening a separately restored historical schema-one/two backup. Never treat format refusal as universal old-reader revocation protection. Automated installation migration, the historical 582-reader layout and full fault-injection acceptance remain separate requirements. Actual same-user DPAPI enrollment was qualified for the earlier same-format candidate in run `40045048891`; the new epoch is not covered by that historical result.

`test/context-recovery-enrollment-command.test.js` validates the argument/output boundary and real invalid-argument CLI exit. `test/context-recovery-anchor-legacy-owner.test.js` exercises command preview and enrollment against actual encrypted SQLite with synthetic key protection and anchor repositories, plus the owner's contention, tampering, stale-preview and cleanup matrix. Both enter unified CI; these synthetic dependencies are not evidence of real DPAPI enrollment.
