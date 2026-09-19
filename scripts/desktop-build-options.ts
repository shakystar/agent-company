import { isAbsolute } from 'node:path';

/** Explicit packaging inputs; never infer installed tools or an operating image. */
export function desktopBuildArguments(args: string[]): { codexExecutable?: string; workerPackage?: string } {
  const options: { codexExecutable?: string; workerPackage?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === '--codex-executable' ? 'codexExecutable' : args[index] === '--worker-package' ? 'workerPackage' : null;
    const value = args[index + 1];
    if (!key || options[key] || !value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('명시한 Codex 실행파일과 worker package의 절대 경로가 필요합니다.');
    }
    options[key] = value;
  }
  if (options.workerPackage && !options.codexExecutable) throw new Error('worker package에는 동봉 Codex 실행파일도 필요합니다.');
  return options;
}
