// Executed only by NSIS while its exclusive install lease remains held.
// The new installer supplies this helper, Node, and the candidate manifest.
import { createHash } from 'node:crypto';
import { lstat, open, realpath, writeFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

const fail = () => { throw new Error('DESKTOP_INSTALLER_CLEANUP_REFUSED'); };
const sha = data => createHash('sha256').update(data).digest('hex');
const legacy = [{ path: 'resources/dist/assets/index-DhdVwP1e.js', bytes: 582084,
  sha256: '298fef4725c62ee09b591eb47d118c14504c80c25ec5839fc8fa458782f46352' }];

function files(value) {
  if (value?.version !== 1 || value.protocol !== 1 || value.target !== 'x86_64-pc-windows-msvc'
    || !Array.isArray(value.files) || value.files.length > 20000) fail();
  const seen = new Set();
  return value.files.map(file => {
    if (!file || typeof file.path !== 'string' || file.path.length > 240
      || !/^(resources|binaries)\//.test(file.path)
      || /[\\<>:"|?*\u0000-\u001f\u007f]/u.test(file.path)
      || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
        || ['.data', '.verification', '.git', 'credentials', 'backups'].includes(part.toLowerCase())
        || part.toLowerCase().startsWith('.env') || part.toLowerCase().endsWith('.map'))
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)
      || seen.has(file.path.toLowerCase())) fail();
    seen.add(file.path.toLowerCase());
    return { path: file.path, bytes: file.bytes, sha256: file.sha256 };
  });
}

async function directory(path) {
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail();
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()) fail();
    if (cursor === dirname(cursor)) break;
  }
}

async function regular(path, limit, streamed = false) {
  await directory(dirname(path));
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail();
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
    let data, digest;
    if (streamed) {
      const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      for (;;) {
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      digest = hash.digest('hex');
    } else data = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
    return { data, digest, info: before };
  } finally { await handle.close(); }
}

async function manifest(path) {
  const { data } = await regular(path, 16 * 1024 * 1024);
  return { hash: sha(data), files: files(JSON.parse(data.toString('utf8'))) };
}

async function inspect(root, file) {
  try {
    const result = await regular(join(root, file.path), file.bytes, true);
    if (result.info.size !== file.bytes || result.digest !== file.sha256) fail();
    return result.info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function main() {
  const [mode, root, candidatePath, planPath] = process.argv.slice(2);
  if (!['prepare', 'commit'].includes(mode) || process.argv.length !== 6) fail();
  await directory(root);
  const candidate = await manifest(candidatePath);
  const current = new Set(candidate.files.map(file => file.path.toLowerCase()));
  if (planPath !== join(root, 'payload-retirement.json')) fail();
  if (mode === 'prepare') {
    // A failed install keeps the old ownership plan even if it already copied
    // the new manifest. Only the identical candidate may resume that plan.
    try {
      const prior = JSON.parse((await regular(planPath, 16 * 1024 * 1024)).data.toString('utf8'));
      if (prior.version !== 1 || prior.root !== root || prior.candidate !== candidate.hash) fail();
      const pending = files({ version: 1, protocol: 1, target: 'x86_64-pc-windows-msvc', files: prior.obsolete });
      for (const file of pending) { if (current.has(file.path.toLowerCase())) fail(); await inspect(root, file); }
      console.log(JSON.stringify({ phase: mode, resumed: true, obsolete: pending.length }));
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let old = [];
    try { old = (await manifest(join(root, 'payload-manifest.json'))).files; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const choices = new Map();
    for (const file of [...old, ...legacy]) {
      if (current.has(file.path.toLowerCase())) continue;
      const prior = choices.get(file.path.toLowerCase());
      if (prior && (prior.sha256 !== file.sha256 || prior.bytes !== file.bytes)) fail();
      choices.set(file.path.toLowerCase(), file);
    }
    const obsolete = [];
    for (const file of choices.values()) if (await inspect(root, file)) obsolete.push(file);
    await writeFile(planPath, JSON.stringify({ version: 1, root, candidate: candidate.hash, obsolete }), { flag: 'wx' });
    console.log(JSON.stringify({ phase: mode, obsolete: obsolete.length }));
    return;
  }
  const plan = JSON.parse((await regular(planPath, 16 * 1024 * 1024)).data.toString('utf8'));
  if (plan.version !== 1 || plan.root !== root || plan.candidate !== candidate.hash) fail();
  const obsolete = files({ version: 1, protocol: 1, target: 'x86_64-pc-windows-msvc', files: plan.obsolete });
  if (obsolete.some(file => current.has(file.path.toLowerCase()))) fail();
  // Only retire after the complete new payload was copied successfully.
  if ((await manifest(join(root, 'payload-manifest.json'))).hash !== candidate.hash) fail();
  for (const file of candidate.files) if (!await inspect(root, file)) fail();
  // Validate every obsolete file before the first deletion. Recheck identity
  // immediately before each unlink; never recurse, follow links, or defer deletes.
  const inspected = [];
  for (const file of obsolete) inspected.push({ file, info: await inspect(root, file) });
  let removed = 0;
  for (const { file, info } of inspected) {
    if (!info) continue; // Supports retry after interruption between deletions.
    const path = join(root, file.path), again = await inspect(root, file);
    if (!again || again.dev !== info.dev || again.ino !== info.ino || again.ctimeMs !== info.ctimeMs) fail();
    await unlink(path); removed++;
  }
  console.log(JSON.stringify({ phase: mode, removed }));
  await unlink(planPath);
}

main().catch(() => { console.error('DESKTOP_INSTALLER_CLEANUP_REFUSED'); process.exitCode = 2; });
