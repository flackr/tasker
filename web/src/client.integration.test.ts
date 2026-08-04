import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, listTaskCalendars } from './caldav/client';

const credentials = {
  baseUrl: 'https://cloud.example.com',
  username: 'alice',
  appPassword: 'secret',
};

const propfindResponse = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/personal/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Personal</d:displayname>
        <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/shopping/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
        <d:displayname>Shopping</d:displayname>
        <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/calendars/alice/inbox/</d:href>
    <d:propstat>
      <d:prop><d:resourcetype><d:collection/><cal:schedule-inbox/></d:resourcetype></d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

describe('listTaskCalendars', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requests supported-calendar-component-set and returns only VTODO calendars', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(propfindResponse));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listTaskCalendars(credentials)).resolves.toEqual([
      { href: '/remote.php/dav/calendars/alice/shopping/', displayName: 'Shopping' },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.example.com/remote.php/dav/calendars/alice/');
    expect(init.method).toBe('PROPFIND');
    expect(init.body).toContain('supported-calendar-component-set');
  });

  it('fails on auth error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(listTaskCalendars(credentials)).rejects.toThrow('Authentication failed');
  });
});

describe('fetchTasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and parses tasks from the selected calendar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><c:calendar-data>&lt;BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:1\r\nSUMMARY:Milk\r\nCATEGORIES:Dairy,Aisle 1\r\nEND:VTODO\r\nEND:VCALENDAR&gt;</c:calendar-data></d:response><d:response><c:calendar-data>&lt;BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:2\r\nSUMMARY:Bread\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR&gt;</c:calendar-data></d:response></d:multistatus>`));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTasks(credentials, '/remote.php/dav/calendars/alice/shopping/')).resolves.toEqual([
      { uid: '1', summary: 'Milk', status: 'NEEDS-ACTION', categories: ['Dairy', 'Aisle 1'] },
      { uid: '2', summary: 'Bread', status: 'COMPLETED', categories: [] },
    ]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://cloud.example.com/remote.php/dav/calendars/alice/shopping/');
    expect(init.method).toBe('REPORT');
    expect(init.body).toContain('comp-filter name="VTODO"');
  });

  it('fails when the report request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(fetchTasks(credentials, '/remote.php/dav/calendars/alice/shopping/')).rejects.toThrow('Failed to fetch tasks');
  });
});
