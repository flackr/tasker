import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockCalendar {
  slug: string;
  displayName: string;
  components: ('VTODO' | 'VEVENT')[];
  ctag?: string;
}

export interface MockTaskResource {
  uid: string;
  calendarSlug: string;
  etag?: string;
  ics: string;
}

export interface MockWebDavFile {
  path: string;
  content: string;
  contentType?: string;
}

export interface MockAuthConfig {
  username: string;
  password: string;
}

export interface MockFault {
  method?: string;
  pathIncludes?: string;
  status: number;
  body?: string;
  /** Number of times to trigger before clearing (undefined = always). */
  times?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockCalDavOptions {
  username?: string;
  auth?: MockAuthConfig;
  calendars?: MockCalendar[];
  tasks?: MockTaskResource[];
  files?: MockWebDavFile[];
  allowedOrigin?: string;
  port?: number;
}

export interface MockCalDavHttpServer {
  url: string;
  port: number;
  server: http.Server;
  backend: MockCalDavBackend;
  close(): Promise<void>;
}

interface InternalCalendar {
  slug: string;
  displayName: string;
  components: ('VTODO' | 'VEVENT')[];
  ctagVersion: number;
  ctagOverride?: string;
}

interface InternalTask {
  uid: string;
  calendarSlug: string;
  filename: string;
  etag: string;
  ics: string;
}

interface InternalFile {
  path: string;
  content: string;
  contentType: string;
  etag: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function stripEtagQuotes(etag: string): string {
  const trimmed = etag.trim();
  const unweak = trimmed.startsWith('W/') ? trimmed.slice(2).trim() : trimmed;
  if (unweak.startsWith('"') && unweak.endsWith('"')) {
    return unweak.slice(1, -1);
  }
  return unweak;
}

function normalizeFilePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function extractUidFromIcs(ics: string, fallback: string): string {
  const match = ics.match(/^UID:(.+)$/m);
  return match ? match[1].trim() : fallback;
}

export interface RawHttpRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Stateful in-memory CalDAV/WebDAV mock server supporting both an in-process
 * Fetch handler (for fast Vitest integration tests) and an HTTP server (for Playwright E2E).
 */
export class MockCalDavBackend {
  readonly username: string;
  private readonly auth?: MockAuthConfig;
  private readonly allowedOrigin?: string;
  private readonly calendars = new Map<string, InternalCalendar>();
  private readonly tasks = new Map<string, InternalTask>();
  private readonly files = new Map<string, InternalFile>();
  private etagCounter = 1;
  private fault: MockFault | null = null;
  readonly requests: RecordedRequest[] = [];

  constructor(options: MockCalDavOptions = {}) {
    this.username = options.username ?? options.auth?.username ?? 'alice';
    this.auth = options.auth;
    this.allowedOrigin = options.allowedOrigin;

    const initialCalendars = options.calendars ?? [
      { slug: 'personal', displayName: 'Personal', components: ['VEVENT'] as ('VTODO' | 'VEVENT')[] },
      { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] as ('VTODO' | 'VEVENT')[] },
    ];

    for (const cal of initialCalendars) {
      this.calendars.set(cal.slug, {
        slug: cal.slug,
        displayName: cal.displayName,
        components: [...cal.components],
        ctagVersion: 1,
        ctagOverride: cal.ctag,
      });
    }

    for (const task of options.tasks ?? []) {
      this.setTask(task);
    }

    for (const file of options.files ?? []) {
      this.setFile(file.path, file.content, file.contentType);
    }
  }

  private nextEtag(prefix = 'etag', avoid?: string): string {
    let candidate = `${prefix}-${this.etagCounter++}`;
    while (avoid !== undefined && stripEtagQuotes(candidate) === stripEtagQuotes(avoid)) {
      candidate = `${prefix}-${this.etagCounter++}`;
    }
    return candidate;
  }

  private taskKey(calendarSlug: string, filename: string): string {
    return `${calendarSlug}/${filename}`;
  }

  private bumpCTag(calendarSlug: string): void {
    const cal = this.calendars.get(calendarSlug);
    if (cal) {
      cal.ctagVersion += 1;
      cal.ctagOverride = undefined;
    }
  }

