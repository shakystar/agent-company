import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, connect } from 'node:net';

const exec = promisify(execFile);
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /NoNewPrivs:\s+1/);
assert.match(status, /CapEff:\s+0000000000000000/);
assert.match(status, /CapBnd:\s+0000000000000000/);
assert.match(status, /Seccomp:\s+2/);
assert.equal(process.getuid(), 1000);
await writeFile('/home/node/.codex/outside-sentinel', 'unchanged');
const server = createServer(socket => socket.end('outer-only'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1', () => { socket.resume(); });
  socket.on('end', resolve);
  socket.on('error', reject);
});
try {
  const checks = `
import os, socket, json
from pathlib import Path
assert os.getuid() == 1000
Path('/workspace/allowed.txt').write_text('workspace-ok')
blocked = False
try: Path('/home/node/.codex/outside-sentinel').write_text('changed')
except PermissionError: blocked = True
except OSError as error: blocked = error.errno == 30
assert blocked, 'sandbox allowed write outside workspace'
network = None
blocked = False
try:
    network = socket.socket()
    network.settimeout(2)
    network.connect(('127.0.0.1', ${port}))
except OSError: blocked = True
finally:
    if network: network.close()
assert blocked, 'sandbox reached outer network listener'
print(json.dumps({'workspaceWrite': True, 'outsideWriteBlocked': True, 'networkBlocked': True}))
`;
  const args = ['-c', 'sandbox_mode="workspace-write"',
    '-c', 'sandbox_workspace_write.network_access=false', 'sandbox', '--', 'python3', '-c', checks];
  const trace = process.env.AGENT_VERIFY_TRACE === '1';
  const result = await exec(trace ? 'strace' : 'codex', trace ? ['-qq', '-f', '-e', 'trace=mount', 'codex', ...args] : args, { timeout: 30_000 });
  assert.equal(await readFile('/workspace/allowed.txt', 'utf8'), 'workspace-ok');
  assert.equal(await readFile('/home/node/.codex/outside-sentinel', 'utf8'), 'unchanged');
  const denied = await exec('python3', ['-c', `
import ctypes, errno, json
libc = ctypes.CDLL(None, use_errno=True)
checks = [('clone3',435,0,0,0,38),('setns',308,-1,0,0,1),('bpf',321,0,0,0,1),('keyctl',250,0,0,0,1),('unshare_net',272,0x40000000,0,0,1)]
for name, number, a, b, c, expected in checks:
    ctypes.set_errno(0)
    result = libc.syscall(ctypes.c_long(number), ctypes.c_long(a), ctypes.c_long(b), ctypes.c_long(c))
    assert result == -1 and ctypes.get_errno() == expected, (name,result,ctypes.get_errno())
print(json.dumps({'blockedSyscalls':[item[0] for item in checks]}))
`]);
  console.log(JSON.stringify({ ...JSON.parse(result.stdout), ...JSON.parse(denied.stdout),
    uid: process.getuid(), noNewPrivileges: true, capabilities: 'none',
    memoryMax: (await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(),
    cpuMax: (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(),
    pidsMax: (await readFile('/sys/fs/cgroup/pids.max', 'utf8')).trim() }));
} finally { await new Promise(resolve => server.close(resolve)); }
