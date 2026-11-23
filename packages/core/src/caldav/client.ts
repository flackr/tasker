import type { CalendarInfo, Credentials, Task } from '../types.js';
import {
  buildDavUrl,
  createBasicAuthHeader,
  extractPathname,
  formatIfMatchEtag,
  normalizeEtag,
  resolveDefaultFetch,
  throwForHttpStatus,
  type FetchLike,
} from './http.js';
import { parseVTodo, serializeVTodo } from './vtodo.js';
import {
  findElementsByNS,
  findFirstByNS,
  getTextByNS,
  parseXml,
  type XmlElement,
} from './xml.js';

const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
const CS_NS = 'http://calendarserver.org/ns/';

export interface CalDavClientOptions {
  fetch?: FetchLike;
}

export interface PutTaskOptions {
  ifMatch?: string;
  ifNoneMatch?: string;
  now?: Date;
}

export interface PutTaskResult {
  href: string;
  etag?: string;
  ics: string;
}

export interface DeleteTaskOptions {
  ifMatch?: string;
}

function findSuccessPropstat(response: XmlElement): XmlElement | undefined {
  const propstats = findElementsByNS(response, DAV_NS, 'propstat');
  for (let i = 0; i < propstats.length; i++) {
    const status = getTextByNS(propstats[i], DAV_NS, 'status') || '';
    if (/\s200\s/.test(` ${status} `)) {
      return propstats[i];
    }
  }
  return undefined;
}

function hrefBaseName(href: string): string {
  const trimmed = href.replace(/\/+$/, '');
  const segments = trimmed.split('/');
  return segments[segments.length - 1] || href;
}

function ensureTrailingSlash(path: string): string {
  return path.charAt(path.length - 1) === '/' ? path : path + '/';
}

/**
 * Runtime-agnostic CalDAV client backed by injectable `fetch` and our
 * dependency-free namespace-aware XML parser.
 */
export class CalDavClient {
  private readonly credentials: Credentials;
  private readonly fetchImpl: FetchLike;

