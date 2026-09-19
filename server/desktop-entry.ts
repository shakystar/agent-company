export { desktopMigrationCutoverCapability } from './desktop-migration-cutover.ts';
import { runDesktopProtocol } from './desktop-protocol.ts';
import { startDesktopController } from './desktop-controller.ts';

// Native parent sends one private JSON frame through stdin. This entry deliberately
// does not load .env, discover a workspace, import user credentials or choose port 4310.
if (process.argv.length !== 2) {
  process.stderr.write('설치형 서버는 앱의 전용 입력으로 시작해야 합니다.\n');
  process.exitCode = 1;
} else {
  const stop = () => process.stdin.emit('end');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = await runDesktopProtocol({ input: process.stdin, output: process.stdout, start: startDesktopController }); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdin.destroy(); }
}
