import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

// Uses the exact production entry point, with only the approved verification gate added.
const child = spawn(process.execPath, ['--import', 'tsx', resolve('server/index.ts'), '--verify-operation'], {
  windowsHide: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const stop = () => { if (child.connected) child.send!({ type: 'shutdown' }); };
const commands = createInterface({ input: process.stdin });
commands.on('line', line => { if (line.trim() === 'stop') stop(); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
child.on('exit', code => { commands.close(); process.exit(code ?? 1); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; commands.close(); });
