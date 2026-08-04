import { createBasicAuthHeader } from '../auth';
import type { CalendarInfo, Credentials, Task } from '../types';
import { parseVTodo } from './parser';

const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';

function buildUrl(baseUrl: string, path: string): string {
  return path.startsWith('http') ? path : `${baseUrl.replace(/\/$/, '')}${path}`;
}

/**
 * Discovers the calendar collections available to the user and returns only
 * those that advertise VTODO support in their `supported-calendar-component-set`.
 * Per RFC 4791, that property is not returned unless explicitly requested.
 */
export async function listTaskCalendars(credentials: Credentials): Promise<CalendarInfo[]> {
  const headers = {
    Authorization: createBasicAuthHeader(credentials),
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
  };

  const calendarHomeUrl = buildUrl(credentials.baseUrl, `/remote.php/dav/calendars/${credentials.username}/`);
  const response = await fetch(calendarHomeUrl, {
    method: 'PROPFIND',
    headers,
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:resourcetype />
    <d:displayname />
    <c:supported-calendar-component-set />
  </d:prop>
</d:propfind>`,
  });

  if (!response.ok) throw new Error('Authentication failed');

  const xml = await response.text();
  return parseTaskCalendars(xml, calendarHomeUrl);
}

/**
 * Fetches all VTODO tasks from the given calendar collection.
 */
export async function fetchTasks(credentials: Credentials, calendarHref: string): Promise<Task[]> {
  const headers = {
    Authorization: createBasicAuthHeader(credentials),
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
  };

  const reportUrl = buildUrl(credentials.baseUrl, calendarHref);
  const reportResponse = await fetch(reportUrl, {
    method: 'REPORT',
    headers,
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

  if (!reportResponse.ok) throw new Error('Failed to fetch tasks');

  const reportXml = await reportResponse.text();
  return extractCalendarData(reportXml).map(parseVTodo);
}

function parseTaskCalendars(xml: string, calendarHomeUrl: string): CalendarInfo[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, 'response'));

  const calendars: CalendarInfo[] = [];
  for (const response of responses) {
    const href = getElementText(response, DAV_NS, 'href');
    if (!href) continue;

    const propstat = findSuccessPropstat(response);
    if (!propstat) continue;

    const prop = getFirstChildNS(propstat, DAV_NS, 'prop');
    if (!prop) continue;

    const resourcetype = getFirstChildNS(prop, DAV_NS, 'resourcetype');
    const isCalendar = !!resourcetype && getFirstChildNS(resourcetype, CALDAV_NS, 'calendar') !== undefined;
    if (!isCalendar) continue;

    if (!supportsVTodo(prop)) continue;

    const displayName = getElementText(prop, DAV_NS, 'displayname') ?? decodeURIComponent(hrefBaseName(href));
    calendars.push({ href: resolveHref(href, calendarHomeUrl), displayName });
  }

  return calendars;
}

function supportsVTodo(prop: Element): boolean {
  const set = getFirstChildNS(prop, CALDAV_NS, 'supported-calendar-component-set');
  if (!set) return false;
  const comps = Array.from(set.getElementsByTagNameNS(CALDAV_NS, 'comp'));
  return comps.some((comp) => comp.getAttribute('name') === 'VTODO');
}

function findSuccessPropstat(response: Element): Element | undefined {
  const propstats = Array.from(response.getElementsByTagNameNS(DAV_NS, 'propstat'));
  return propstats.find((propstat) => {
    const status = getElementText(propstat, DAV_NS, 'status') ?? '';
    return /\s200\s/.test(` ${status} `);
  });
}

function getFirstChildNS(element: Element, ns: string, localName: string): Element | undefined {
  const children = element.getElementsByTagNameNS(ns, localName);
  return children.length ? children[0] : undefined;
}

function getElementText(element: Element, ns: string, localName: string): string | undefined {
  const found = getFirstChildNS(element, ns, localName);
  const text = found?.textContent?.trim();
  return text ? text : undefined;
}

function resolveHref(href: string, base: string): string {
  try {
    return new URL(href, base).pathname;
  } catch {
    return href;
  }
}

function hrefBaseName(href: string): string {
  const trimmed = href.replace(/\/$/, '');
  const segments = trimmed.split('/');
  return segments[segments.length - 1] ?? href;
}

function extractCalendarData(xml: string): string[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return Array.from(doc.getElementsByTagNameNS(CALDAV_NS, 'calendar-data')).map((node) => node.textContent ?? '');
}
