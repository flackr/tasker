export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method?: string;
  headers?: { [key: string]: string };
  body?: string;
}

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export type CalDavErrorCode =
  | 'AUTH_FAILED'
  | 'PRECONDITION_FAILED'
  | 'NOT_FOUND'
  | 'HTTP_ERROR';

export class CalDavError extends Error {
  readonly status: number;
  readonly code: CalDavErrorCode;

  constructor(message: string, status: number, code: CalDavErrorCode) {
    super(message);
    this.name = 'CalDavError';
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, CalDavError.prototype);
  }
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8ToBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * Pure ES2015 UTF-8 safe HTTP Basic Auth header encoder.
 * Works identically across Browser, Fitbit Companion, and Node.
 */
export function createBasicAuthHeader(username: string, appPassword: string): string {
  const bytes = utf8ToBytes(`${username}:${appPassword}`);
  let output = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;

    const triplet = (b0 << 16) | (b1 << 8) | b2;
    output += BASE64_CHARS.charAt((triplet >> 18) & 0x3f);
    output += BASE64_CHARS.charAt((triplet >> 12) & 0x3f);
    output += has1 ? BASE64_CHARS.charAt((triplet >> 6) & 0x3f) : '=';
    output += has2 ? BASE64_CHARS.charAt(triplet & 0x3f) : '=';
  }
  return `Basic ${output}`;
}

export function buildDavUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const cleanPath = path.charAt(0) === '/' ? path : '/' + path;
  return cleanBase + cleanPath;
}

export function extractPathname(href: string): string {
  const match = /^https?:\/\/[^/]+(\/.*)?$/i.exec(href);
  if (match) {
    return match[1] || '/';
  }
  return href;
}

export function normalizeEtag(etag: string | null | undefined): string | undefined {
  if (!etag) return undefined;
  const trimmed = etag.trim();
  if (!trimmed) return undefined;
  const unweak = trimmed.indexOf('W/') === 0 ? trimmed.slice(2).trim() : trimmed;
  if (unweak.charAt(0) === '"' && unweak.charAt(unweak.length - 1) === '"') {
    return unweak.slice(1, -1);
  }
  return unweak;
}

export function formatIfMatchEtag(etag: string): string {
  const clean = normalizeEtag(etag) || etag;
  return `"${clean}"`;
}

export function resolveDefaultFetch(): FetchLike {
  const globalObj = (typeof globalThis !== 'undefined' ? globalThis : {}) as {
    fetch?: FetchLike;
  };
  if (typeof globalObj.fetch === 'function') {
    return (url, init) => (globalObj.fetch as FetchLike)(url, init);
  }
  throw new Error('No fetch implementation available; pass a custom fetch function.');
}

export function throwForHttpStatus(status: number, context: string): never {
  if (status === 401 || status === 403) {
    throw new CalDavError(`Authentication failed (${status}) during ${context}`, status, 'AUTH_FAILED');
  }
  if (status === 412) {
    throw new CalDavError(`Precondition failed (412) during ${context}`, 412, 'PRECONDITION_FAILED');
  }
  if (status === 404) {
    throw new CalDavError(`Resource not found (404) during ${context}`, 404, 'NOT_FOUND');
  }
  throw new CalDavError(`HTTP ${status} during ${context}`, status, 'HTTP_ERROR');
}
