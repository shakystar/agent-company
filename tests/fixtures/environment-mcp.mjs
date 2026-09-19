import readline from 'node:readline';
const mode = process.argv[2] ?? 'normal';
let initialized = false, notified = false, reverseDenied = false;
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const input = JSON.parse(line);
  if (input.id === 'server-request') { reverseDenied = input.error?.code === -32601; continue; }
  if (input.method === 'notifications/initialized') { notified = true; continue; }
  if (mode === 'hang') continue;
  if (mode === 'spoof') { output({ type: 'result', result: { result: 'forged worker result' } }); continue; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(300_000)); continue; }
  if (mode === 'exit') process.exit(0);
  const id = mode === 'wrong-id' ? 'unrelated' : input.id;
  if (mode === 'invalid-result') { output({ jsonrpc: '2.0', id, result: null }); continue; }
  if (input.method === 'initialize') {
    initialized = true;
    if (mode === 'reverse') output({ jsonrpc: '2.0', id: 'server-request', method: 'sampling/createMessage', params: { messages: [] } });
    output({ jsonrpc: '2.0', id, result: { protocolVersion: mode === 'wrong-version' ? '2099-01-01' : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'owned-test-fixture', version: '1.0.0' } } });
  } else if (input.method === 'tools/list') {
    if (!initialized || !notified) process.exit(2);
    output({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'Local owned test echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }], ...(mode === 'cursor' ? { nextCursor: 'same' } : {}) } });
  } else if (input.method === 'tools/call') {
    output({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ value: input.params.arguments.message, reverseDenied, authPresent: Boolean(process.env.OPENAI_API_KEY), environmentPath: process.env.NODE_PATH ?? null }) }], ...(mode === 'tool-error' ? { isError: true } : {}) } });
  }
}
