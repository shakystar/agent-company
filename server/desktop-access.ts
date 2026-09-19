import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export interface DesktopAccess {
  assert(request: FastifyRequest): void;
}

export interface DesktopAccessOptions {
  token: string;
  cookieName: string;
  /** Exact HTTP origin published only after the loopback listener is bound. */
  origin: () => string | undefined;
}

class DesktopAccessError extends Error {
  readonly statusCode = 403;
  constructor() { super('설치형 앱의 인증된 로컬 요청만 허용합니다.'); }
}

const deny: () => never = () => { throw new DesktopAccessError(); };
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Inspect raw occurrences as Node can discard duplicate Authorization/Host or
 * join multiple Cookie/Origin fields before exposing normalized headers. */
function singleHeader(request: FastifyRequest, name: string): string | undefined {
  const values: string[] = [];
  const raw = request.raw.rawHeaders;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index].toLowerCase() === name) values.push(raw[index + 1]);
  }
  const value = request.headers[name];
  if (values.length > 1 || Array.isArray(value) || (value !== undefined && typeof value !== 'string')) deny();
  if (values.length !== (value === undefined ? 0 : 1) || (value !== undefined && values[0] !== value)) deny();
  return value;
}

function cookieCredential(header: string | undefined, cookieName: string): string | undefined {
  if (header === undefined) return;
  const names = new Set<string>();
  let credential: string | undefined;
  for (const part of header.split(';')) {
    const cookie = part.trim(), separator = cookie.indexOf('=');
    if (separator < 1) deny();
    const name = cookie.slice(0, separator), value = cookie.slice(separator + 1);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || names.has(name)) deny();
    names.add(name);
    if (name === cookieName) credential = value;
  }
  return credential;
}

/** The parent installs its HttpOnly, SameSite=Strict WebView cookie. This guard
 * never issues credentials, sets cookies, or accepts a token from the URL. */
export function createDesktopAccess({ token, cookieName, origin }: DesktopAccessOptions): DesktopAccess {
  if (!tokenPattern.test(token) || Buffer.from(token, 'base64url').length !== 32
    || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new TypeError('설치형 앱 인증 설정이 올바르지 않습니다.');
  if (!/^ac_desktop_[a-f0-9]{32}$/.test(cookieName) || typeof origin !== 'function') throw new TypeError('설치형 앱 인증 설정이 올바르지 않습니다.');
  const expected = Buffer.from(token, 'ascii');
  return Object.freeze({
    assert(request: FastifyRequest): void {
      let currentOrigin: string | undefined;
      try { currentOrigin = origin(); } catch { deny(); }
      const address = currentOrigin?.match(/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/);
      if (!address || Number(address[1]) > 65535) deny();
      if (singleHeader(request, 'host') !== currentOrigin!.slice('http://'.length)) deny();
      const requestOrigin = singleHeader(request, 'origin');
      // Native health checks and browser navigation/images have no Origin.
      // When present it must identify this exact listener, never a dev server.
      if (requestOrigin !== undefined && requestOrigin !== currentOrigin) deny();
      const fetchSite = singleHeader(request, 'sec-fetch-site');
      if (fetchSite !== undefined && fetchSite !== 'none' && fetchSite !== 'same-origin') deny();
      const authorization = singleHeader(request, 'authorization');
      const cookie = cookieCredential(singleHeader(request, 'cookie'), cookieName);
      if (authorization !== undefined && cookie !== undefined) deny();
      const supplied = authorization === undefined ? cookie : /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1];
      if (supplied === undefined || !tokenPattern.test(supplied) || !timingSafeEqual(expected, Buffer.from(supplied, 'ascii'))) deny();
    },
  });
}
