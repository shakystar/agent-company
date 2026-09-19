# Codex 0.154.0 Windows x64 build input

`source.json` pins the unmodified `codex-x86_64-pc-windows-msvc.exe` release asset (298,169,136 bytes) and the source provenance for the thirty-two notice files listed below: thirty complete upstream files and two source excerpts, totaling 189,341 bytes. Release metadata was checked on 2026-09-11 UTC against [release 0.154.0](https://github.com/openai/codex/releases/tag/rust-v0.154.0) and the official GitHub release API. The local installed executable matched the published SHA-256 without copying or executing it during that check. No binary is stored in this directory.

The build requires an explicit absolute executable path. It verifies the complete hash, size, x64 PE header, ordinary file identity and parent paths. It does not discover npm/PATH installations, download binaries, run the input, or read adjacent authentication/configuration. Only the selected executable, these thirty-two notice files, source metadata and the generated provider manifest are copied into a fresh candidate. The application exposes this provider through the account-management client; runtime/model setup remains separate.

The release asset hash is an upstream-published integrity reference, not proof that the final installer is signed. The source tag resolves to commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`; GitHub reported the annotated tag's verification as false. Do not describe it as a verified signed tag.

The original seven notices are preserved byte-for-byte from Codex commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. Five dependency notices were added on 2026-09-12 KST from the exact upstream commits recorded by the corresponding Cargo packages. Their small official crate downloads matched Codex's fixed `Cargo.lock` checksums; the notice bytes also matched the upstream Git blob IDs. `source.json` records each upstream repository, commit, path, URL, size, SHA-256 and crate connection separately from the Codex source commit. The Oniguruma notice additionally records the pinned Rust-Onig submodule connection.

| Packaged file | Upstream path | Scope |
| --- | --- | --- |
| `LICENSE` | `LICENSE` | Codex Apache-2.0 license |
| `NOTICE` | `NOTICE` | Codex attribution and Ratatui-derived MIT code attribution |
| `LICENSE.wezterm` | `third_party/wezterm/LICENSE` | MIT license for copied WezTerm Windows PTY code; `codex-rs/utils/pty/src/win/conpty.rs` carries the same attribution |
| `LICENSE.imagegen` | `codex-rs/skills/src/assets/samples/imagegen/LICENSE.txt` | Apache-2.0 license for an embedded sample skill |
| `LICENSE.openai-docs` | `codex-rs/skills/src/assets/samples/openai-docs/LICENSE.txt` | Apache-2.0 license for an embedded sample skill |
| `LICENSE.skill-creator` | `codex-rs/skills/src/assets/samples/skill-creator/license.txt` | Apache-2.0 license for an embedded sample skill |
| `LICENSE.skill-installer` | `codex-rs/skills/src/assets/samples/skill-installer/LICENSE.txt` | Apache-2.0 license for an embedded sample skill |
| `LICENSE.ratatui` | `ratatui/ratatui`: `LICENSE` | Full Ratatui 0.30.2 MIT text, including both copyright notices named in Codex `NOTICE` |
| `LICENSE.syntect` | `trishume/syntect`: `LICENSE.txt` | Syntect 5.3.0 MIT source license |
| `LICENSE.onig` | `rust-onig/rust-onig`: `LICENSE.md` | Rust-Onig 6.5.1 MIT source license; its native dependency has a separate license |
| `LICENSE.onig-sys` | `rust-onig/rust-onig`: `onig_sys/LICENSE.md` | Rust-Onig native bindings 69.9.1 MIT source license |
| `LICENSE.oniguruma` | `kkos/oniguruma`: `COPYING` | Original Oniguruma license from the native source vendored in onig_sys 69.9.1 |
| `LICENSE.aws-lc-rs` | `aws/aws-lc-rs`: `aws-lc-rs/LICENSE` | AWS-LC Rust wrapper 1.16.2 full license |
| `LICENSE.aws-lc-sys` | `aws/aws-lc-rs`: `aws-lc-sys/LICENSE` | Native bindings 0.39.0 full license and third-party attributions |
| `LICENSE.aws-lc` | `aws/aws-lc`: `LICENSE` | Exact vendored native license, including BoringSSL/OpenSSL, mlkem/mldsa, s2n, Fiat and Jitter Entropy attribution |
| `LICENSE.aws-lc-fiat` | `aws/aws-lc`: `third_party/fiat/LICENSE` | Original Fiat Cryptography notice |
| `LICENSE.aws-lc-s2n-bignum` | `aws/aws-lc`: `third_party/s2n-bignum/s2n-bignum-imported/LICENSE` | Original s2n-bignum notice from the pinned native source |
| `LICENSE.aws-lc-jitterentropy` | `aws/aws-lc`: `third_party/jitterentropy/jitterentropy-library/LICENSE` | Original Jitter Entropy notice and license choice |
| `LICENSE.aws-lc-jitterentropy-bsd` | `aws/aws-lc`: `third_party/jitterentropy/jitterentropy-library/LICENSE.bsd` | BSD text corresponding to AWS-LC's stated Jitter Entropy license election |
| `LICENSE.sqlx-apache` | `launchbadge/sqlx`: `LICENSE-APACHE` | SQLx 0.9.0 Apache license alternative |
| `LICENSE.sqlx-mit` | `launchbadge/sqlx`: `LICENSE-MIT` | SQLx 0.9.0 MIT license alternative |
| `LICENSE.libsqlite3-sys` | `rusqlite/rusqlite`: `LICENSE` | libsqlite3-sys 0.37.0 wrapper MIT license |
| `LICENSE.zstd` | `gyscos/zstd-rs`: `LICENSE` | zstd 0.13.3 wrapper MIT license |
| `LICENSE.zstd-safe-apache` | `gyscos/zstd-rs`: `zstd-safe/LICENSE.Apache-2.0` | zstd-safe 7.2.4 Apache license alternative |
| `LICENSE.zstd-safe-mit` | `gyscos/zstd-rs`: `zstd-safe/LICENSE.Mit` | zstd-safe 7.2.4 MIT license alternative |
| `LICENSE.zstd-sys-apache` | `gyscos/zstd-rs`: `zstd-safe/zstd-sys/LICENSE.Apache-2.0` | zstd-sys 2.0.16+zstd.1.5.7 Apache license alternative |
| `LICENSE.zstd-sys-mit` | `gyscos/zstd-rs`: `zstd-safe/zstd-sys/LICENSE.Mit` | zstd-sys MIT license alternative |
| `LICENSE.zstd-sys-bsd` | `gyscos/zstd-rs`: `zstd-safe/zstd-sys/LICENSE.BSD-3-Clause` | Separate notice for the generated native bindings |
| `LICENSE.zstd-native` | `facebook/zstd`: `LICENSE` | Zstandard 1.5.7 native BSD license alternative |
| `LICENSE.zstd-native-gpl-2.0` | `facebook/zstd`: `COPYING` | Original GPLv2 alternative supplied alongside the native BSD license |
| `NOTICE.sqlite-source` | `rusqlite/rusqlite`: `libsqlite3-sys/sqlite3/sqlite3.c` | Exact copyright-disclaimer comment excerpt; byte offset 1,601, length 427 |
| `NOTICE.zstd-xxhash` | `facebook/zstd`: `lib/common/xxhash.h` | Exact xxHash attribution and license-choice comment excerpt; byte offset 0, length 413 |

The twenty native-related additions were checked against seven exact Cargo.lock package checksums and their crate VCS commits. AWS-LC's vendor gitlink is `47389586f8aa77c83245173793f4d44ed1d6c3a8`; Zstandard's is `f8745da6ff1ad1e7bab384bd1f9d742439278e99`. Fifteen complete notice files also match members of the published crates byte-for-byte. The s2n-bignum and two Jitter Entropy notices are separate files omitted from the crate, obtained from the same pinned native source for components named in its full license. The AWS-LC native license explicitly distinguishes linked-library attribution from testing/build-only projects; this collection does not claim that every native component is linked for Windows.

The two `NOTICE.*` additions are unmodified source excerpts, not complete upstream files. `source.json` separates each excerpt's offset/length/hash from the entire upstream file's size/hash/Git blob in `upstreamSource`. The entire source bytes were verified from the checksum-pinned crate against the corresponding Git tree before selecting the comment. The SQLite amalgamation identifies version 3.51.3 and Fossil source ID `737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618`; only its identified disclaimer block is reproduced. The xxHash header at the pinned Zstandard commit offers the native BSD/GPLv2 alternatives; preserving both original license texts does not select GPLv2 for this product. No generic license text was synthesized.

The [fixed CLI manifest](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/cli/Cargo.toml) includes `codex-tui` without a platform condition. The [TUI manifest](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/tui/Cargo.toml) includes Ratatui and Syntect without a platform condition. Syntect's default features select Onig; Onig selects onig_sys. The pinned [onig_sys build script](https://github.com/rust-onig/rust-onig/blob/ed05d7ac1a1a138c6d9c46b451b9d9bea0fbe0b1/onig_sys/build.rs) includes the Windows native compilation branch. This is source and feature evidence, not a reconstructed link map of the published executable. The full Ratatui license comes from [commit e665c36](https://github.com/ratatui/ratatui/blob/e665c36cb14752a61cd777fbd06dbef8474f2add/LICENSE); its two attribution lines exactly match Codex `NOTICE`. The historical commit of every copied Ratatui fragment was not established.

The sample directory is embedded by `include_dir!` in `codex-rs/skills/src/lib.rs`. These notices cover identified source inclusions; they are not a complete third-party attribution bundle. The official release's 160 assets contain no separately named LICENSE/NOTICE/SBOM artifact, and the Windows release workflow's standalone binary archives do not collect dependency notices. `Cargo.lock` pins the entire workspace, including other targets, helpers and development dependencies, so it is not a list of what is linked into this Windows executable. `deny.toml` is a license policy, not a distribution notice file.

Remaining work includes the exact Windows release dependency closure and its original Rust/native dependency licenses and notices, including other Ratatui crates, registry and pinned Git dependencies. The added AWS-LC, SQLite and Zstandard source notices do not establish a complete target-specific link inventory or exhaustive per-file attribution coverage. Syntect/Two-Face embedded syntax and theme assets, remaining per-file third-party attributions, static native/CRT and prebuilt assembly components, SQLx's other separately packaged crates and pinned Git dependencies such as Nucleo require separate coverage. The explicit vendored OpenSSL settings in `codex-core` apply to Linux musl targets, so that setting alone does not prove a Windows OpenSSL inclusion; AWS-LC's own OpenSSL-derived source has the separate attribution collected above. Licenses for unrelated Linux-only source such as vendored bubblewrap do not establish Windows coverage. Any source-availability obligations must also be evaluated for the resolved dependencies. The final distribution remains `distributionReady: false` pending that audit, actual account/model verification, signing and installation/update checks. The CLI includes dependencies beyond the account methods exposed by this product.
