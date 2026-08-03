import { createBasicAuthHeader } from '../auth';
import type { Credentials, Task } from '../types';
import { parseVTodo } from './parser';

export async function fetchTasks(credentials: Credentials): Promise<Task[]> {
  const headers = {
    Authorization: createBasicAuthHeader(credentials),
    Depth: '1',
    'Content-Type': 'application/xml; charset=utf-8',
  };

  const calendarResponse = await fetch(`${credentials.baseUrl.replace(/\/$/, '')}/remote.php/dav/calendars/${credentials.username}/`, {
    method: 'PROPFIND',
    headers,
    body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype /></d:prop></d:propfind>`,
  });

  if (!calendarResponse.ok) throw new Error('Authentication failed');

  const calendarXml = await calendarResponse.text();
  const calendarPath = extractFirstCalendarPath(calendarXml);
  if (!calendarPath) throw new Error('No task list found');

  const reportResponse = await fetch(new URL(calendarPath, credentials.baseUrl).toString(), {
    method: 'REPORT',
    headers: { ...headers, Depth: '1' },
    body: `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag /><c:calendar-data /></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO" /></c:comp-filter></c:filter></c:calendar-query>`,
  });

  if (!reportResponse.ok) throw new Error('Failed to fetch tasks');

  const reportXml = await reportResponse.text();
  return extractCalendarData(reportXml).map(parseVTodo);
}

function extractFirstCalendarPath(xml: string): string | undefined {
  const matches = [...xml.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1]);
  return matches.find((path) => !path.endsWith(`/calendars/`));
}

function extractCalendarData(xml: string): string[] {
  return [...xml.matchAll(/<c:calendar-data>([\s\S]*?)<\/c:calendar-data>/g)].map((match) => decodeXml(match[1]));
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