  getCalendarCTag(calendarSlug: string): string | undefined {
    const cal = this.calendars.get(calendarSlug);
    if (!cal) return undefined;
    return cal.ctagOverride ?? `ctag-${cal.slug}-${cal.ctagVersion}`;
  }

  getTasks(calendarSlug: string): MockTaskResource[] {
    const result: MockTaskResource[] = [];
    for (const task of this.tasks.values()) {
      if (task.calendarSlug === calendarSlug) {
        result.push({
          uid: task.uid,
          calendarSlug: task.calendarSlug,
          etag: task.etag,
          ics: task.ics,
        });
      }
    }
    return result;
  }

  setTask(resource: MockTaskResource): string {
    const filename = `${encodeURIComponent(resource.uid)}.ics`;
    const etag = resource.etag ?? this.nextEtag();
    this.tasks.set(this.taskKey(resource.calendarSlug, filename), {
      uid: resource.uid,
      calendarSlug: resource.calendarSlug,
      filename,
      etag,
      ics: resource.ics,
    });
    this.bumpCTag(resource.calendarSlug);
    return etag;
  }

  deleteTask(calendarSlug: string, uid: string): boolean {
    const filename = `${encodeURIComponent(uid)}.ics`;
    const deleted = this.tasks.delete(this.taskKey(calendarSlug, filename));
    if (deleted) {
      this.bumpCTag(calendarSlug);
    }
    return deleted;
  }

  setFile(path: string, content: string, contentType = 'text/plain; charset=utf-8'): void {
    const normalized = normalizeFilePath(path);
    this.files.set(normalized, {
      path: normalized,
      content,
      contentType,
      etag: this.nextEtag('file'),
    });
  }

  getFile(path: string): string | undefined {
    return this.files.get(normalizeFilePath(path))?.content;
  }

  setFault(fault: MockFault | null): void {
    this.fault = fault ? { ...fault } : null;
  }

  clearRequests(): void {
    this.requests.length = 0;
  }

  handle(req: RawHttpRequest): RawHttpResponse {
    const method = req.method.toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }

    const corsHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': this.allowedOrigin ?? headers.origin ?? '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PROPFIND, REPORT, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, Prefer, If-Match, If-None-Match',
      'Access-Control-Expose-Headers': 'ETag, DAV',
    };

