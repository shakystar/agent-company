import {randomUUID} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileDesktopNative} from './desktop-native-build.ts';
if(process.platform!=='win32'||process.arch!=='x64'||process.argv.length!==2)throw Error('Windows x64에서 인자 없이 실행합니다.');
const projectRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const destination=join(projectRoot,'desktop/builds',`compiled-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`);
const result=await compileDesktopNative({projectRoot,destination});
console.log(JSON.stringify({type:'desktop-native-compiled',destination,durationMs:result.durationMs,executable:result.executable,cacheKey:result.cacheKey}));
