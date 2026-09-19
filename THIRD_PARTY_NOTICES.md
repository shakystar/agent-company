# Third-party source notices

The root MIT license applies to Agent Company code. Third-party components retain their own notices and licenses.

## Tauri NSIS installer template

`desktop/src-tauri/windows/installer-template.nsi` is derived from `crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi` at Tauri commit `7cd71369c00978a3783b6ae3e9972358abbe4ae6`.

Source: https://github.com/tauri-apps/tauri/blob/7cd71369c00978a3783b6ae3e9972358abbe4ae6/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

The sole template change removes `/SOLID` from `SetCompressor /SOLID "{{compression}}"`. The original SHA-256 is `20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079`; the modified SHA-256 is `80acd061181c7620f8c3e57f3d99e752728d509eb834229f5d774e70293d6737`. The build scripts verify these pins.

Original license texts are preserved in [LICENSE_APACHE-2.0](desktop/notices/tauri/LICENSE_APACHE-2.0) and [LICENSE_MIT](desktop/notices/tauri/LICENSE_MIT).

## Other components

- Docker/Moby seccomp source: `worker/security/LICENSE.moby` and `worker/security/README.md`.
- Node and Codex provider source records and notices: `desktop/providers/`.
- Supplemental npm and Cargo notices: `desktop/notices/`.

Dependency lockfiles preserve package versions. Provider notices do not imply that provider executable binaries are included in this source repository.
