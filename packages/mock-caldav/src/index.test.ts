import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockCalDav,
  startMockCalDavServer,
  type MockCalDavHttpServer,
} from './index.js';

const MILK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:milk-1',
  'SUMMARY:Milk',
  'CATEGORIES:Dairy',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

describe('MockCalDavBackend', () => {
  let activeServer: MockCalDavHttpServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await activeServer.close();
      activeServer = undefined;
    }
  });

  it('handles PROPFIND, REPORT, PUT with If-Match/412, DELETE, and CTag updates in-process', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [{ uid: 'milk-1', calendarSlug: 'shopping', etag: 'etag-init', ics: MILK_ICS }],
    });
    const mockFetch = backend.createFetch();
    const authHeader = `Basic ${Buffer.from('alice:secret').toString('base64')}`;

    // Rejects missing auth
    const unauth = await mockFetch('https://cloud.example.com/remote.php/dav/calendars/alice/', {
      method: 'PROPFIND',
    });
    expect(unauth.status).toBe(401);

    // Calendar discovery
    const propfind = await mockFetch('https://cloud.example.com/remote.php/dav/calendars/alice/', {
      method: 'PROPFIND',
      headers: { Authorization: authHeader, Depth: '1' },
    });
    expect(propfind.status).toBe(207);
    const propfindXml = await propfind.text();
    expect(propfindXml).toContain('Shopping');
    expect(propfindXml).toContain('VTODO');

    const initialCTag = backend.getCalendarCTag('shopping');

    // REPORT
    const report = await mockFetch(
      'https://cloud.example.com/remote.php/dav/calendars/alice/shopping/',
      { method: 'REPORT', headers: { Authorization: authHeader } },
    );
    expect(report.status).toBe(207);
    expect(await report.text()).toContain('etag-init');

    // PUT with stale If-Match returns 412
    const conflictPut = await mockFetch(
      'https://cloud.example.com/remote.php/dav/calendars/alice/shopping/milk-1.ics',
      {
        method: 'PUT',
        headers: { Authorization: authHeader, 'If-Match': '"wrong-etag"' },
        body: MILK_ICS.replace('NEEDS-ACTION', 'COMPLETED'),
      },
    );
    expect(conflictPut.status).toBe(412);

    // PUT with matching If-Match succeeds, updates ETag and bumps CTag
    const okPut = await mockFetch(
      'https://cloud.example.com/remote.php/dav/calendars/alice/shopping/milk-1.ics',
      {
        method: 'PUT',
        headers: { Authorization: authHeader, 'If-Match': '"etag-init"' },
        body: MILK_ICS.replace('NEEDS-ACTION', 'COMPLETED'),
      },
    );
    expect(okPut.status).toBe(204);
    const newEtag = okPut.headers.get('etag');
    expect(newEtag).toBeTruthy();
    expect(newEtag).not.toBe('"etag-init"');
    expect(backend.getCalendarCTag('shopping')).not.toBe(initialCTag);

    // GET returns updated body and ETag
    const getRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/calendars/alice/shopping/milk-1.ics',
      { method: 'GET', headers: { Authorization: authHeader } },
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('etag')).toBe(newEtag);
    expect(await getRes.text()).toContain('STATUS:COMPLETED');

    // DELETE removes task
    const delRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/calendars/alice/shopping/milk-1.ics',
      { method: 'DELETE', headers: { Authorization: authHeader, 'If-Match': newEtag! } },
    );
    expect(delRes.status).toBe(204);
    expect(backend.getTasks('shopping')).toHaveLength(0);
  });

  it('supports WebDAV files (GET, PUT, PROPFIND) and fault injection', async () => {
    const backend = createMockCalDav({
      files: [
        {
          path: 'Notes/tasker-config.json',
          content: JSON.stringify({ aisles: ['Produce', 'Dairy'] }),
          contentType: 'application/json',
        },
        { path: 'Recipes/pasta.md', content: '# Pasta\n', contentType: 'text/markdown' },
      ],
    });
    const mockFetch = backend.createFetch();

    const cfgRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/files/alice/Notes/tasker-config.json',
    );
    expect(cfgRes.status).toBe(200);
    expect(JSON.parse(await cfgRes.text())).toEqual({ aisles: ['Produce', 'Dairy'] });

    const listRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/files/alice/Recipes/',
      { method: 'PROPFIND', headers: { Depth: '1' } },
    );
    expect(listRes.status).toBe(207);
    expect(await listRes.text()).toContain('Recipes/pasta.md');

    backend.setFault({ method: 'GET', status: 500, times: 1 });
    const errRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/files/alice/Recipes/pasta.md',
    );
    expect(errRes.status).toBe(500);

    // Fault clears after 1 trigger
    const okRes = await mockFetch(
      'https://cloud.example.com/remote.php/dav/files/alice/Recipes/pasta.md',
    );
    expect(okRes.status).toBe(200);
  });

  it('serves HTTP requests with CORS headers via startMockCalDavServer', async () => {
    activeServer = await startMockCalDavServer({
      tasks: [{ uid: 'milk-1', calendarSlug: 'shopping', etag: 'etag-1', ics: MILK_ICS }],
    });

    const optRes = await fetch(`${activeServer.url}/remote.php/dav/calendars/alice/`, {
      method: 'OPTIONS',
    });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get('access-control-allow-methods')).toContain('PUT');

    const reportRes = await fetch(`${activeServer.url}/remote.php/dav/calendars/alice/shopping/`, {
      method: 'REPORT',
    });
    expect(reportRes.status).toBe(207);
    expect(await reportRes.text()).toContain('SUMMARY:Milk');
  });
});
