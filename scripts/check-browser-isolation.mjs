// Standalone, no-model verification inside a fresh browser image with the exact
// production isolation flags. Send this source on stdin to `node --input-type=module -`;
// do not mount a host workspace, credentials or a Docker socket to run this check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserSession, LIMITS } from '/app/browser.mjs';

const checks = [];
const passed = (name, detail) => { checks.push({ name, passed: true, detail }); process.stderr.write(`passed: ${name}\n`); };
assert.equal(process.getuid(), 1000);
const status = await readFile('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/m); assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^Seccomp:\s+2$/m);
passed('unprivileged-process', 'uid 1000, no effective capabilities, no-new-privileges, seccomp filtering');
const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
  const fields = line.split(' - ')[0].split(' '); return { path: fields[4], options: fields[5].split(',') };
});
assert.ok(mounts.find(mount => mount.path === '/')?.options.includes('ro'));
assert.ok(!mounts.some(mount => /^\/(?:workspace|credentials|run\/secrets|var\/run\/docker.sock|home\/node\/\.codex)(?:\/|$)/.test(mount.path)));
assert.ok(mounts.find(mount => mount.path === '/tmp')?.options.includes('rw'));
passed('filesystem-boundaries', 'Read-only root, private temporary storage, no workspace or credential mounts');
for (const path of ['/workspace', '/credentials', '/run/secrets', '/var/run/docker.sock', '/home/node/.codex/auth.json', '/root/.codex/auth.json']) {
  await assert.rejects(lstat(path), error => ['ENOENT', 'EACCES'].includes(error.code));
}
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'AGENT_SECRET_DIR', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH']) assert.equal(process.env[key], undefined);
assert.deepEqual((await readdir('/sys/class/net')).sort(), ['lo']);
const routeRows = (await readFile('/proc/net/route', 'utf8')).trim().split('\n'); assert.equal(routeRows.length, 1);
passed('no-auth-no-external-network', 'No known credentials or runtime overrides; loopback is the only interface and no IPv4 routes exist');
await assert.rejects(async () => { const handle = await open('/app/.browser-isolation-write-probe', 'wx'); await handle.close(); }, error => ['EROFS', 'EACCES'].includes(error.code));
passed('root-write-denied', 'Create denied after verifying read-only root');
const deniedChroot = await promisify(execFile)('perl', ['-e', 'my $path="/app"; my $r=syscall(161,$path); print "$r:".(0+$!);']);
assert.equal(deniedChroot.stdout, '-1:1');
await assert.rejects(readFile('/etc/shadow'), error => error.code === 'EACCES');
passed('outer-chroot-and-protected-file-denied', 'chroot remains EPERM outside the nested user namespace; /etc/shadow remains EACCES');
const font = await promisify(execFile)('fc-match', ['Noto Sans CJK KR']); assert.match(font.stdout, /NotoSansCJK/i);
passed('korean-font', 'Noto Sans CJK is installed');

const session = new BrowserSession();
const file = (path, content) => ({ path, contentBase64: Buffer.from(content).toString('base64') });
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>브라우저 격리 검사</title>
<style>body{font-family:"Noto Sans CJK KR",sans-serif;padding:32px}input,button{font:inherit}</style>
<h1>실제 한글 화면</h1><label for="name">이름</label><input id="name"><button id="save">저장</button><p id="result"></p>
<img src="https://blocked.example.invalid/never-requested.png" alt="차단 검사">
<script>document.querySelector('#save').addEventListener('click',()=>{localStorage.setItem('name',document.querySelector('#name').value);document.querySelector('#result').textContent='저장: '+localStorage.getItem('name')});</script></html>`;
try {
  const first = await session.dispatch({ action: 'open', files: [file('index.html', html)], entry: 'index.html', viewport: { width: 390, height: 844 } });
  const input = first.elements.find(element => element.tag === 'input'); assert.ok(input);
  const filled = await session.dispatch({ action: 'fill', ref: input.ref, value: '한글 보존' });
  const button = filled.elements.find(element => element.tag === 'button'); assert.ok(button);
  const clicked = await session.dispatch({ action: 'click', ref: button.ref }); assert.match(clicked.snapshot, /저장: 한글 보존/);
  await assert.rejects(session.dispatch({ action: 'click', ref: button.ref }), /expired/);
  assert.equal(await session.page.evaluate(() => localStorage.getItem('name')), '한글 보존');
  passed('stateful-real-browser', 'Independent actions preserve input, DOM and localStorage; stale refs fail');
  assert.ok(session.diagnostics.some(item => item.message.includes('blocked.example.invalid')
    && (item.kind === 'requestblocked' || /Content Security Policy/i.test(item.message))));
  passed('external-subresource-blocked', 'External image is blocked by CSP or the browser route before dispatch');
  const shot = await session.dispatch({ action: 'screenshot' });
  const bytes = Buffer.from(shot.content[0].data, 'base64'); assert.ok(bytes.length > 1000 && bytes.length <= LIMITS.screenshot);
  assert.equal(shot.metadata.width, 390); assert.equal(shot.metadata.height, 844);
  passed('actual-jpeg', { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), width: 390, height: 844 });
  await session.dispatch({ action: 'resize', width: 1440, height: 900 });
  const desktop = await session.dispatch({ action: 'screenshot' }); assert.equal(desktop.metadata.width, 1440);
  passed('viewport-resize', '390 by 844 and 1440 by 900 captures succeeded');
  await assert.rejects(session.page.goto('https://blocked.example.invalid/navigation', { waitUntil: 'domcontentloaded' }), /ERR_BLOCKED_BY_CLIENT/);
  assert.ok(session.diagnostics.some(item => item.kind === 'requestblocked' && item.message.includes('blocked.example.invalid/navigation')));
  passed('external-navigation-blocked', 'The browser route aborts a top-level external navigation before dispatch');
  await session.dispatch({ action: 'open', files: [file('index.html', '<h1>교체된 자료</h1>')], entry: 'index.html' });
  assert.equal(await session.page.evaluate(() => localStorage.getItem('name')), null);
  passed('source-replacement-clears-context', 'New open replaces sources and localStorage context');

  // Inspect only this sandboxed browser's own internal diagnostics, not a host
  // browser or a user profile. This page is never exposed through the agent API.
  const internal = await session.browser.newContext();
  try {
    const page = await internal.newPage(); await page.goto('chrome://sandbox');
    const report = await page.locator('body').innerText();
    assert.match(report, /(?:PID namespaces|Namespace sandbox)\s+Yes/i);
    assert.match(report, /Seccomp-BPF sandbox\s+Yes/i);
    passed('chromium-sandbox', report.slice(0, 4000));
  } finally { await internal.close(); }
} finally { await session.dispose(); }
process.stdout.write(`${JSON.stringify({ modelCalls: 0, checks })}\n`);
