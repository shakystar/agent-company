import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import lockfile from 'proper-lockfile';
import { WorkspaceStore } from '../server/store.ts';
import { activeStorage, secureDirectory } from '../server/storage.ts';
import { ContainerRuntime, runtimeConfig } from '../server/runtime.ts';
import { selectedRuntimeConfig, resolveImage, dockerForRelease } from '../server/releases.ts';

if (existsSync('.env')) loadEnvFile('.env');
const root = resolve(process.env.AGENT_DATA_DIR ?? '.data');
const campaign = resolve('.verification/operation-20260907');
await secureDirectory(campaign);
const manifestPath = join(campaign, 'baseline.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.root !== root) throw new Error('기존 운영 전환 원본 경로가 다릅니다.');
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')) throw new Error('보존 경로가 올바르지 않습니다.');
    const bytes = await readFile(join(campaign, 'baseline-data', file.path));
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('운영 전환 전 보존본이 변경됐습니다.');
  }
  console.log(JSON.stringify({ preserved: true, ...manifest, files: manifest.files.length }, null, 2));
} else {
  const release = await lockfile.lock(root, { lockfilePath: join(root, 'controller.lock'), stale: 30_000, update: 10_000, retries: 0 });
  try {
    const ownerKey = (await readFile(join(root, 'workspace-id'), 'utf8')).trim();
    const selected = await activeStorage({ rootDir: root, ownerKey, backupDir: process.env.AGENT_BACKUP_DIR! });
    const config = await selectedRuntimeConfig(root, ownerKey, runtimeConfig());
    const live = await dockerForRelease(config, ['ps', '--filter', `label=agent-company.workspace=${selected.workspaceKey}`, '--format', '{{.ID}}']);
    if (live) throw new Error('원래 작업실의 컨테이너가 실행 중입니다. 전환하지 않았습니다.');
    const copyRoot = join(campaign, 'baseline-data');
    await mkdir(copyRoot); // Partial copies remain evidence; never overwrite or silently retry them.
    let copiedBytes = 0;
    const files: Array<{ path: string; bytes: number; sha256: string }> = [];
    const copy = async (source: string, destination: string) => {
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error('원본 데이터의 링크를 자동 복사하지 않습니다.');
      if (info.isDirectory()) {
        await mkdir(destination, { recursive: true });
        for (const entry of await readdir(source)) {
          if (source === root && entry === 'controller.lock') continue;
          await copy(join(source, entry), join(destination, entry));
        }
      } else {
        if (!info.isFile() || info.nlink !== 1) throw new Error('원본 데이터에 독립 일반 파일이 아닌 항목이 있습니다.');
        copiedBytes += info.size;
        if (copiedBytes > 1024 ** 3) throw new Error('전환 전 DB 보존본이 1GiB를 넘습니다. 통합 백업으로 전환 계획을 조정해야 합니다.');
        const disk = await statfs(campaign);
        if (disk.bavail * disk.bsize - info.size < 20 * 1024 ** 3) throw new Error('전환 보존본을 만들 실제 디스크 여유가 부족합니다.');
        await copyFile(source, destination, 1);
        const original = await readFile(source), saved = await readFile(destination);
        const sha256 = createHash('sha256').update(saved).digest('hex');
        if (createHash('sha256').update(original).digest('hex') !== sha256) throw new Error('운영 데이터 보존본의 바이트가 일치하지 않습니다.');
        files.push({ path: relative(root, source).replaceAll('\\', '/'), bytes: saved.length, sha256 });
      }
    };
    await copy(root, copyRoot);
    const store = await WorkspaceStore.open(join(selected.dataDir, 'db'));
    let state;
    try { state = await store.read(); } finally { await store.close(); }
    const unfinished = state.runs.filter(run => !['succeeded', 'failed', 'cancelled'].includes(run.status));
    if (unfinished.length) throw new Error(`전환 전에 확인할 기존 미완료 작업이 ${unfinished.length}개 있습니다. 보존본을 유지합니다.`);
    const volumes = await new ContainerRuntime({ ...config, workspaceKey: selected.workspaceKey }).listWorkspaceVolumes();
    const manifest = { version: 1, root, ownerKey, selected, createdAt: new Date().toISOString(), imageId: await resolveImage(config, config.image),
      bytes: copiedBytes, files, volumes, state: { agents: state.agents.length, teams: state.teams.length, projects: state.projects.length,
        runs: state.runs.length, unfinished: unfinished.length, operatorPaused: state.operatorPaused },
      environmentHash: createHash('sha256').update(await readFile(resolve('.env'))).digest('hex') };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ ...manifest, files: files.length }, null, 2));
  } finally { await release(); }
}
