import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CollaborationScope, Project, SharedArtifact } from '../shared/collaboration.ts';
import {
  ARTIFACT_PREVIEW_MAX_BYTES, ARTIFACT_PREVIEW_MAX_FILES, ARTIFACT_PREVIEW_TTL_MS,
  artifactPreviewInputSchema, artifactPreviewManifestSchema, safeArtifactPreviewPath,
  type ArtifactPreviewManifest, type ArtifactPreviewSession,
} from '../shared/artifact-preview.ts';

export interface ArtifactPreviewSource {
  teams: Array<{ id: string }>;
  projects: Array<Pick<Project, 'id'>>;
  sharedArtifacts: SharedArtifact[];
}
export interface ResolvedArtifactPreview {
  manifest: ArtifactPreviewManifest;
  files: Map<string, { bytes: Buffer; mediaType: string }>;
}
export class ArtifactPreviewError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'ArtifactPreviewError'; }
}
function fail(status: number, message: string): never { throw new ArtifactPreviewError(status, message); }
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sameScope = (a: CollaborationScope, b: CollaborationScope) => a.type === b.type && a.id === b.id;
const comparePath = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const MANIFEST_PATH = '__agent_company_preview_manifest__.json';
const mediaTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', cjs: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8', map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8',
};
function mediaType(path: string): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  return mediaTypes[extension] ?? 'text/plain; charset=utf-8';
}
function scopeExists(source: ArtifactPreviewSource, scope: CollaborationScope) {
  if (!(scope.type === 'team' ? source.teams : source.projects).some(item => item.id === scope.id)) {
    fail(404, '공유 범위를 찾을 수 없습니다.');
  }
}
function revisionContent(artifact: SharedArtifact, version: number): string {
  if (artifact.version === version) return artifact.content;
  return artifact.history.find(item => item.version === version)?.content
    ?? fail(409, '고정한 산출물 버전을 찾을 수 없습니다.');
}
function manifestHash(value: Pick<ArtifactPreviewManifest, 'scope' | 'prefix' | 'entries'>): string {
  // Explicit property construction makes the hash independent of JSONB key order.
  return sha256(JSON.stringify({ scope: { type: value.scope.type, id: value.scope.id }, prefix: value.prefix,
    entries: value.entries.map(entry => ({ artifactId: entry.artifactId, version: entry.version,
      path: entry.path, mediaType: entry.mediaType, bytes: entry.bytes, sha256: entry.sha256 })) }));
}
function entrypoints(entries: ArtifactPreviewManifest['entries']): string[] {
  return entries.filter(entry => entry.mediaType === mediaTypes.html).map(entry => entry.path)
    .sort((a, b) => a === 'index.html' ? -1 : b === 'index.html' ? 1 : comparePath(a, b));
}

