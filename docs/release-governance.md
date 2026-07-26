# Release package governance

Release builds use a clean, generated runtime under `dist/staging/runtime`.
The staging step installs only the backend dependencies explicitly listed in
`package.json#hpm.releaseRuntimeDependencies`, bundles the current Node
executable, writes a pruned lockfile, and records its checksum in the runtime
manifest. Frontend-only packages such as `chart.js` are excluded.

## Commands

- `npm run clean:staging` removes only `dist/staging`.
- `npm run clean:artifacts` removes only `dist/artifacts`.
- `npm run clean:coverage` removes only test coverage output.
- `npm run clean:release` removes release staging, final artifacts, frontend
  output and every Cargo `src-tauri/target*` directory after verifying that each
  path is inside the repository. It preserves `dist/archive`.
- `npm run clean:release:cache` removes only Cargo build caches and preserves
  collected installers, portable archives and local archives.
- `npm run release:prepare` recreates the Node runtime and production dependency staging directory.
- `npm run release:check` verifies the static Tauri resource and script configuration.
- `npm run tauri:build` normalizes `CARGO_TARGET_DIR` to an absolute path,
  builds the Tauri installers, then copies final installers and a SHA-256
  manifest to `dist/artifacts/installers`.
- `npm run release:portable` builds a clean portable directory, validates it,
  creates the zip archive, and writes a portable SHA-256 manifest.

## Security rules

Published packages must never contain:

- `proxy.config.json`, `.env*`, management tokens, logs, JSONL audit files, or PID/lock files;
- `.hpm-runtime`, `.certs`, `.claude`, private keys, or symbolic links;
- npm lifecycle scripts or development dependencies.

The portable build is intentionally stateless. It ships only `proxy.config.example.json`; the application creates local state on first run. Existing portable state is never copied into a new release.

`dist/archive` is local-only and exists solely to retain pre-governance or
manually produced files. CI, checksums, attestations and GitHub releases operate
only on `dist/artifacts`, so archived files cannot be published accidentally.

`.hpm-runtime` is local application state rather than a build artifact and is
never removed by release cleanup.

## Windows NSIS process-cleanup rules

The current-user NSIS installer runs `src-tauri/nsis/stop-installed-processes.ps1` before install and uninstall. Keep these constraints in place:

- Do not pass `$INSTDIR` or another path containing spaces through an `nsExec` command-line argument. NSIS and PowerShell quoting can split or shift the arguments. The cleanup script derives the fixed current-user location from `LOCALAPPDATA`.
- Never normalize a filesystem root from `C:\` to `C:`. On Windows, `C:` is drive-relative and resolves against that drive's current directory. Because NSIS sets its working directory to the install directory, this can make a normal installation path compare equal to the filesystem root.
- Preserve the filesystem-root safety check so cleanup can never scan, stop processes from, or perform lock checks against a whole drive.
- `test/governance/installer-process-cleanup.test.js` must run the cleanup script with its working directory set to the installation directory. It must verify both that a real root is rejected and that the normal installation directory is accepted.
- Before publishing an installer change, run `npm run verify`, build the NSIS package, and perform one end-to-end current-user install. A successful source-level test alone is not sufficient for command-line and installer-host behavior.
