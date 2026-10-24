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

Enrollment obtains a fresh lock, unwraps the key again, authenticates the current snapshot and compares its fingerprint. A changed snapshot invalidates the earlier preview. A successful compare-and-swap creates anchor revision one and prints exactly `{"enrolled":true}`. The checkpoint and original expiry metadata remain unchanged. Restart with the current compatible application and verify recovery before normal use.

Failure exits with status one and prints only `context_recovery_enrollment_failed` to stderr. Contention, tampering, stale fingerprints, existing anchors and cleanup failures never return success. If anchor commit succeeded but cleanup failed, the anchor remains committed; do not delete it or blindly repeat enrollment. Investigate through the normal anchored reopen path. No command retries or falls back to an unanchored runtime.

This procedure does not qualify an older reader's rollback protection. Older compatible readers may read the database without enforcing independent anchors. Do not use old-reader compatibility as proof of revocation or antirollback safety. Automated installation migration, the historical 582-reader layout, actual DPAPI enrollment on a disposable Windows runner and full fault-injection acceptance remain separate qualification requirements.

`test/context-recovery-enrollment-command.test.js` validates the argument/output boundary and real invalid-argument CLI exit. `test/context-recovery-anchor-legacy-owner.test.js` exercises command preview and enrollment against actual encrypted SQLite with synthetic key protection and anchor repositories, plus the owner's contention, tampering, stale-preview and cleanup matrix. Both enter unified CI; these synthetic dependencies are not evidence of real DPAPI enrollment.
