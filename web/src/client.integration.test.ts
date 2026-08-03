import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks } from './caldav/client';

const credentials = {
  baseUrl: 'https://cloud.example.com',
  username: 'alice',
  appPassword: 'secret',
};

describe('fetchTasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches and parses tasks from CalDAV', async () => {
    vi.stubGlobal('fetch', vi
      .fn()
      .mockResolvedValueOnce(new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/calendars/alice/tasks/</d:href></d:response></d:multistatus>`))
      .mockResolvedValueOnce(new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><c:calendar-data>&lt;BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:1\r\nSUMMARY:Milk\r\nCATEGORIES:Dairy,Aisle 1\r\nEND:VTODO\r\nEND:VCALENDAR&gt;</c:calendar-data></d:response><d:response><c:calendar-data>&lt;BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:2\r\nSUMMARY:Bread\r\nSTATUS:COMPLETED\r\nEND:VTODO\r\nEND:VCALENDAR&gt;</c:calendar-data></d:response></d:multistatus>`)));

    await expect(fetchTasks(credentials)).resolves.toEqual([
      { uid: '1', summary: 'Milk', status: 'NEEDS-ACTION', categories: ['Dairy', 'Aisle 1'] },
      { uid: '2', summary: 'Bread', status: 'COMPLETED', categories: [] },
    ]);
  });

  it('fails on auth error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(fetchTasks(credentials)).rejects.toThrow('Authentication failed');
  });
});
