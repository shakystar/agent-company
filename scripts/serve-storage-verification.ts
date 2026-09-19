import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from '../server/app.ts';
import { StorageFixtureRuntime } from '../tests/storage-fixture.ts';

// Isolated full HTTP/DB/blob/backup UI verification. Simulates only Docker volumes;
// never loads .env, user authentication, the user's .data, or a model provider.
const directory = resolve('.browser', `storage-verify-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const key = randomUUID();
const app = await createApp({ dataDir: join(directory, 'data', 'db'), runtime: new StorageFixtureRuntime(key),
  storage: { rootDir: join(directory, 'data'), backupDir: join(directory, 'backups'), ownerKey: key, freeSpace: async () => 100 * 1024 ** 3 } });
await app.register(fastifyStatic, { root: resolve('dist') });
app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'API not found' }) : reply.sendFile('index.html'));
await writeFile(join(directory, 'fixture.json'), JSON.stringify({ directory, key, port: 4312, modelCalls: false }));
app.post('/verification/stop', async (request, reply) => {
  if (request.headers['x-verification-key'] !== key) return reply.code(403).send({ error: 'fixture key required' });
  setTimeout(() => { void app.close(); }, 100); return { stopping: true };
});
await app.listen({ host: '127.0.0.1', port: 4312 });
console.log(JSON.stringify({ directory, port: 4312, pid: process.pid }));
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void app.close(); });