/** Only the operator service exposes this function. It does not elevate an agent's scope. */
export function pinArtifactPreview(source: ArtifactPreviewSource, raw: unknown,
  existing: readonly ArtifactPreviewManifest[] = []): ArtifactPreviewManifest {
  const input = artifactPreviewInputSchema.parse(raw);
  scopeExists(source, input.scope);
  const sourcePrefix = input.prefix ? `${input.prefix}/` : '';
  const selected = source.sharedArtifacts.filter(artifact => sameScope(artifact.scope, input.scope)
    && artifact.name.startsWith(sourcePrefix));
  if (!selected.length) fail(404, '선택한 경로에 공유 산출물이 없습니다.');
  if (selected.length > ARTIFACT_PREVIEW_MAX_FILES) fail(413, '미리보기 파일 수 한도를 초과했습니다.');
  const versions = new Map(input.versions?.map(item => [item.artifactId, item.version]));
  if (input.versions && (versions.size !== input.versions.length || selected.length !== versions.size
    || selected.some(artifact => !versions.has(artifact.id)))) {
    fail(409, '선택한 파일 목록이 변경됐습니다. 전체 파일 버전을 다시 확인해야 합니다.');
  }
  const entries = selected.map(artifact => {
    const path = artifact.name.slice(sourcePrefix.length);
    if (!safeArtifactPreviewPath(path) || path.toLowerCase() === MANIFEST_PATH) fail(400, '묶음에 안전하지 않은 파일 경로가 있습니다.');
    const version = versions.get(artifact.id) ?? artifact.version;
    const bytes = Buffer.from(revisionContent(artifact, version), 'utf8');
    return { artifactId: artifact.id, version, path, mediaType: mediaType(path), bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((a, b) => comparePath(a.path, b.path));
  if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) fail(409, '묶음의 파일 경로가 중복됩니다.');
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > ARTIFACT_PREVIEW_MAX_BYTES) fail(413, '미리보기 묶음은 16MiB 이하여야 합니다.');
  const pages = entrypoints(entries);
  if (!pages.length) fail(400, '미리볼 HTML 진입 페이지가 없습니다.');
  const candidate = { schemaVersion: 1 as const, id: randomUUID(), scope: input.scope, prefix: input.prefix,
    createdAt: new Date().toISOString(), sourceHash: manifestHash({ scope: input.scope, prefix: input.prefix, entries }),
    totalBytes, entries, entrypoints: pages };
  const prior = existing.find(item => sameScope(item.scope, input.scope) && item.prefix === input.prefix && item.sourceHash === candidate.sourceHash);
  if (prior) { resolveArtifactPreview(source, prior); return structuredClone(prior); }
  return artifactPreviewManifestSchema.parse(candidate);
}

/** No cached source content: every resolution verifies the selected immutable revisions. */
export function resolveArtifactPreview(source: ArtifactPreviewSource, raw: ArtifactPreviewManifest): ResolvedArtifactPreview {
  const manifest = artifactPreviewManifestSchema.parse(raw);
  scopeExists(source, manifest.scope);
  if (manifest.sourceHash !== manifestHash(manifest)
    || new Set(manifest.entries.map(entry => entry.artifactId)).size !== manifest.entries.length
    || new Set(manifest.entries.map(entry => entry.path.toLowerCase())).size !== manifest.entries.length
    || JSON.stringify(manifest.entrypoints) !== JSON.stringify(entrypoints(manifest.entries))) {
    fail(409, '고정 묶음의 명세 해시 또는 파일 목록이 일치하지 않습니다.');
  }
  const files = new Map<string, { bytes: Buffer; mediaType: string }>();
  for (const entry of manifest.entries) {
    const artifact = source.sharedArtifacts.find(item => item.id === entry.artifactId);
    if (!artifact || !sameScope(artifact.scope, manifest.scope) || artifact.name !== `${manifest.prefix ? `${manifest.prefix}/` : ''}${entry.path}`
      || entry.path.toLowerCase() === MANIFEST_PATH || entry.mediaType !== mediaType(entry.path)) {
      fail(409, '고정한 파일의 공유 범위 또는 경로가 일치하지 않습니다.');
    }
    const bytes = Buffer.from(revisionContent(artifact, entry.version), 'utf8');
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) fail(409, '고정한 파일 원문 해시가 일치하지 않습니다.');
    files.set(entry.path, { bytes, mediaType: entry.mediaType });
  }
  if ([...files.values()].reduce((sum, file) => sum + file.bytes.length, 0) !== manifest.totalBytes) fail(409, '고정 묶음의 전체 길이가 일치하지 않습니다.');
  return { manifest, files };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
/** Bounded, deterministic ZIP STORE archive; no extraction, child process or dependency. */
export function artifactPreviewArchive(source: ArtifactPreviewSource, raw: ArtifactPreviewManifest): { bytes: Buffer; path: string } {
  const { manifest, files } = resolveArtifactPreview(source, raw);
  const entries = [...files].map(([path, file]) => ({ path, bytes: file.bytes }));
  entries.push({ path: MANIFEST_PATH, bytes: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') });
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8'), checksum = crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12); // 1980-01-01, stable ZIP timestamp.
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(entry.bytes.length, 18); header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(33, 14); directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(entry.bytes.length, 20); directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, entry.bytes); central.push(directory, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const directorySize = central.reduce((sum, bytes) => sum + bytes.length, 0), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...local, ...central, end]), path: `artifacts-${manifest.sourceHash.slice(0, 16)}.zip` };
}

