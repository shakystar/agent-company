import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDesktopProviderDirectory } from './desktop-provider-files.ts';
import { readDesktopPayload } from './desktop-payload.ts';
import { stageDesktopNativeNotices } from './desktop-native-notices.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.argv.length !== 4) throw new Error('동봉 서버 후보 폴더와 네이티브 실행파일 경로가 필요합니다.');
const source = resolve(process.argv[2]), native = resolve(process.argv[3]);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const payload = await readDesktopPayload(source);
const executableInfo = await lstat(native);
// Cargo hard-links its top-level executable to the deps artifact. Read its bytes
// and create a new independent file below; never preserve a source hard link.
if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('일반 네이티브 실행파일이 필요합니다.');
const executable = await readFile(native);
// This checks executable structure and target, not publisher identity or a release signature.
if (executable.length < 64 || executable.readUInt16LE(0) !== 0x5a4d) throw new Error('Windows 실행파일이 아닙니다.');
const pe = executable.readUInt32LE(0x3c);
if (pe > executable.length - 26 || executable.readUInt32LE(pe) !== 0x00004550
  || executable.readUInt16LE(pe + 4) !== 0x8664 || executable.readUInt16LE(pe + 24) !== 0x20b) throw new Error('Windows x64 실행파일이 아닙니다.');
await assertDesktopProviderDirectory(join(root, 'desktop'));
const builds = join(root, 'desktop', 'builds');
await mkdir(builds, { recursive: true });
await assertDesktopProviderDirectory(builds);
const output = join(builds, `native-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
// Capacity precedes the standard offline Cargo metadata process and all candidate copying.
const staged = await stageDesktopNativeNotices({ projectRoot: root, payload, destination: output,
  additionalBytes: BigInt(executable.length + 64 * 1024) });
const { manifest } = staged;
await writeFile(join(output, 'agent-company-beta.exe'), executable, { flag: 'wx' });
if ((await lstat(join(output, 'agent-company-beta.exe'))).nlink !== 1) throw new Error('네이티브 후보가 독립 파일로 생성되지 않았습니다.');
await writeFile(join(output, 'native-manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(),
  target: manifest.target, protocol: manifest.protocol, entry: 'agent-company-beta.exe',
  executable: { bytes: executable.length, sha256: hash(executable) }, payloadManifestSha256: staged.payloadManifestSha256,
  sourcePayloadManifestSha256: staged.sourcePayloadManifestSha256,
  cargoLockSha256: staged.cargoLockSha256, nativeNotices: staged.nativeNotices, distributionReady: false,
  remaining: ['Native end-to-end verification', 'Runtime and model setup', 'Complete dependency notices', 'Signed installer and update verification'] }, null, 2));
console.log(JSON.stringify({ type: 'desktop-native-staged', output, files: manifest.files.length + 4, distributionReady: false }));
