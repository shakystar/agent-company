import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface CommandOptions {
  cwd?: string;
  /** Explicit child environment for installed runtimes; ordinary CLI callers retain their current environment. */
  env?: NodeJS.ProcessEnv;
  /** Final synchronous admission check after wrappers have completed asynchronous preparation. */
  beforeSpawn?: () => void;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  interactive?: boolean;
  onLine?: (line: string) => void | string | Promise<void | string>;
  /** Bounded binary transfers bypass text capture and await each consumer write. */
  onStdout?: (chunk: Buffer) => void | Promise<void>;
  captureStdout?: boolean;
  inputStream?: AsyncIterable<Uint8Array | string>;
}
export interface CommandResult { code: number; stdout: string; stderr: string }
export type Command = (file: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** No shell interpolation; a cancelled CLI never counts as successful work. */
export const command: Command = (file, args, options = {}) => new Promise((resolve, reject) => {
  options.signal?.throwIfAborted();
  options.beforeSpawn?.();
  const child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: options.env } : {}), ...(options.cwd ? { cwd: options.cwd } : {}) });
  let stdout = '', stderr = '', pending = '', failure: Error | undefined;
  let inputCompletion = Promise.resolve();
  let stopNotifications!: () => void;
  const notificationsStopped = new Promise<void>(resolve => { stopNotifications = resolve; });
  const fail = (error: Error) => {
    failure ??= error;
    stopNotifications();
    child.kill('SIGKILL');
    // A blocked consumer cannot drain the pipes after cancellation. Closing our
    // handles lets the child close event settle independently of that consumer.
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  };
  const abort = () => fail(new Error('실행이 취소됐습니다.'));
  const timer = setTimeout(() => fail(new Error('실행 제한 시간을 초과했습니다.')), options.timeoutMs ?? 30_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
  const line = async (value: string) => {
    if (failure) return;
    const response = await options.onLine?.(value);
    if (failure || !options.interactive || typeof response !== 'string') return;
    if (/[\r\n]/.test(response) || Buffer.byteLength(response, 'utf8') > 1024 * 1024) {
      throw new Error('대화형 실행 응답은 1 MiB 이하의 단일 JSONL 줄이어야 합니다.');
    }
    if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error('실행 입력 연결이 종료되어 도구 응답을 전달하지 못했습니다.');
    await new Promise<void>((written, rejected) => {
      child.stdin.write(`${response}\n`, error => error ? rejected(error) : written());
    });
  };
  child.stderr.setEncoding('utf8');
  const notifications = (async () => {
    const decoder = new StringDecoder('utf8');
    for await (const raw of child.stdout) {
      if (failure) return;
      const buffer = Buffer.from(raw);
      await options.onStdout?.(buffer);
      if (options.captureStdout === false && !options.onLine) continue;
      const chunk = decoder.write(buffer);
      if (options.captureStdout !== false) {
        stdout += chunk;
        if (stdout.length > 16 * 1024 * 1024) throw new Error('실행 출력 한도를 초과했습니다.');
      }
      if (options.onLine) {
        pending += chunk;
        for (let index; (index = pending.indexOf('\n')) >= 0;) {
          await line(pending.slice(0, index)); pending = pending.slice(index + 1);
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error('실행 출력 줄 한도를 초과했습니다.');
      }
    }
    const tail = decoder.end();
    if (options.captureStdout !== false) stdout += tail;
    if (options.onLine && pending + tail) await line(pending + tail);
  })().catch(error => fail(error));
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
  child.on('error', error => { cleanup(); reject(error); });
  child.on('close', async code => {
    await Promise.race([Promise.all([notifications, inputCompletion]), notificationsStopped]);
    cleanup();
    if (failure) reject(failure);
    else resolve({ code: code ?? 1, stdout, stderr });
  });
  child.stdin.on('error', error => {
    if (options.interactive || (error as NodeJS.ErrnoException).code !== 'EPIPE') fail(error);
  });
  if (options.inputStream) {
    inputCompletion = (async () => {
      if (options.interactive || options.input !== undefined) throw new Error('스트림 입력과 대화형 입력을 함께 사용할 수 없습니다.');
      await pipeline(Readable.from(options.inputStream!, { objectMode: false }), child.stdin);
    })().catch(error => fail(error));
  } else if (options.interactive) child.stdin.write(`${options.input ?? ''}\n`);
  else child.stdin.end(options.input ?? '');
});
