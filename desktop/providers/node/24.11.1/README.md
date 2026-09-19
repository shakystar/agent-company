# Node.js 24.11.1 Windows x64 input

The desktop build verifies its Node executable against the SHA-256 in the official
[release checksums](https://nodejs.org/dist/v24.11.1/SHASUMS256.txt). `source.json`
records that document's hash and the source commit for the original `LICENSE`,
which includes Node's bundled third-party notices. The build validates the exact
license bytes it publishes and rechecks inputs before copying the executable.

The current desktop release input is pinned to 24.11.1; the project's broader
development Node engine range does not change that pin. Updating the input requires
reviewing the new official binary and original notices together. No executable is
stored here. The local installed executable matched the official hash when checked
on 2026-09-12 KST. The release GPG signature was not verified.

This record covers Node's release license document. It does not establish complete
notice coverage for the application's npm/WASM, Codex, Rust or native dependencies,
or grant installer signing/distribution approval.