  constructor(credentials: Credentials, options?: CalDavClientOptions) {
    this.credentials = credentials;
    this.fetchImpl = options?.fetch ?? resolveDefaultFetch();
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

  /**
   * Lists calendar collections for the user that advertise VTODO support.
   */
  async listTaskCalendars(): Promise<CalendarInfo[]> {
    const url = buildDavUrl(
      this.credentials.baseUrl,
      `/remote.php/dav/calendars/${encodeURIComponent(this.credentials.username)}/`,
    );
    const response = await this.fetchImpl(url, {
      method: 'PROPFIND',
      headers: this.authHeaders({
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <c:supported-calendar-component-set />
    <cs:getctag />
  </d:prop>
</d:propfind>`,
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'listTaskCalendars');
    }

    const xml = await response.text();
    const doc = parseXml(xml);
    const responses = findElementsByNS(doc, DAV_NS, 'response');
    const calendars: CalendarInfo[] = [];

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const href = getTextByNS(resp, DAV_NS, 'href');
      if (!href) continue;

      const propstat = findSuccessPropstat(resp);
      if (!propstat) continue;

      const prop = findFirstByNS(propstat, DAV_NS, 'prop');
      if (!prop) continue;

      const resourcetype = findFirstByNS(prop, DAV_NS, 'resourcetype');
      const isCalendar =
        !!resourcetype && findFirstByNS(resourcetype, CALDAV_NS, 'calendar') !== undefined;
      if (!isCalendar) continue;

      const compSet = findFirstByNS(prop, CALDAV_NS, 'supported-calendar-component-set');
      if (!compSet) continue;
      const comps = findElementsByNS(compSet, CALDAV_NS, 'comp');
      let supportsVTodo = false;
      for (let j = 0; j < comps.length; j++) {
        if ((comps[j].attributes.name || '').toUpperCase() === 'VTODO') {
          supportsVTodo = true;
          break;
        }
      }
      if (!supportsVTodo) continue;

      const displayName =
        getTextByNS(prop, DAV_NS, 'displayname') || decodeURIComponent(hrefBaseName(href));
      const ctag = getTextByNS(prop, CS_NS, 'getctag');
      const info: CalendarInfo = {
        href: extractPathname(href),
        displayName,
      };
      if (ctag !== undefined) info.ctag = ctag;
      calendars.push(info);
    }

    return calendars;
  }

  /**
   * Fetches the current collection CTag via PROPFIND Depth: 0.
   */
  async getCalendarCTag(calendarHref: string): Promise<string | undefined> {
    const url = buildDavUrl(this.credentials.baseUrl, calendarHref);
    const response = await this.fetchImpl(url, {
      method: 'PROPFIND',
      headers: this.authHeaders({
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <cs:getctag />
  </d:prop>
</d:propfind>`,
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'getCalendarCTag');
    }

    const xml = await response.text();
    const doc = parseXml(xml);
    return getTextByNS(doc, CS_NS, 'getctag');
  }

  /**
   * Fetches all VTODO tasks from a calendar collection via REPORT calendar-query.
   */
  async fetchTasks(calendarHref: string): Promise<Task[]> {
    const url = buildDavUrl(this.credentials.baseUrl, calendarHref);
    const response = await this.fetchImpl(url, {
      method: 'REPORT',
      headers: this.authHeaders({
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8',
      }),
      body: `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data />
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VTODO" />
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`,
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'fetchTasks');
    }

    const xml = await response.text();
    const doc = parseXml(xml);
    const responses = findElementsByNS(doc, DAV_NS, 'response');
    const tasks: Task[] = [];

    for (let i = 0; i < responses.length; i++) {
      const resp = responses[i];
      const calData = findFirstByNS(resp, CALDAV_NS, 'calendar-data');
      if (!calData || !calData.text.trim()) continue;

      const hrefRaw = getTextByNS(resp, DAV_NS, 'href');
      const etagRaw = getTextByNS(resp, DAV_NS, 'getetag');
      const task = parseVTodo(calData.text, {
        calendarHref,
        href: hrefRaw ? extractPathname(hrefRaw) : undefined,
        etag: normalizeEtag(etagRaw),
      });
      tasks.push(task);
    }

    return tasks;
  }

  /**
   * Fetches a single VTODO resource by href (e.g. to refresh state after a 412 conflict).
   */
  async getTask(taskHref: string, calendarHref?: string): Promise<Task> {
    const url = buildDavUrl(this.credentials.baseUrl, taskHref);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: this.authHeaders(),
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'getTask');
    }

    const ics = await response.text();
    const etag = normalizeEtag(response.headers.get('etag'));
    return parseVTodo(ics, {
      calendarHref,
      href: extractPathname(taskHref),
      etag,
    });
  }

  /**
   * Creates or updates a single VTODO task via PUT.
   */
  async putTask(
    calendarHref: string,
    task: Task,
    options?: PutTaskOptions,
  ): Promise<PutTaskResult> {
    const taskHref =
      task.href || `${ensureTrailingSlash(calendarHref)}${encodeURIComponent(task.uid)}.ics`;
    const url = buildDavUrl(this.credentials.baseUrl, taskHref);
    const ics = serializeVTodo(task, { now: options?.now });

    const extraHeaders: { [key: string]: string } = {
      'Content-Type': 'text/calendar; charset=utf-8',
    };
    if (options?.ifMatch) {
      extraHeaders['If-Match'] = formatIfMatchEtag(options.ifMatch);
    }
    if (options?.ifNoneMatch) {
      extraHeaders['If-None-Match'] = options.ifNoneMatch;
    }

    const response = await this.fetchImpl(url, {
      method: 'PUT',
      headers: this.authHeaders(extraHeaders),
      body: ics,
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'putTask');
    }

    return {
      href: extractPathname(taskHref),
      etag: normalizeEtag(response.headers.get('etag')),
      ics,
    };
  }

  /**
   * Deletes a single VTODO task resource via DELETE.
   */
  async deleteTask(taskHref: string, options?: DeleteTaskOptions): Promise<void> {
    const url = buildDavUrl(this.credentials.baseUrl, taskHref);
    const extraHeaders: { [key: string]: string } = {};
    if (options?.ifMatch) {
      extraHeaders['If-Match'] = formatIfMatchEtag(options.ifMatch);
    }

    const response = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: this.authHeaders(extraHeaders),
    });

    if (!response.ok) {
      throwForHttpStatus(response.status, 'deleteTask');
    }
  }
}

export function createCalDavClient(
  credentials: Credentials,
  options?: CalDavClientOptions,
): CalDavClient {
  return new CalDavClient(credentials, options);
}
