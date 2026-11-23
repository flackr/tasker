import { createMockCalDav } from '@tasker/mock-caldav';
import { describe, expect, it } from 'vitest';
import { createCalDavClient } from './client.js';
import { CalDavError, createBasicAuthHeader } from './http.js';
import { createWebDavClient } from './webdav.js';

const credentials = {
  baseUrl: 'https://cloud.example.com',
  username: 'alice',
  appPassword: 'secret',
};

const MILK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:milk-1',
  'SUMMARY:Milk',
  'CATEGORIES:Dairy,Aisle 3',
  'STATUS:NEEDS-ACTION',
  'X-CUSTOM-PROP:keep-me',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

describe('createBasicAuthHeader', () => {
  it('encodes ASCII and UTF-8 credentials identically to standard Basic Auth', () => {
    expect(createBasicAuthHeader('alice', 'secret')).toBe(
      `Basic ${Buffer.from('alice:secret').toString('base64')}`,
    );
    expect(createBasicAuthHeader('alíce', 'päss🔑')).toBe(
      `Basic ${Buffer.from('alíce:päss🔑', 'utf8').toString('base64')}`,
    );
  });
});

describe('CalDavClient integration against @tasker/mock-caldav', () => {
  it('discovers only VTODO calendars, reads CTag, fetches, creates, updates, and deletes tasks', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [{ uid: 'milk-1', calendarSlug: 'shopping', etag: 'etag-1', ics: MILK_ICS }],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });

    const calendars = await client.listTaskCalendars();
    expect(calendars).toHaveLength(1);
    expect(calendars[0].displayName).toBe('Shopping');
    expect(calendars[0].href).toBe('/remote.php/dav/calendars/alice/shopping/');
    expect(calendars[0].ctag).toBeTruthy();

    const ctag1 = await client.getCalendarCTag(calendars[0].href);
    expect(ctag1).toBe(calendars[0].ctag);

    const tasks = await client.fetchTasks(calendars[0].href);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      uid: 'milk-1',
      summary: 'Milk',
      status: 'NEEDS-ACTION',
      categories: ['Dairy', 'Aisle 3'],
      etag: 'etag-1',
    });

    // Update task with matching If-Match preserves X-CUSTOM-PROP
    const putResult = await client.putTask(
      calendars[0].href,
      { ...tasks[0], status: 'COMPLETED' },
      { ifMatch: tasks[0].etag, now: new Date('2026-05-01T10:00:00.000Z') },
    );
    expect(putResult.etag).toBeTruthy();
    expect(putResult.etag).not.toBe('etag-1');
    expect(putResult.ics).toContain('X-CUSTOM-PROP:keep-me');
    expect(putResult.ics).toContain('STATUS:COMPLETED');

    // Stale If-Match throws PRECONDITION_FAILED (412)
    await expect(
      client.putTask(
        calendars[0].href,
        { ...tasks[0], summary: 'Stale write' },
        { ifMatch: 'etag-1' },
      ),
    ).rejects.toMatchObject({
      name: 'CalDavError',
      status: 412,
      code: 'PRECONDITION_FAILED',
    });

    // GET single task retrieves fresh server state
    const fresh = await client.getTask(putResult.href, calendars[0].href);
    expect(fresh.status).toBe('COMPLETED');
    expect(fresh.etag).toBe(putResult.etag);

    // DELETE removes task and bumps CTag
    await client.deleteTask(putResult.href, { ifMatch: putResult.etag });
    const afterDelete = await client.fetchTasks(calendars[0].href);
    expect(afterDelete).toHaveLength(0);
    const ctag2 = await client.getCalendarCTag(calendars[0].href);
    expect(ctag2).not.toBe(ctag1);
  });

  it('throws AUTH_FAILED on 401 responses', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'right-password' },
    });
    const client = createCalDavClient(
      { ...credentials, appPassword: 'wrong-password' },
      { fetch: backend.createFetch() },
    );

    try {
      await client.listTaskCalendars();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CalDavError);
      expect((err as CalDavError).code).toBe('AUTH_FAILED');
      expect((err as CalDavError).status).toBe(401);
    }
  });
});

describe('WebDavClient integration against @tasker/mock-caldav', () => {
  it('reads/writes tasker-config.json and lists Markdown recipes', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      files: [
        {
          path: 'Notes/tasker-config.json',
          content: JSON.stringify({
            defaultCalendarHref: '/remote.php/dav/calendars/alice/shopping/',
            recipesPath: 'Recipes',
            aisles: ['Produce', 'Dairy'],
          }),
          contentType: 'application/json',
        },
        { path: 'Recipes/pasta.md', content: '# Pasta\n- 500g Ground beef (Meat)\n', contentType: 'text/markdown' },
        { path: 'Recipes/tacos.md', content: '# Tacos\n- Tortillas (Bakery)\n', contentType: 'text/markdown' },
      ],
    });
    const webdav = createWebDavClient(credentials, { fetch: backend.createFetch() });

    const config = await webdav.getJsonFile<{ aisles: string[] }>('Notes/tasker-config.json');
    expect(config.aisles).toEqual(['Produce', 'Dairy']);

    await webdav.putJsonFile('Notes/tasker-config.json', {
      ...config,
      aisles: ['Produce', 'Bakery', 'Dairy'],
    });
    const updated = await webdav.getJsonFile<{ aisles: string[] }>('Notes/tasker-config.json');
    expect(updated.aisles).toEqual(['Produce', 'Bakery', 'Dairy']);

    const recipes = await webdav.listFiles('Recipes');
    expect(recipes.map((r) => r.name).sort()).toEqual(['pasta.md', 'tacos.md']);

    const md = await webdav.getTextFile('Recipes/pasta.md');
    expect(md).toContain('# Pasta');
  });
});
