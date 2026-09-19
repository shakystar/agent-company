import { z } from 'zod';
import type { FileScope } from './storage.ts';

export const BROWSER_SOURCE_BYTES = 8 * 1024 * 1024;
export const BROWSER_IMAGE_BYTES = 600 * 1024;
export interface BrowserCapture {
  id: string; runId: string; agentId: string; conversationId: string | null;
  scope: FileScope; createdAt: string; bytes: number; sha256: string;
  mediaType: 'image/jpeg' | 'image/png'; width: number; height: number; url: string; sourceHash: string;
}
export const browserPath = z.string().min(1).max(512).refine(path => {
  const forbidden = /^(?:agents\.md|auth\.json|credentials?(?:\.json)?|secrets?|cookies?\.json|sessions?\.json|id_rsa|id_ed25519|node_modules)$/i;
  return !/[\\:\x00-\x1f\x7f<>"|?*%#]/.test(path) && !/\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(path) && path.split('/').every(part =>
    part && part.trim() === part && !part.startsWith('.') && !/[. ]$/.test(part) && !forbidden.test(part));
}, '일반 공개 작업물의 상대 경로만 허용합니다. 숨김·인증·내부 경로는 제외합니다.');
export const browserFileSchema = z.object({ path: browserPath, contentBase64: z.string().max(Math.ceil(2 * 1024 * 1024 / 3) * 4) }).strict();
export const browserSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), path: browserPath }).strict(),
  z.object({ kind: z.literal('artifacts'), scope: z.object({ type: z.enum(['team', 'project']), id: z.uuid() }).strict(), prefix: browserPath }).strict(),
]);
export const browserViewportSchema = z.object({ width: z.number().int().min(320).max(1920), height: z.number().int().min(240).max(1440) }).strict();
export const browserOpenSchema = z.object({ source: browserSourceSchema, entry: browserPath.default('index.html'),
  viewport: browserViewportSchema.optional(), files: z.array(browserFileSchema).min(1).max(1000).optional() }).strict();
const browserRef = z.string().regex(/^r-[a-f0-9]{16}-\d{1,3}$/);
const browserKey = z.enum(['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'ControlOrMeta+A']);
export const browserActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('screenshot') }).strict(),
  z.object({ action: z.literal('close') }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('click'), ref: browserRef }).strict(),
  z.object({ action: z.literal('fill'), ref: browserRef, value: z.string().max(10_000).refine(value => !value.includes('\0')) }).strict(),
  z.object({ action: z.literal('press'), key: browserKey, ref: browserRef.optional() }).strict(),
  z.object({ action: z.literal('resize'), width: browserViewportSchema.shape.width, height: browserViewportSchema.shape.height }).strict(),
]);
export type BrowserOpen = z.infer<typeof browserOpenSchema>;
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type BrowserRequest = BrowserAction | { action: 'open'; files: z.infer<typeof browserFileSchema>[]; entry: string; viewport?: z.infer<typeof browserViewportSchema> };
export function validateBrowserFiles(files: z.infer<typeof browserFileSchema>[]) {
  const checked = z.array(browserFileSchema).min(1).max(1000).parse(files), names = new Set<string>();
  let bytes = 0;
  for (const file of checked) {
    const key = file.path.normalize('NFC').toLowerCase();
    if (names.has(key)) throw new Error('브라우저 소스 경로가 중복됩니다.');
    names.add(key);
    const data = Buffer.from(file.contentBase64, 'base64');
    if (data.toString('base64') !== file.contentBase64 || data.length > 2 * 1024 * 1024) throw new Error('브라우저 소스 파일 인코딩·용량이 올바르지 않습니다.');
    bytes += data.length;
    if (bytes > BROWSER_SOURCE_BYTES) throw new Error('브라우저 소스 전체 8MiB 한도를 초과했습니다.');
  }
  return checked;
}
export const browserTools = [
  { name: 'browser_open', description: 'Open your static site in an isolated real Chromium session. source workspace reads a selected folder under your /workspace; artifacts reads an authorized team/project prefix. No external network or user browser login. Files are a captured copy: reopen after changes. Only one browser session runs at a time; close when no longer needed. Use browser_action screenshot to see the actual rendered image, not only the page text.',
    inputSchema: z.toJSONSchema(browserOpenSchema.omit({ files: true })) as Record<string, unknown> },
  { name: 'browser_action', description: 'Interact with your open browser. snapshot yields current element refs; click/fill/press/resize return refreshed state. screenshot returns an actual image and preserves evidence for the operator. Refs become stale after actions. close releases the browser. A restarted run must reopen its source; do not assume live DOM/forms survived.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['snapshot', 'screenshot', 'click', 'fill', 'press', 'resize', 'close', 'status'] }, ref: { type: 'string' }, value: { type: 'string' }, key: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } }, required: ['action'], additionalProperties: false } as Record<string, unknown> },
];
