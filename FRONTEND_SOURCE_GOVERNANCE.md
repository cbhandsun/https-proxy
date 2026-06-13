# Frontend Source Governance

The canonical UI entry is:

- `tauri-ui/electron-ui.html`
- `tauri-ui/app.css`
- `tauri-ui/app-ux.js`
- `tauri-ui/app-bridge.js`
- `tauri-ui/app-audit.js`
- `tauri-ui/app-cli.js`
- `tauri-ui/app-diagnostics.js`
- `tauri-ui/app.js`

The root `electron-ui.html`, `app.css`, `app-ux.js`, `app-bridge.js`, `app-audit.js`, `app-cli.js`, `app-diagnostics.js`, and `app.js` files are kept as compatibility mirrors for older launch paths and quick local inspection. Do not edit the mirror files directly.

Use these commands:

- `npm run frontend:check` verifies the mirrors match the canonical Tauri UI files.
- `npm run frontend:sync` updates root mirror files from `tauri-ui/`.

`npm run dev`, `npm run build`, `npm run tauri:dev`, and `npm run tauri:build` run the check first so UI changes cannot silently ship from the wrong file. Tauri's own `beforeDevCommand` and `beforeBuildCommand` also run the same check for direct `npx tauri ...` usage.
