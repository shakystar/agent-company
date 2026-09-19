import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import { MAX_IMPORTED_FILE_BYTES, validFilePath, type FileRecord } from '../shared/storage.ts';

export class FileError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'FileError'; }
}
export const fileScopeSchema = z.object({ type: z.enum(['agent', 'team', 'project']), id: z.uuid() }).strict();
const maxEncodedBytes = Math.ceil(MAX_IMPORTED_FILE_BYTES / 3) * 4;
export const fileImportSchema = z.object({
  scope: fileScopeSchema, path: z.string().refine(validFilePath, '파일 상대경로가 올바르지 않습니다.'),
  mediaType: z.string().max(200).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default('application/octet-stream'),
  base64: z.string().max(maxEncodedBytes),
}).strict();

export function decodeFileImport(input: unknown) {
  const parsed = fileImportSchema.parse(input);
  if (parsed.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(parsed.base64)) {
    throw new FileError(400, '파일 전송 형식이 올바르지 않습니다.');
  }
  const bytes = Buffer.from(parsed.base64, 'base64');
  if (bytes.length > MAX_IMPORTED_FILE_BYTES) throw new FileError(413, '파일 하나의 반입 한도는 16MiB입니다.');
  if (bytes.toString('base64') !== parsed.base64) throw new FileError(400, '파일 전송 형식이 올바르지 않습니다.');
  return { ...parsed, bytes };
}

/** Downloads are attachments, including HTML/SVG; names never become response headers. */
export function attachmentDisposition(path: string): string {
  const name = path.split('/').at(-1) || 'download';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

/** Metadata and access checks belong to the workspace transaction, not this byte store. */
export class BlobFiles {
  readonly directory: string;
  constructor(dataDir: string) { this.directory = resolve(dataDir, 'files'); }

  private async root() {
    let cursor = parse(this.directory).root;
    for (const part of relative(cursor, this.directory).split(/[\\/]/).filter(Boolean)) {
      cursor = join(cursor, part);
      await mkdir(cursor).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FileError(409, '파일 저장소가 일반 디렉터리가 아닙니다.');
    }
    const actual = await realpath(this.directory);
    // Validate each ancestor before creating anything below it.
    const difference = relative(resolve(this.directory), resolve(actual));
    if (difference) throw new FileError(409, '파일 저장소 경로에 우회 연결이 있습니다.');
    return actual;
  }

  private objectPath(root: string, id: string) {
    if (!z.uuid().safeParse(id).success) throw new FileError(400, '잘못된 파일 ID입니다.');
    const target = join(root, `${id}.blob`);
    const suffix = relative(root, target);
    if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)) throw new FileError(400, '파일 저장 경로가 올바르지 않습니다.');
    return target;
  }

  async put(bytes: Uint8Array): Promise<{ id: string; bytes: number; sha256: string }> {
    if (bytes.byteLength > MAX_IMPORTED_FILE_BYTES) throw new FileError(413, '파일 하나의 반입 한도는 16MiB입니다.');
    const id = randomUUID();
    const target = this.objectPath(await this.root(), id);
    const handle = await open(target, 'wx', 0o600);
    let completed = false;
    try { await handle.writeFile(bytes); await handle.sync(); completed = true; }
    finally {
      await handle.close();
      if (!completed) await unlink(target);
    }
    return { id, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  async read(record: Pick<FileRecord, 'id' | 'bytes' | 'sha256'>): Promise<Buffer> {
    if (!Number.isInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_IMPORTED_FILE_BYTES
      || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new FileError(409, '파일 기록이 올바르지 않습니다.');
    const target = this.objectPath(await this.root(), record.id);
    const stat = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileError(404, '보존된 파일이 없습니다.');
      throw error;
    });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== record.bytes) {
      throw new FileError(409, '파일 크기 또는 저장 형식이 기록과 다릅니다.');
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== record.bytes || !opened.isFile()) {
        throw new FileError(409, '조회 도중 파일이 변경되었습니다.');
      }
      const bytes = Buffer.alloc(record.bytes);
      let position = 0;
      while (position < bytes.length) {
        const read = await handle.read(bytes, position, bytes.length - position, position);
        if (!read.bytesRead) throw new FileError(409, '파일이 불완전합니다.');
        position += read.bytesRead;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new FileError(409, '파일 무결성 검증에 실패했습니다.');
      if ((await handle.stat()).size !== record.bytes) throw new FileError(409, '조회 도중 파일 크기가 변경되었습니다.');
      return bytes;
    } finally { await handle.close(); }
  }

  /** Only call to roll back a newly created, uncommitted object owned by this operation. */
  async remove(id: string): Promise<void> {
    const target = this.objectPath(await this.root(), id);
    const stat = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new FileError(409, '삭제 대상이 소유한 일반 파일이 아닙니다.');
    await unlink(target);
  }
}