interface OpenPreview {
  manifest: ArtifactPreviewManifest;
  server: Server;
  origin: string;
  token: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  pendingReads: number;
}
export interface PreviewServerOptions {
  resolve: (manifest: ArtifactPreviewManifest) => Promise<ResolvedArtifactPreview>;
  /** Desktop binds port 0; a deferred origin is validated and fixed on first preview open. */
  controllerOrigins: readonly string[] | (() => readonly string[]);
  ttlMs?: number;
  maxSessions?: number;
}

/** Static sources execute only in a separate, cookie-isolated loopback origin.
 * CSP constrains subresources/fetch/forms/workers, not all possible self-navigation
 * in a general-purpose user browser. This is not a network-isolated Chromium VM.
 */
export class PreviewServerManager {
  private readonly sessions = new Map<string, OpenPreview>();
  private operations: Promise<unknown> = Promise.resolve();
  private resolvedOrigins?: Set<string>;
  private get origins(): Set<string> {
    if (this.resolvedOrigins) return this.resolvedOrigins;
    const origins = typeof this.options.controllerOrigins === 'function' ? this.options.controllerOrigins() : this.options.controllerOrigins;
    this.validateOrigins(origins);
    return this.resolvedOrigins = new Set(origins);
  }
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly host = '127.0.0.2';

  private validateOrigins(origins: readonly string[]) {
    if (!origins.length || origins.some(origin => {
      try {
        const url = new URL(origin);
        return url.origin !== origin || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      } catch { return true; }
    })) throw new Error('미리보기는 설정된 로컬 제어 서버 출처만 허용합니다.');
  }

