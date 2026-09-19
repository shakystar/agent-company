import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, lstat, mkdir, readFile, readdir, statfs, unlink, writeFile} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative} from 'node:path';
import lockfile from 'proper-lockfile';
import {z} from 'zod';
import {command, type Command} from '../server/process.ts';
import {desktopInstallerCliVersion, desktopNativeSources, desktopNsisExecutablePin} from './desktop-installer.ts';
import {assertDesktopPayloadCopySpace} from './desktop-payload.ts';
import {assertDesktopProviderDirectory, readDesktopProviderFile, inspectDesktopFile, verifyPinnedDesktopPayloadFile, verifyPinnedDesktopFile} from './desktop-provider-files.ts';

const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const target='x86_64-pc-windows-msvc';
const pin=z.object({bytes:z.number().int().nonnegative().max(512*1024*1024),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const sourcePin=pin.extend({path:z.string().regex(/^(?:Cargo\.(?:toml|lock)|build\.rs|tauri\.conf\.json|(?:src|shell|icons|windows)\/[a-zA-Z0-9_.\/-]+)$/).refine(p=>!p.split('/').some(v=>v==='.'||v==='..'||!v))});
const manifestSchema=z.object({version:z.literal(1),target:z.literal(target),cliVersion:z.literal(desktopInstallerCliVersion),sourcePins:z.array(sourcePin).max(512),executable:pin.extend({path:z.literal('agent-company-beta.exe')}),createdAt:z.string(),toolchain:z.string(),cacheKey:z.string(),durationMs:z.number(),freeBytesBefore:z.string(),freeBytesAfter:z.string()}).strict();
type Sources=Awaited<ReturnType<typeof desktopNativeSources>>;
const pins=(sources:Sources)=>sources.map(({path,pin})=>({path,...pin}));
const sourceIdentity=(entries:Array<{path:string;bytes:number;sha256:string}>)=>JSON.stringify(entries.map(p=>[p.path,p.bytes,p.sha256]));

export async function verifyDesktopNativeBuild(directory:string, sources:Sources) {
 if(!isAbsolute(directory))throw Error('DESKTOP_NATIVE_BUILD_PATH_INVALID');
 await assertDesktopProviderDirectory(directory);
 const file=await readDesktopProviderFile(join(directory,'native-build.json'),1024*1024);
 const manifest=manifestSchema.parse(JSON.parse(file.data.toString('utf8')));
 if(sourceIdentity(manifest.sourcePins)!==sourceIdentity(pins(sources)))throw Error('DESKTOP_NATIVE_BUILD_SOURCE_MISMATCH');
 const executable=join(directory,manifest.executable.path);
 await verifyPinnedDesktopFile(executable,manifest.executable,{windowsX64Executable:true});
 desktopNsisExecutablePin(await readFile(executable));
 return {executable,pin:manifest.executable,manifestSha256:file.pin.sha256};
}

/** Reuse only compiler intermediates. Every output and source snapshot is immutable. */
export async function compileDesktopNative(input:{projectRoot:string;destination:string}, supplied:{command?:Command;assertSpace?:typeof assertDesktopPayloadCopySpace}={}) {
 const {projectRoot,destination}=input;
 if(!isAbsolute(projectRoot)||!isAbsolute(destination)||dirname(destination)!==join(projectRoot,'desktop/builds'))throw Error('DESKTOP_NATIVE_BUILD_PATH_INVALID');
 await assertDesktopProviderDirectory(projectRoot);
 await assertDesktopProviderDirectory(dirname(destination));
 try{await lstat(destination);throw Error('DESKTOP_NATIVE_BUILD_EXISTS');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const assertSpace=supplied.assertSpace??assertDesktopPayloadCopySpace;
 await assertSpace(dirname(destination),2n*1024n**3n);
 const original=await desktopNativeSources(join(projectRoot,'desktop/src-tauri'));
 const expected=pins(original);
 const unchanged=async()=>{if(JSON.stringify(pins(await desktopNativeSources(join(projectRoot,'desktop/src-tauri'))))!==JSON.stringify(expected))throw Error('DESKTOP_NATIVE_BUILD_SOURCE_CHANGED');};
 const cli=join(projectRoot,'node_modules/@tauri-apps/cli/tauri.js');
 const cliPin=await readDesktopProviderFile(cli,2*1024*1024);
 const run=supplied.command??command;
 const version=await run(process.execPath,[cli,'--version'],{timeoutMs:30000});
 if(version.code!==0||version.stdout.trim()!==`tauri-cli ${desktopInstallerCliVersion}`)throw Error('DESKTOP_NATIVE_CLI_VERSION');
 const env:NodeJS.ProcessEnv={};
 for(const key of ['PATH','Path','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData','CARGO_HOME','RUSTUP_HOME','INCLUDE','LIB','LIBPATH','VSINSTALLDIR','VCINSTALLDIR'])if(process.env[key]!==undefined)env[key]=process.env[key];
 const rust=await run('rustc',['-Vv'],{env,timeoutMs:30000});
 if(rust.code!==0||!rust.stdout.startsWith('rustc '))throw Error('DESKTOP_NATIVE_TOOLCHAIN_INVALID');
 const cacheKey=hash(`${rust.stdout}\n${target}\nrelease\n${desktopInstallerCliVersion}`).slice(0,20);
 const cacheRoot=join(projectRoot,'desktop/build-cache');
 await mkdir(cacheRoot,{recursive:true});await assertDesktopProviderDirectory(cacheRoot);
 const cache=join(cacheRoot,cacheKey);await mkdir(cache,{recursive:true});await assertDesktopProviderDirectory(cache);
 let compromised=false;
 const release=await lockfile.lock(cache,{lockfilePath:join(cache,'build.lock'),stale:120000,update:10000,retries:0,onCompromised:()=>{compromised=true;}});
 const alive=async()=>{if(compromised)throw Error('DESKTOP_NATIVE_CACHE_LOCK_LOST');await assertDesktopProviderDirectory(cache);};
 try {
  await alive();await unchanged();
  const cargo=join(cache,'project/src-tauri');await mkdir(cargo,{recursive:true});await assertDesktopProviderDirectory(cargo);
  // Only known input directories are mutable. Unknown/redirected files fail closed.
  const indexPath=join(cache,'inputs.json');let previous:z.infer<typeof sourcePin>[]=[];
  try{previous=z.array(sourcePin).max(512).parse(JSON.parse((await readDesktopProviderFile(indexPath,1024*1024)).data.toString('utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const prior=new Map(previous.map(p=>[p.path,p]));
  async function inspect(dir:string){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name),name=relative(cargo,path).replaceAll('\\','/');if(entry.isDirectory()){if(name==='gen')continue;await assertDesktopProviderDirectory(path);await inspect(path);}else{if(!prior.has(name))throw Error('DESKTOP_NATIVE_CACHE_UNTRACKED_INPUT');await verifyPinnedDesktopPayloadFile(path,prior.get(name)!);}}}
  if(previous.length)await inspect(cargo);
  else if((await readdir(cargo)).length)throw Error('DESKTOP_NATIVE_CACHE_UNTRACKED_INPUT');
  for(const old of previous)if(!expected.some(p=>p.path===old.path)){await verifyPinnedDesktopPayloadFile(join(cargo,old.path),old);await unlink(join(cargo,old.path));}
  for(const source of original){const output=join(cargo,source.path);await mkdir(dirname(output),{recursive:true});await assertDesktopProviderDirectory(dirname(output));if(prior.get(source.path)?.sha256!==source.pin.sha256)await writeFile(output,source.data);await verifyPinnedDesktopPayloadFile(output,source.pin);}
  await writeFile(indexPath,JSON.stringify(expected));
  // tauri-build watches this directory even with capabilities: []. A missing
  // watched path makes Cargo rerun the build script on every invocation.
  // Keep it empty: this product intentionally grants no frontend capabilities.
  const capabilities=join(cargo,'capabilities');await mkdir(capabilities,{recursive:true});await assertDesktopProviderDirectory(capabilities);
  if((await readdir(capabilities)).length)throw Error('DESKTOP_NATIVE_CACHE_UNEXPECTED_CAPABILITIES');
  // No resource staging and no NSIS invocation in this phase.
  env.CARGO_TARGET_DIR=join(cache,'target');
  const before=await statfs(cache,{bigint:true}),start=Date.now();
  const result=await run(process.execPath,[cli,'build','--ci','--target',target,'--no-bundle','--','--locked','--offline'],{cwd:cargo,env,timeoutMs:60*60_000});
  await mkdir(destination);await writeFile(join(destination,'build.log'),`${result.stdout}\n${result.stderr}`,{flag:'wx'});
  if(result.code!==0)throw Error('DESKTOP_NATIVE_COMPILE_FAILED');
  await alive();await unchanged();await verifyPinnedDesktopPayloadFile(cli,cliPin.pin);
  for(const source of original)await verifyPinnedDesktopPayloadFile(join(cargo,source.path),source.pin);
  const built=join(cache,'target',target,'release/agent-company-beta.exe');await assertDesktopProviderDirectory(dirname(built));
  const stat=await lstat(built,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw Error('DESKTOP_NATIVE_OUTPUT_INVALID');
  const output=join(destination,'agent-company-beta.exe');await copyFile(built,output,constants.COPYFILE_EXCL);
  const afterCopy=await lstat(built,{bigint:true});for(const key of ['dev','ino','size','mtimeNs','ctimeNs'] as const)if(stat[key]!==afterCopy[key])throw Error('DESKTOP_NATIVE_OUTPUT_CHANGED');
  const executable=await inspectDesktopFile(output,512*1024*1024);await verifyPinnedDesktopFile(output,executable,{windowsX64Executable:true});desktopNsisExecutablePin(await readFile(output));
  for(const source of original){const path=join(destination,'source',source.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,source.data,{flag:'wx'});}
  const after=await statfs(cache,{bigint:true});
  const manifest=manifestSchema.parse({version:1,target,cliVersion:desktopInstallerCliVersion,sourcePins:expected,executable:{path:'agent-company-beta.exe',...executable},createdAt:new Date().toISOString(),toolchain:rust.stdout.trim(),cacheKey,durationMs:Date.now()-start,freeBytesBefore:String(before.bavail*before.bsize),freeBytesAfter:String(after.bavail*after.bsize)});
  await alive();await writeFile(join(destination,'native-build.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
 }finally{await release();}
}