    if (method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders, body: '' };
    }

    this.requests.push({ method, path: req.path, headers, body: req.body });

    if (this.fault) {
      const methodMatches = !this.fault.method || this.fault.method.toUpperCase() === method;
      const pathMatches = !this.fault.pathIncludes || req.path.includes(this.fault.pathIncludes);
      if (methodMatches && pathMatches) {
        const status = this.fault.status;
        const body = this.fault.body ?? '';
        if (this.fault.times !== undefined) {
          this.fault.times -= 1;
          if (this.fault.times <= 0) {
            this.fault = null;
          }
        }
        return { status, headers: corsHeaders, body };
      }
    }

    if (this.auth) {
      const expected = `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString('base64')}`;
      if (headers.authorization !== expected) {
        return {
          status: 401,
          headers: { ...corsHeaders, 'WWW-Authenticate': 'Basic realm="tasker-mock"' },
          body: 'Unauthorized',
        };
      }
    }

    const calHome = `/remote.php/dav/calendars/${this.username}/`;
    const filesHome = `/remote.php/dav/files/${this.username}/`;

    if (req.path.startsWith(calHome)) {
      return this.handleCalDav(method, req.path, calHome, headers, req.body, corsHeaders);
    }

    if (req.path.startsWith(filesHome)) {
      return this.handleWebDavFiles(method, req.path, filesHome, headers, req.body, corsHeaders);
    }

    return { status: 404, headers: corsHeaders, body: 'Not Found' };
  }

  private handleCalDav(
    method: string,
    reqPath: string,
    calHome: string,
    headers: Record<string, string>,
    body: string,
    corsHeaders: Record<string, string>,
  ): RawHttpResponse {
    // Calendar home discovery: PROPFIND /remote.php/dav/calendars/<user>/
    if (method === 'PROPFIND' && reqPath === calHome) {
      const homeEntry = `
  <d:response>
    <d:href>${calHome}</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;

      const calEntries = Array.from(this.calendars.values())
        .map((cal) => {
          const comps = cal.components.map((comp) => `<cal:comp name="${comp}"/>`).join('');
          const ctag = this.getCalendarCTag(cal.slug) ?? '';
          return `
  <d:response>
    <d:href>${calHome}${cal.slug}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>${escapeXml(cal.displayName)}</d:displayname>
        <cal:supported-calendar-component-set>${comps}</cal:supported-calendar-component-set>
        <cs:getctag>${escapeXml(ctag)}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
        })
        .join('');

      return {
        status: 207,
        headers: { ...corsHeaders, 'Content-Type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${homeEntry}${calEntries}\n</d:multistatus>`,
      };
    }

    const relative = reqPath.slice(calHome.length);
    const segments = relative.split('/').filter(Boolean);
    if (segments.length === 0) {
      return { status: 404, headers: corsHeaders, body: 'Not Found' };
    }

    const slug = segments[0];
    const cal = this.calendars.get(slug);
    if (!cal) {
      return { status: 404, headers: corsHeaders, body: 'Calendar not found' };
    }

    // Calendar collection operations: /remote.php/dav/calendars/<user>/<slug>/
    if (segments.length === 1) {
      if (method === 'PROPFIND') {
        const depth = headers.depth ?? '0';
        const ctag = this.getCalendarCTag(slug) ?? '';
        const collectionEntry = `
  <d:response>
    <d:href>${calHome}${slug}/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>${escapeXml(cal.displayName)}</d:displayname>
        <cs:getctag>${escapeXml(ctag)}</cs:getctag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;

        const itemEntries =
          depth === '1'
            ? this.renderTaskEntries(calHome, slug)
            : '';

        return {
          status: 207,
          headers: { ...corsHeaders, 'Content-Type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${collectionEntry}${itemEntries}\n</d:multistatus>`,
        };
      }

      if (method === 'REPORT') {
        const entries = this.renderTaskEntries(calHome, slug);
        return {
          status: 207,
          headers: { ...corsHeaders, 'Content-Type': 'application/xml; charset=utf-8' },
          body: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${entries}\n</d:multistatus>`,
        };
      }

      return { status: 405, headers: corsHeaders, body: 'Method Not Allowed' };
    }

    // Individual task resource operations: /remote.php/dav/calendars/<user>/<slug>/<file>.ics
    const filename = segments.slice(1).join('/');
    const key = this.taskKey(slug, filename);
    const existing = this.tasks.get(key);

    if (method === 'GET') {
      if (!existing) {
        return { status: 404, headers: corsHeaders, body: 'Task not found' };
      }
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/calendar; charset=utf-8',
          ETag: `"${existing.etag}"`,
        },
        body: existing.ics,
      };
    }

    if (method === 'PUT') {
      const ifNoneMatch = headers['if-none-match'];
      if (ifNoneMatch === '*' && existing) {
        return { status: 412, headers: corsHeaders, body: 'Precondition Failed' };
      }

      const ifMatch = headers['if-match'];
      if (ifMatch !== undefined) {
        if (!existing) {
          return { status: 412, headers: corsHeaders, body: 'Precondition Failed' };
        }
        if (ifMatch.trim() !== '*' && stripEtagQuotes(ifMatch) !== stripEtagQuotes(existing.etag)) {
          return { status: 412, headers: corsHeaders, body: 'Precondition Failed' };
        }
      }

      const fallbackUid = decodeURIComponent(filename.replace(/\.ics$/i, ''));
      const uid = extractUidFromIcs(body, fallbackUid);
      const etag = this.nextEtag('etag', existing?.etag);
      const created = !existing;
      this.tasks.set(key, {
        uid,
        calendarSlug: slug,
        filename,
        etag,
        ics: body,
      });
      this.bumpCTag(slug);

      return {
        status: created ? 201 : 204,
        headers: {
          ...corsHeaders,
          ETag: `"${etag}"`,
        },
        body: '',
      };
    }

    if (method === 'DELETE') {
      if (!existing) {
        return { status: 404, headers: corsHeaders, body: 'Task not found' };
      }
      const ifMatch = headers['if-match'];
      if (ifMatch !== undefined && ifMatch.trim() !== '*' && stripEtagQuotes(ifMatch) !== stripEtagQuotes(existing.etag)) {
        return { status: 412, headers: corsHeaders, body: 'Precondition Failed' };
      }
      this.tasks.delete(key);
      this.bumpCTag(slug);
      return { status: 204, headers: corsHeaders, body: '' };
    }

    return { status: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  private renderTaskEntries(calHome: string, slug: string): string {
    const matching = Array.from(this.tasks.values()).filter((t) => t.calendarSlug === slug);
    return matching
      .map(
        (t) => `
  <d:response>
    <d:href>${calHome}${slug}/${t.filename}</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"${escapeXml(t.etag)}"</d:getetag>
        <cal:calendar-data>${escapeXml(t.ics)}</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
      )
      .join('');
  }

  private handleWebDavFiles(
    method: string,
    reqPath: string,
    filesHome: string,
    headers: Record<string, string>,
    body: string,
    corsHeaders: Record<string, string>,
  ): RawHttpResponse {
    const relPath = normalizeFilePath(decodeURIComponent(reqPath.slice(filesHome.length)));

    if (method === 'GET') {
      const file = this.files.get(relPath);
      if (!file) {
        return { status: 404, headers: corsHeaders, body: 'File not found' };
      }
      return {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': file.contentType,
          ETag: `"${file.etag}"`,
        },
        body: file.content,
      };
    }

    if (method === 'PUT') {
      const existed = this.files.has(relPath);
      const contentType = headers['content-type'] ?? 'application/octet-stream';
      const etag = this.nextEtag('file');
      this.files.set(relPath, {
        path: relPath,
        content: body,
        contentType,
        etag,
      });
      return {
        status: existed ? 204 : 201,
        headers: { ...corsHeaders, ETag: `"${etag}"` },
        body: '',
      };
    }

    if (method === 'PROPFIND') {
      const prefix = relPath ? `${relPath}/` : '';
      const dirHref = `${filesHome}${prefix}`;
      const entries: string[] = [
        `
  <d:response>
    <d:href>${dirHref}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`,
      ];

      for (const file of this.files.values()) {
        if (prefix && !file.path.startsWith(prefix)) continue;
        const remainder = prefix ? file.path.slice(prefix.length) : file.path;
        if (!remainder || remainder.includes('/')) continue;
        entries.push(`
  <d:response>
    <d:href>${filesHome}${file.path}</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getetag>"${escapeXml(file.etag)}"</d:getetag>
        <d:getcontenttype>${escapeXml(file.contentType)}</d:getcontenttype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`);
      }

      return {
        status: 207,
        headers: { ...corsHeaders, 'Content-Type': 'application/xml; charset=utf-8' },
        body: `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus xmlns:d="DAV:">${entries.join('')}\n</d:multistatus>`,
      };
    }

    return { status: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  /**
   * Returns a Fetch-API compatible handler backed directly by this in-memory
   * server (no open sockets required for Vitest integration tests).
   */
  createFetch(): (input: string | URL, init?: RequestInit) => Promise<Response> {
    return async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? new URL(input) : input;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [key, value] of init.headers) {
            headers[key.toLowerCase()] = value;
          }
        } else {
          for (const [key, value] of Object.entries(init.headers)) {
            if (value !== undefined) {
              headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
            }
          }
        }
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      const raw = this.handle({ method, path: url.pathname, headers, body });
      return new Response(raw.status === 204 ? null : raw.body, {
        status: raw.status,
        headers: raw.headers,
      });
    };
  }

  /**
   * Starts a real Node HTTP server backed by this mock instance (for Playwright E2E).
   */
  async listen(port = 0): Promise<MockCalDavHttpServer> {
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
        }
        const reqPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
        const result = this.handle({
          method: req.method ?? 'GET',
          path: reqPath,
          headers,
          body,
        });
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      });
    });

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;

    return {
      url: `http://127.0.0.1:${address.port}`,
      port: address.port,
      server,
      backend: this,
      close: () =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  }
}

export function createMockCalDav(options: MockCalDavOptions = {}): MockCalDavBackend {
  return new MockCalDavBackend(options);
}

/**
 * Convenience helper that creates and starts a local HTTP mock CalDAV server.
 */
export async function startMockCalDavServer(
  options: MockCalDavOptions = {},
): Promise<MockCalDavHttpServer> {
  const backend = new MockCalDavBackend(options);
  return backend.listen(options.port ?? 0);
}