  constructor(private readonly options: PreviewServerOptions) {
    if (typeof options.controllerOrigins !== 'function') this.resolvedOrigins = this.origins;
    this.ttlMs = options.ttlMs ?? ARTIFACT_PREVIEW_TTL_MS;
    this.maxSessions = options.maxSessions ?? 4;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 24 * 60 * 60 * 1000
      || !Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 8) throw new Error('미리보기 수명 또는 동시 창 한도가 올바르지 않습니다.');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(operation);
    this.operations = pending.catch(() => undefined);
    return pending;
  }

  open(raw: ArtifactPreviewManifest, entrypoint?: string): Promise<ArtifactPreviewSession> {
    return this.serialize(async () => {
      // Fail before opening a listener if the controller has not finished binding.
      this.validateOrigins([...this.origins]);
      const manifest = artifactPreviewManifestSchema.parse(raw);
      const page = entrypoint ?? manifest.entrypoints[0];
      if (!manifest.entrypoints.includes(page)) fail(400, '묶음에 포함된 HTML 진입 페이지가 필요합니다.');
      const resolved = await this.options.resolve(manifest);
      if (resolved.manifest.sourceHash !== manifest.sourceHash || !resolved.files.has(page)) fail(409, '미리보기 원문 확인 결과가 일치하지 않습니다.');
      const prior = this.sessions.get(manifest.id);
      if (prior && (prior.expiresAt <= Date.now() || prior.manifest.sourceHash !== manifest.sourceHash)) await this.closeSession(prior);
      let session = this.sessions.get(manifest.id);
      if (!session) {
        for (const expired of this.sessions.values()) if (expired.expiresAt <= Date.now()) await this.closeSession(expired);
        if (this.sessions.size >= this.maxSessions) fail(429, '열린 미리보기 창 한도에 도달했습니다. 기존 창을 닫은 뒤 다시 열 수 있습니다.');
        const server = createServer((request, response) => { void this.serve(manifest.id, request, response); });
        server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
        await new Promise<void>((resolve, reject) => {
          const error = (failure: Error) => reject(failure);
          server.once('error', error);
          server.listen(0, this.host, () => { server.removeListener('error', error); resolve(); });
        });
        const origin = `http://${this.host}:${(server.address() as AddressInfo).port}`;
        const expiresAt = Date.now() + this.ttlMs;
        const timer = setTimeout(() => {
          void this.serialize(async () => {
            const current = this.sessions.get(manifest.id);
            if (current?.server === server) await this.closeSession(current);
          });
        }, this.ttlMs);
        timer.unref();
        session = { manifest: structuredClone(manifest), server, origin, token: randomBytes(32).toString('hex'), expiresAt, timer, pendingReads: 0 };
        this.sessions.set(manifest.id, session);
      }
      return { manifestId: manifest.id, origin: session.origin, entrypoint: page,
        url: `${session.origin}/${session.token}/${page.split('/').map(encodeURIComponent).join('/')}`,
        expiresAt: new Date(session.expiresAt).toISOString() };
    });
  }

  private async serve(id: string, request: import('node:http').IncomingMessage, reply: ServerResponse) {
    const session = this.sessions.get(id);
    const deny = (status: number) => { reply.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); reply.end(); };
    if (!session || session.expiresAt <= Date.now()) { deny(410); return; }
    if (request.headers.host !== new URL(session.origin).host || !['GET', 'HEAD'].includes(request.method ?? '')) { deny(403); return; }
    const origin = request.headers.origin;
    if (origin && origin !== session.origin && !this.origins.has(origin)) { deny(403); return; }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site') {
      let parentAllowed = false;
      try { parentAllowed = this.origins.has(new URL(request.headers.referer ?? '').origin); } catch { /* no trusted parent */ }
      // A controller iframe may load this separate-origin page. Other cross-site
      // request types do not gain access, even if a URL capability leaked.
      if (!parentAllowed || request.headers['sec-fetch-dest'] !== 'iframe' || request.headers['sec-fetch-mode'] !== 'navigate') { deny(403); return; }
    }
    if (request.headers['service-worker'] !== undefined) { deny(403); return; }
    let path: string;
    try {
      const rawPath = (request.url ?? '').split('?')[0];
      const prefix = `/${session.token}/`;
      if (!rawPath.startsWith(prefix)) { deny(404); return; }
      path = decodeURIComponent(rawPath.slice(prefix.length));
      if (!safeArtifactPreviewPath(path)) { deny(400); return; }
    } catch { deny(400); return; }
    if (session.pendingReads >= 8) { deny(429); return; }
    session.pendingReads++;
    try {
      const resolved = await this.options.resolve(session.manifest);
      if (this.sessions.get(id) !== session || session.expiresAt <= Date.now()) { deny(410); return; }
      if (resolved.manifest.sourceHash !== session.manifest.sourceHash) { deny(409); return; }
      const file = resolved.files.get(path);
      if (!file) { deny(404); return; }
      const csp = ["default-src 'none'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "media-src 'self'", "object-src 'none'",
        "frame-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'",
        // The forms sandbox flag suppresses the submit event itself, before a
        // local handler can preventDefault(). Allow that event while form-action
        // continues to deny every network form submission target.
        `frame-ancestors ${[...this.origins].join(' ')}`, 'sandbox allow-scripts allow-same-origin allow-forms'].join('; ');
      reply.writeHead(200, { 'Content-Type': file.mediaType, 'Content-Length': file.bytes.length,
        'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), display-capture=()',
        'X-DNS-Prefetch-Control': 'off', 'Cross-Origin-Opener-Policy': 'same-origin',
      });
      reply.end(request.method === 'HEAD' ? undefined : file.bytes);
    } catch (error) {
      deny(error instanceof ArtifactPreviewError && error.statusCode < 500 ? error.statusCode : 409);
    } finally { session.pendingReads--; }
  }

  private async closeSession(session: OpenPreview): Promise<void> {
    if (this.sessions.get(session.manifest.id) === session) this.sessions.delete(session.manifest.id);
    clearTimeout(session.timer);
    await new Promise<void>(resolve => { session.server.close(() => resolve()); session.server.closeAllConnections(); });
  }

  close(manifestId?: string): Promise<void> {
    return this.serialize(async () => {
      for (const session of [...this.sessions.values()]) {
        if (manifestId === undefined || session.manifest.id === manifestId) await this.closeSession(session);
      }
    });
  }
}
