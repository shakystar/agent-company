import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Writable } from 'node:stream';

/** A fixed, credential-free writer isolates Windows' synchronous stdout pipe. */
export async function desktopMcpOutput(): Promise<{ stream: Writable; close(): Promise<boolean> }> {
  const filename = fileURLToPath(import.meta.url);
  const args = filename.endsWith('.ts') ? ['--import', import.meta.resolve('tsx'), filename] : [filename];
  const env: NodeJS.ProcessEnv = filename.endsWith('.ts') ? { TSX_DISABLE_CACHE: '1' } : {};
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, args, { cwd: dirname(filename), env, windowsHide: true,
    stdio: ['overlapped', 1, 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
    // close follows process exit and pipe closure. A failed kill must not be
    // mistaken for the exit of a writer that is still alive.
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  // The writer emits only a fixed diagnostic; never forward child stderr into stdout.
  child.stderr?.resume();
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn); child.once('error', () => reject(new Error('DESKTOP_MCP_OUTPUT_FAILED')));
  });
  let closing: Promise<boolean> | undefined;
  return { stream: child.stdin!, close: () => closing ??= (async () => {
    child.stdin!.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exited, new Promise<null>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), 500); })]);
    if (timer) clearTimeout(timer);
    if (result) return result.code === 0;
    // The client has ended the session. A writer blocked in its OS stdout write
    // has no credentials or remote work; terminate it and wait for actual exit.
    const killed = child.kill('SIGTERM');
    const final = await exited;
    return killed || final.code === 0;
  })() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fail = () => { process.stderr.write('DESKTOP_MCP_OUTPUT_FAILED\n', () => process.exit(1)); };
  if (process.argv.length !== 2) fail();
  else {
    process.stdin.on('data', chunk => { if (!process.stdout.write(chunk)) process.stdin.pause(); });
    process.stdout.on('drain', () => process.stdin.resume());
    process.stdin.once('end', () => process.stdout.end(() => process.exit(0)));
    process.stdin.once('error', fail); process.stdout.once('error', fail);
  }
}
