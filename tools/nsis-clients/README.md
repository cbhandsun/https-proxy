# Isolated Windows client inputs

This private package pins the native Windows x64 clients used by installer
qualification: Codex 0.160.1 and Claude Code 2.1.292. The lock contains the
official npm registry tarballs and their SHA-512 integrity values. These are
test inputs, not application runtime dependencies or published installer files.

On a disposable Windows x64 runner, prepare them with:

```powershell
npm ci --prefix tools/nsis-clients --ignore-scripts --no-audit --no-fund
```

Do not replace a user's installed clients, read daily
authentication/configuration, or run the clients against a real provider as part
of preparation. Installation of these inputs alone grants no client
qualification. An actual run also needs verified installed proxy identity,
isolated fresh client homes, owned process-tree cleanup, synthetic entry
credentials, independent recovery witnesses, and proven network containment for
the proxy and both client executables. Keep the original provider authorization
gates and request deadlines.

The lock was generated as metadata on macOS; npm correctly refused native
installation there. A metadata-only `--package-lock-only --force` invocation did
not install or run either executable. Windows installation and actual CLI
qualification remain separate checks; their platform gate must not be bypassed.
