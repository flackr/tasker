import type { Credentials } from '../types.js';
import {
  buildDavUrl,
  createBasicAuthHeader,
  extractPathname,
  normalizeEtag,
  resolveDefaultFetch,
  throwForHttpStatus,
  type FetchLike,
} from './http.js';
import { findElementsByNS, findFirstByNS, getTextByNS, parseXml } from './xml.js';

const DAV_NS = 'DAV:';

export interface WebDavClientOptions {
  fetch?: FetchLike;
}

export interface WebDavFileEntry {
  href: string;
  name: string;
  etag?: string;
  contentType?: string;
}

function encodeFilePath(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return clean
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/**
 * Runtime-agnostic WebDAV Files client for reading `tasker-config.json`
 * and read-only Markdown recipes from Nextcloud Files.
 */
export class WebDavClient {
  private readonly credentials: Credentials;
  private readonly fetchImpl: FetchLike;

  constructor(credentials: Credentials, options?: WebDavClientOptions) {
    this.credentials = credentials;
    this.fetchImpl = options?.fetch ?? resolveDefaultFetch();
  }

  private fileUrl(relativePath: string): string {
    const encodedUser = encodeURIComponent(this.credentials.username);
    const encodedPath = encodeFilePath(relativePath);
    return buildDavUrl(
      this.credentials.baseUrl,
      `/remote.php/dav/files/${encodedUser}/${encodedPath}`,
    );
  }

  private authHeaders(extra?: { [key: string]: string }): { [key: string]: string } {
    const headers: { [key: string]: string } = {
      Authorization: createBasicAuthHeader(
        this.credentials.username,
        this.credentials.appPassword,
      ),
    };
    if (extra) {
      const keys = Object.keys(extra);
      for (let i = 0; i < keys.length; i++) {
        headers[keys[i]] = extra[keys[i]];
      }
    }
    return headers;
  }

  async getTextFile(relativePath: string): Promise<string> {
    const response = await this.fetchImpl(this.fileUrl(relativePath), {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      throwForHttpStatus(response.status, `getTextFile(${relativePath})`);
    }
    return response.text();
  }

  async getJsonFile<T>(relativePath: string): Promise<T> {
    const text = await this.getTextFile(relativePath);
    return JSON.parse(text) as T;
  }

  async putJsonFile(relativePath: string, data: unknown): Promise<void> {
    const response = await this.fetchImpl(this.fileUrl(relativePath), {
      method: 'PUT',
      headers: this.authHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify(data, null, 2),
    });
    if (!response.ok) {
      throwForHttpStatus(response.status, `putJsonFile(${relativePath})`);
    }
  }

  async listFiles(folderPath: string): Promise<WebDavFileEntry[]> {
    const clean = folderPath.replace(/\/+$/, '');
    const url = this.fileUrl(clean ? `${clean}/` : '');
    const response = await this.fetchImpl(url, {
      method: 'PROPFIND',
      headers: this.authHeaders({
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype />
    <d:getetag />
    <d:getcontenttype />
  </d:prop>
</d:propfind>`,
    });
    if (!response.ok) {
      throwForHttpStatus(response.status, `listFiles(${folderPath})`);
    }

    const xml = await response.text();
    const doc = parseXml(xml);
    const responses = findElementsByNS(doc, DAV_NS, 'response');
    const files: WebDavFileEntry[] = [];

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const hrefRaw = getTextByNS(resp, DAV_NS, 'href');
      if (!hrefRaw) continue;

      const resourcetype = findFirstByNS(resp, DAV_NS, 'resourcetype');
      if (resourcetype && findFirstByNS(resourcetype, DAV_NS, 'collection')) {
        continue;
      }

      const href = extractPathname(hrefRaw);
      const segments = href.replace(/\/+$/, '').split('/');
      const name = decodeURIComponent(segments[segments.length - 1] || '');
      if (!name) continue;

      const entry: WebDavFileEntry = { href, name };
      const etag = normalizeEtag(getTextByNS(resp, DAV_NS, 'getetag'));
      const contentType = getTextByNS(resp, DAV_NS, 'getcontenttype');
      if (etag !== undefined) entry.etag = etag;
      if (contentType !== undefined) entry.contentType = contentType;
      files.push(entry);
    }

    return files;
  }
}

export function createWebDavClient(
  credentials: Credentials,
  options?: WebDavClientOptions,
): WebDavClient {
  return new WebDavClient(credentials, options);
}
