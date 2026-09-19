import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { command, type Command, type CommandOptions } from './process.ts';
import type { RuntimeConfig } from './runtime.ts';
import { workerImageSchema, workerSourceFiles, stableRuntimeHash } from '../shared/runtime-releases.ts';

// Docker exports the merged image filesystem without starting its process. The
// parser reads archive bytes, so protected directories need no extra capability.
export const baseFingerprintScript = `import sys, tarfile, hashlib, json
skip=set(['/proc','/sys','/dev','/etc/hostname','/etc/hosts','/etc/resolv.conf','/.dockerenv'])
worker=set(${JSON.stringify(workerSourceFiles.map(name => `/app/${name}`))})
rows={}; links={}; total=0
def pathof(name):
 while name.startswith('./'): name=name[2:]
 parts=name.strip('/').split('/') if name.strip('/') else []
 if any(part in ('','.','..') for part in parts): raise RuntimeError('unsafe archive path '+name)
 return '/'+('/'.join(parts))
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
 for item in archive:
  path=pathof(item.name)
  if any(path==s or path.startswith(s+'/') for s in skip): continue
  if path in rows or len(rows)>=500000: raise RuntimeError('duplicate or excessive archive entry '+path)
  attrs={k:v for k,v in item.pax_headers.items() if k not in ('mtime','atime','ctime','path','linkpath','size','uid','gid','uname','gname')}
  row=[path,item.mode,item.uid,item.gid,attrs]
  if path in worker:
   if not item.isreg(): raise RuntimeError('worker source is not an ordinary file '+path)
   row+=['worker-source']
  elif item.issym(): row+=['link',item.linkname]
  elif item.islnk():
   links[path]=pathof(item.linkname); row+=['hardlink',links[path]]
  elif item.isreg():
   total+=item.size
   if item.size<0 or total>16*1024*1024*1024: raise RuntimeError('image filesystem exceeds limit')
   digest=hashlib.sha256(); size=0
   with archive.extractfile(item) as f:
    while True:
     data=f.read(1024*1024)
     if not data: break
     size+=len(data); digest.update(data)
   if size!=item.size: raise RuntimeError('truncated archive file '+path)
   row+=['file',item.size,digest.hexdigest()]
  elif item.isdir(): row+=['directory']
  else: raise RuntimeError('unsupported image filesystem entry '+path)
  rows[path]=row
if not worker.issubset(rows): raise RuntimeError('worker source is missing from image archive')
for path,target in links.items():
 seen={path}
 while target in links:
  if target in seen: raise RuntimeError('cyclic archive hardlink '+path)
  seen.add(target); target=links[target]
 if target in worker or target not in rows or rows[target][5]!='file': raise RuntimeError('invalid archive hardlink '+path)
# Drain Docker archive padding before exiting, so the producer finishes normally.
while sys.stdin.buffer.read(1024*1024): pass
h=hashlib.sha256()
for path in sorted(rows): h.update((json.dumps(rows[path],sort_keys=True,separators=(',',':'))+chr(10)).encode())
print(h.hexdigest())`;

export async function inspectImageRuntimeBase(config: RuntimeConfig, image: string, ownerKey: string, runner: Command = command): Promise<string> {
  workerImageSchema.parse(image); z.uuid().parse(ownerKey);
  if (config.mode !== 'docker') throw new Error('이미지 기반 검사는 로컬 Docker만 지원합니다.');
  const docker = (args: string[], options: CommandOptions = {}) => runner(config.wslDistro ? 'wsl.exe' : 'docker', config.wslDistro
    ? ['--distribution', config.wslDistro, '--exec', 'docker', ...args] : args, { timeoutMs: 60_000, ...options });
  const checked = async (args: string[], options?: CommandOptions) => {
    const result = await docker(args, options);
    if (result.code !== 0) throw new Error(`이미지 파일시스템 fingerprint 실패 (${args[0]}): ${result.stderr.slice(-1000)}`);
    return result;
  };
  const inspected = JSON.parse((await checked(['image', 'inspect', image, '--format', '{{json .}}'])).stdout);
  if (inspected.Id !== image || inspected.Os !== 'linux' || inspected.Architecture !== 'amd64' || !inspected.Config
    || typeof inspected.Config !== 'object' || Array.isArray(inspected.Config)) throw new Error('이미지 실행 기반 식별자가 올바르지 않습니다.');
  if (inspected.Config.Volumes && Object.keys(inspected.Config.Volumes).length) throw new Error('VOLUME 선언이 있는 이미지는 파일시스템 전체 검사를 지원하지 않습니다.');
  const source = `ac-release-base-${ownerKey}-source`, parser = `ac-release-base-${ownerKey}-parser`;
  const roles = new Map([[source, 'release-base-source'], [parser, 'release-base-parser']]);
  const flags = (name: string) => ['--name', name, '--label', 'app=agent-company', '--label', `agent-company.workspace=${ownerKey}`,
    '--label', `agent-company.role=${roles.get(name)}`, '--read-only', '--network=none', '--user=1000:1000', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=32', '--pull=never'];
  const cleanup = async (name: string) => {
    const result = await docker(['inspect', name, '--format', '{{json .Config.Labels}}'], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      if (/No such (?:object|container)/i.test(result.stderr)) return;
      throw new Error('이미지 기반 검사 컨테이너 정리를 확인하지 못했습니다.');
    }
    const labels = JSON.parse(result.stdout);
    if (labels.app !== 'agent-company' || labels['agent-company.workspace'] !== ownerKey || labels['agent-company.role'] !== roles.get(name)) {
      throw new Error('이미지 기반 검사 컨테이너의 소유권이 다릅니다.');
    }
    await checked(['rm', '-f', name]);
  };
  try {
    await checked(['create', ...flags(source), '--memory=64m', '--cpus=0.25', '--entrypoint=/bin/true', image]);
    const bridge = new PassThrough({ highWaterMark: 64 * 1024 }), cancellation = new AbortController();
    bridge.on('error', () => {});
    const fail = (error: unknown): never => { cancellation.abort(); bridge.destroy(); throw error; };
    const parsing = checked(['run', '--rm', '-i', ...flags(parser), '--memory=256m', '--cpus=1', '--entrypoint=python3', image, '-B', '-c', baseFingerprintScript],
      { inputStream: bridge, signal: cancellation.signal, timeoutMs: 300_000 }).catch(fail);
    let bytes = 0;
    const exporting = checked(['export', source], { signal: cancellation.signal, timeoutMs: 300_000, captureStdout: false,
      onStdout: async chunk => {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024 * 1024) throw new Error('이미지 archive 전송 한도를 초과했습니다.');
        await new Promise<void>((resolve, reject) => bridge.write(chunk, error => error ? reject(error) : resolve()));
      },
    }).then(result => { bridge.end(); return result; }).catch(fail);
    const results = await Promise.allSettled([parsing, exporting]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const filesystem = z.string().regex(/^[a-f0-9]{64}$/).parse(results[0].status === 'fulfilled' ? results[0].value.stdout.trim() : '');
    return stableRuntimeHash({ version: 2, method: 'docker-export', filesystem, os: inspected.Os,
      architecture: inspected.Architecture, variant: inspected.Variant ?? null, config: inspected.Config });
  } finally {
    const results = await Promise.allSettled([cleanup(parser), cleanup(source)]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '이미지 기반 검사 컨테이너 정리를 완료하지 못했습니다.');
  }
}
