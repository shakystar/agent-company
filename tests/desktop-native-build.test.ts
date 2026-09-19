import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {desktopNativeSources} from '../scripts/desktop-installer.ts';
import {compileDesktopNative,verifyDesktopNativeBuild} from '../scripts/desktop-native-build.ts';
import type {Command} from '../server/process.ts';

function pe(){const b=Buffer.alloc(256);b.writeUInt16LE(0x5a4d);b.writeUInt32LE(64,0x3c);b.writeUInt32LE(0x4550,64);b.writeUInt16LE(0x8664,68);b.writeUInt16LE(0x20b,88);b.write('__TAURI_BUNDLE_TYPE_VAR_UNK',128);return b;}
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'ac-native-cache-'));
 t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));assert.match(root,/ac-native-cache-[^\\/]+$/);await rm(root,{recursive:true,force:true});});
 const source=join(root,'desktop/src-tauri');
 for(const file of await desktopNativeSources(resolve('desktop/src-tauri'))){const path=join(source,file.path);await mkdir(dirname(path),{recursive:true});await writeFile(path,file.data);}
 await mkdir(join(root,'desktop/builds'),{recursive:true});
 const cli=join(root,'node_modules/@tauri-apps/cli/tauri.js');await mkdir(dirname(cli),{recursive:true});await writeFile(cli,'// fixture');
 const caches:string[]=[];let afterBuild=async()=>{};
 const run:Command=async(file,args,options)=>{
  if(args.includes('--version'))return{code:0,stdout:'tauri-cli 2.11.4',stderr:''};
  if(file==='rustc')return{code:0,stdout:'rustc 1.93.0\nhost: x86_64-pc-windows-msvc',stderr:''};
  assert.deepEqual(args.slice(1),['build','--ci','--target','x86_64-pc-windows-msvc','--no-bundle','--','--locked','--offline']);
  assert.equal(args[0],cli);assert.ok(options?.cwd?.includes('build-cache'));
  assert.deepEqual(await readdir(join(options!.cwd!,'capabilities')),[]);
  for(const key of ['OPENAI_API_KEY','NODE_OPTIONS','RUSTFLAGS','TAURI_CONFIG'])assert.equal(options?.env?.[key],undefined);
  const target=options!.env!.CARGO_TARGET_DIR!;caches.push(target);
  const output=join(target,'x86_64-pc-windows-msvc/release/agent-company-beta.exe');await mkdir(dirname(output),{recursive:true});await writeFile(output,pe());await afterBuild();
  return{code:0,stdout:'compiled fixture',stderr:''};
 };
 const build=(id:string)=>compileDesktopNative({projectRoot:root,destination:join(root,'desktop/builds',id)},{command:run,assertSpace:async()=>{}});
 return{root,source,caches,build,setAfterBuild:(fn:()=>Promise<void>)=>{afterBuild=fn;}};
}
test('native-only builds reuse stable source timestamps and cache, preserving independent release artifacts',async t=>{
 const f=await fixture(t);const one=await f.build('one');
 const cacheSource=join(dirname(f.caches[0]),'project/src-tauri/src/lib.rs');const stat=await lstat(cacheSource,{bigint:true});
 const two=await f.build('two');assert.equal(one.cacheKey,two.cacheKey);assert.equal(f.caches[0],f.caches[1]);
 assert.equal((await lstat(cacheSource,{bigint:true})).mtimeNs,stat.mtimeNs);
 assert.equal((await lstat(join(f.root,'desktop/builds/one/agent-company-beta.exe'))).nlink,1);
 await assert.rejects(lstat(join(f.root,'desktop/builds/one/payload')),{code:'ENOENT'});
 const sources=await desktopNativeSources(f.source);await verifyDesktopNativeBuild(join(f.root,'desktop/builds/one'),sources);
 await writeFile(join(f.source,'src/window_close.rs'),(await readFile(join(f.source,'src/window_close.rs'),'utf8'))+'\n// changed\n');
 await f.build('three');assert.equal(f.caches[2],f.caches[0]);
 await assert.rejects(verifyDesktopNativeBuild(join(f.root,'desktop/builds/one'),await desktopNativeSources(f.source)),/SOURCE_MISMATCH/);
 assert.deepEqual(await readFile(join(f.root,'desktop/builds/one/agent-company-beta.exe')),pe());
});
test('failed compilation and mid-build source mutation cannot produce a publishable receipt',async t=>{
 const f=await fixture(t);f.setAfterBuild(async()=>{await writeFile(join(f.source,'src/lib.rs'),'changed during compile');});
 await assert.rejects(f.build('changed'),/SOURCE_CHANGED/);
 await assert.rejects(lstat(join(f.root,'desktop/builds/changed/native-build.json')),{code:'ENOENT'});
});
test('concurrent builds cannot mutate the same compiler workspace',async t=>{
 const f=await fixture(t);let entered!:()=>void,unblock!:()=>void;
 const ready=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>unblock=r);
 f.setAfterBuild(async()=>{entered();await held;});const first=f.build('first');await ready;
 try{await assert.rejects(f.build('second'),/already being held|ELOCKED/);}finally{unblock();}
 await first;assert.equal(f.caches.length,1);
});
test('cache tampering is refused before a compiler call; immutable native tampering is refused before bundling',async t=>{
 const f=await fixture(t);await f.build('one');
 await writeFile(join(dirname(f.caches[0]),'project/src-tauri/src/lib.rs'),'tampered');
 await assert.rejects(f.build('two'),/DESKTOP_PROVIDER/);assert.equal(f.caches.length,1);
 await writeFile(join(f.root,'desktop/builds/one/agent-company-beta.exe'),Buffer.from('tampered'));
 await assert.rejects(verifyDesktopNativeBuild(join(f.root,'desktop/builds/one'),await desktopNativeSources(f.source)),/DESKTOP_PROVIDER/);
});
