import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktopInstaller } from './desktop-installer.ts';
import { compileDesktopNative } from './desktop-native-build.ts';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64에서 설치 후보를 빌드합니다.');
if (![3,5].includes(process.argv.length) || process.argv.length === 5 && process.argv[3] !== '--native') throw new Error('동봉 서버 후보 폴더와 선택적으로 --native <검증된 컴파일 후보>를 지정합니다.');
const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const destination = join(projectRoot, 'desktop/builds', `installer-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
let nativeBuild = process.argv[4] ? resolve(process.argv[4]) : undefined;
if (!nativeBuild) {
  nativeBuild = join(projectRoot, 'desktop/builds', `compiled-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const native = await compileDesktopNative({projectRoot, destination:nativeBuild});
  console.log(JSON.stringify({type:'desktop-native-compiled',destination:nativeBuild,durationMs:native.durationMs}));
}
const result = await buildDesktopInstaller({ projectRoot, source: resolve(process.argv[2]), destination, nativeBuild });
console.log(JSON.stringify({ type: 'desktop-installer-built', destination, installer: result.installer, distributionReady: false }));
