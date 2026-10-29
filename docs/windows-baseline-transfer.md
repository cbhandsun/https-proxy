# Private old installer transfer

This lane transfers the retained old625 installer into a private Actions artifact. It never executes the installer. It does not qualify installed recovery, old582 migration, keys, databases, capacity or production.

Run from the repository root with Node 22 or later. The archive must first have a successful `archive-receipt.json`; the command refuses failed or incomplete archives, modified installer bytes, or a modified runtime manifest. Keep the immutable local archive after transfer.

Default dry-run performs local verification only and creates no files or network requests:

```powershell
node scripts/transfer-nsis-baseline.cjs --archive '<absolute-successful-preserved-archive>' --target '<existing-reviewed-full-40-character-commit-SHA>'
```

After explicit authorization for remote writes, append `--execute`. The existing authenticated `gh` identity must have push access to the private `cbhandsun/https-proxy` repository. The command confirms repository privacy, push access and exact existing target SHA, creates a unique unpublished draft with a unique owned tag, and uploads only the fixed installer and generated strict three-property `identity.json`. It never overwrites assets, publishes a release, pushes source, uploads an archive/runtime/key/database, or dispatches a workflow. Successful output includes `id`, `tag`, `target`, `assetIds` (installer then identity) and the local `stateFile` path. The target is a commit SHA, never a branch name or inferred HEAD.

The new manual `Private old NSIS artifact bridge` workflow accepts those exact release, installer asset and identity asset IDs, target SHA and tag. Its dispatch commit (`GITHUB_SHA`), explicitly pinned checkout commit and transfer target must all be the same reviewed commit; mixed A/B commits are refused before any download. The runtime also reads `git rev-parse --verify HEAD` in the checkout and compares it with the target. Review and introduce its source through the usual remote change process before dispatching it. Introducing the workflow and dispatching it are separate remote writes. No current source file invokes dispatch automatically.

GitHub requires a `workflow_dispatch` workflow to exist on the default branch before manual dispatch is available. Adding these files to a feature branch does not make manual dispatch available. Both lanes therefore also expose matching `workflow_call` inputs and separate review-push callers that work without changing `master`:

- Bridge: create `acceptance/windows-baseline-bridge/<releaseID>-<installerAssetID>-<identityAssetID>-<UUID>` at the exact reviewed source commit. The UUID must be the lowercase canonical version-4 UUID from the local handoff tag `hpm-baseline-transfer-<UUID>`.
- Encrypted qualification: create `acceptance/windows-encrypted-lifecycle/<artifactID>` at that same reviewed source commit after the bridge produces the artifact.

The sequence is explicit: first push the reviewed commit to an ordinary source branch that matches neither review-lane filter; create the unpublished draft targeted at that exact existing commit using the authorized local handoff; then push that unchanged commit to the exact bridge review alias. Once the bridge succeeds, push the same unchanged commit to the exact encrypted review alias. Do not create a follow-up commit merely to insert IDs: they are parsed from the alias, so the source, draft target and both acceptance runs retain one commit identity. Each alias creation triggers its lane once; updates, forced pushes, deletions, tags and other branches are refused. Existing repository push workflows, including Verify, may also run when a source or review branch is pushed.

The caller resolve job has only Contents read access, checks the private same-repository push payload, exact ref/SHA, hosted environment, actual checkout HEAD and new-branch event, and emits only fixed validated output keys. IDs must be canonical positive decimal values of at most 15 digits; the two asset IDs must differ. Its CLI evaluates no shell text and logs no event body. Caller branch inputs are never interpolated into shell commands. Only the bridge call receives Contents write access for draft visibility. The encrypted call receives Contents read and Actions read, inherits no secrets and retains the full verify/audit/build/installation gates. No local preparation script pushes aliases or starts either lane.

Only the bridge job has `contents: write`: draft visibility requires push access. Its download code uses read requests, validates the private repository, unpublished draft ownership and exact two assets, bounds actual streamed bytes, verifies the fixed SHA and strict identity, then uploads only those two files through the pinned official upload-artifact action. The one-day artifact is named `hpm-old-nsis-e7dc2ec`; its numeric ID appears in the job summary. Feed this ID to the separate encrypted lifecycle workflow, which retains `contents: read` and `actions: read`. No installation or model request runs in the bridge.

Each authenticated asset request has a 30-second timeout. Cross-origin signed downloads allow only the two known GitHub asset hosts, never forward the repository token, and reject further redirects. Asset lengths are bounded at 28,541,417 installer bytes and 4096 identity bytes while reading. The API subprocess is capped at 30 seconds and 1 MiB output. Errors contain a fixed safe label.

All `gh api` calls explicitly pin `--hostname github.com`; release upload uses the fully qualified `github.com/cbhandsun/https-proxy` repository. Subprocess `GH_HOST` and `GH_REPO` are pinned too, so inherited enterprise host settings cannot redirect the transfer to a different same-named repository.

The local owned `transfer-*/transfer-state.json` is written before creating remote resources and after recording a returned release ID. Failure always preserves every remote draft, asset and tag and records `cleanupRequired: true` plus `remoteResourcesPreserved: true`. The command never automatically deletes resources: even matching release metadata cannot prove that no unknown asset was added concurrently. A timed-out create request also requires reconciliation using the stored unique marker.

After recording successful Actions artifact acquisition, inspect the local receipt and remote draft again. Delete only that exact owned unpublished draft, then separately delete its temporary tag only if the tag was absent at preflight and still resolves to the recorded target. Deleting a release does not guarantee tag deletion. Do not remove a pre-existing or changed tag. Retain the local immutable archive and receipts. The Actions artifact expires after one day or can be explicitly deleted by an identity with Actions write permission. Cleanup is never a blanket repository operation.

Host overrides are removed without regard to environment-variable letter case before setting fixed values. Checkout verification also removes all inherited `GIT_*` variables, including mixed-case variants, so an external Git directory cannot redirect the HEAD check.

Any separate authorized cleanup must enumerate the complete current asset list and reconcile it against the two recorded asset IDs, exact names, sizes and hashes. Unknown or changed assets require explicit reconciliation; release metadata alone never authorizes deleting a whole draft.

Local tests use synthetic inputs and mock remote calls; they perform no remote writes or installer execution. Run `node --test test/nsis-baseline-transfer.test.js`; unified discovery includes this file. Hosted artifact acquisition and actual installed lifecycle remain separate acceptance gates.
