import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readDesktopMcpEndpoint } from './desktop-mcp-endpoint.ts';
import { runDesktopMcpProtocol, DesktopMcpCallError, type DesktopMcpCall } from './desktop-mcp-protocol.ts';
import { desktopMcpOutput } from './desktop-mcp-output.ts';

export function desktopMcpArguments(args: string[], token: string | undefined) {
  if (args.length !== 6 || args[0] !== '--endpoint-file' || args[2] !== '--owner-key' || args[4] !== '--grant-id') throw new Error('DESKTOP_MCP_INPUT_INVALID');
  const ownerKey = z.uuid().parse(args[3]), grantId = z.uuid().parse(args[5]);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error('DESKTOP_MCP_INPUT_INVALID');
  return { endpointFile: args[1], ownerKey, grantId, token };
}
export function desktopMcpRemote(options: ReturnType<typeof desktopMcpArguments>): DesktopMcpCall {
  return async (method, params, signal) => {
    signal.throwIfAborted(); const endpoint = await readDesktopMcpEndpoint(options.endpointFile, options.ownerKey);
    signal.throwIfAborted();
    const response = await fetch(`${endpoint.origin}/api/desktop/mcp/rpc`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json',
        'x-agent-company-grant': options.grantId, 'x-agent-company-epoch': endpoint.epoch }, body: JSON.stringify({ method, params }) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel(); throw new Error('DESKTOP_MCP_CALL_FAILED');
    }
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
        if (bytes > 256 * 1024) throw new Error('DESKTOP_MCP_RESPONSE_TOO_LARGE'); chunks.push(next.value); }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && Object.hasOwn(value, 'result')) return value.result;
      if (value && typeof value === 'object' && [-32601, -32602, -32000].includes(value.error?.code)) throw new DesktopMcpCallError(value.error.code);
      throw new Error('DESKTOP_MCP_RESPONSE_INVALID');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = desktopMcpArguments(process.argv.slice(2), process.env.AGENT_COMPANY_MCP_TOKEN);
    delete process.env.AGENT_COMPANY_MCP_TOKEN;
    const output = await desktopMcpOutput();
    let code = 1;
    try { code = await runDesktopMcpProtocol({ input: process.stdin, output: output.stream, call: desktopMcpRemote(options) }); }
    finally { if (!await output.close()) code = 1; }
    // Remote callbacks and the output child have both finished before exit.
    process.exit(code);
  } catch { process.stderr.write('DESKTOP_MCP_START_FAILED\n'); process.exitCode = 1; }
}
