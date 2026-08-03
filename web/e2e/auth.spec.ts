import { expect, test } from '@playwright/test';
import http from 'node:http';

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
      res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/calendars/alice/tasks/</d:href></d:response></d:multistatus>`);
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

test('enter credentials loads tasks', async ({ page }) => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(8787, resolve));

  try {
    await page.goto('/');
    await page.getByLabel('Nextcloud URL').fill('http://127.0.0.1:8787');
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks');
    await expect(page.getByTestId('task-list')).toContainText('Milk');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
