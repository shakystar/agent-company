# Native controller checks

This private Cargo crate compiles the original native `policy`, `child`, `lifecycle`,
`update`, `paths`, and `shell` modules directly. Its locked registry dependencies
match the product lock. It does not compile the Tauri application, updater plugin,
WebView or installer, and is not a distribution artifact.

Use a dedicated `CARGO_TARGET_DIR` outside the installer source tree. Run the unit
checks with:

```powershell
cargo.exe test --manifest-path desktop/native-checks/Cargo.toml --offline --locked
```

The actual Node integration test is ignored by default. After compiling
`tsconfig.desktop.json` to a known test output directory, provide the absolute
Node executable and emitted `server/desktop-entry.js` paths:

```powershell
$env:AC_NATIVE_TEST_NODE = '<absolute Node executable>'
$env:AC_NATIVE_TEST_ENTRY = '<absolute emitted desktop-entry.js>'
cargo.exe test --manifest-path desktop/native-checks/Cargo.toml --offline --locked -- --include-ignored --test-threads=1
```

The emitted entry must resolve the project's existing dependencies. The check uses
temporary resources/data, the product's path validation and private child command,
native update frames, real HTTP/PGlite, and two actual child processes. It verifies
prepare/cancel, hold ownership, shutdown and restart preservation without a model
or Docker call. The fixture cleans up only after its child processes exit. A
deadline reports a failure; cleanup can continue waiting for the owned child and
does not guarantee a bounded total duration.

Keep `npm.cmd run check` as the separate default project check. Neither check
substitutes for compiling and exercising the full Windows application and installer.
