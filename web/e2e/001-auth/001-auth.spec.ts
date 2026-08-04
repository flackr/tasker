import { expect, test } from '@playwright/test';
import http from 'node:http';
import { TestStepHelper } from '../helpers/test-step-helper';

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:4173');
    res.setHeader('Access-Control-Allow-Methods', 'PROPFIND, REPORT, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, depth');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
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
</d:multistatus>`);
      return;
    }
    if (req.method === 'REPORT') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><c:calendar-data>&lt;BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:1\r\nSUMMARY:Milk\r\nCATEGORIES:Dairy\r\nEND:VTODO\r\nEND:VCALENDAR&gt;</c:calendar-data></d:response></d:multistatus>`);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

test('US-001: User enters credentials, selects a task list, and loads tasks', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata('Authentication', 'As a user, I want to connect to my Nextcloud server, choose a task list, and load my tasks.');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(8787, resolve));

  try {
    await page.goto('/');

    await tester.step('initial-load', {
      description: 'User sees the connection form',
      verifications: [
        { spec: 'Nextcloud URL field visible', check: async () => await expect(page.getByLabel('Nextcloud URL')).toBeVisible() },
        { spec: 'Connect button visible', check: async () => await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible() },
      ],
    });

    await page.getByLabel('Nextcloud URL').fill('http://127.0.0.1:8787');
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByTestId('calendar-select')).toBeVisible();

    await tester.step('calendar-selection', {
      description: 'Only the VTODO-capable task list is offered',
      verifications: [
        { spec: 'Shopping task list option present', check: async () => await expect(page.getByTestId('calendar-select')).toContainText('Shopping') },
        { spec: 'Personal (VEVENT-only) calendar is filtered out', check: async () => await expect(page.getByTestId('calendar-select')).not.toContainText('Personal') },
      ],
    });

    await page.getByRole('button', { name: 'Load tasks' }).click();

    await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks');

    await tester.step('tasks-loaded', {
      description: 'Tasks load after selecting a task list',
      verifications: [
        { spec: 'Status shows loaded task count', check: async () => await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks') },
        { spec: 'Task list shows the fetched task', check: async () => await expect(page.getByTestId('task-list')).toContainText('Milk') },
      ],
    });

    tester.generateDocs();
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
