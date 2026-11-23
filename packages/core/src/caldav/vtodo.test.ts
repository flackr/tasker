import { describe, expect, it } from 'vitest';
import {
  formatICalDateUtc,
  generateUid,
  parseICalDate,
  parseVTodo,
  patchVTodo,
  serializeVTodo,
  unfoldICalLines,
} from './vtodo.js';
import {
  findElementsByNS,
  findFirstByNS,
  getTextByNS,
  parseXml,
} from './xml.js';

describe('VTODO parser & lossless serializer', () => {
  it('parses a full VTODO with folded lines, escaped text, multiple CATEGORIES, and dates', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Nextcloud Tasks//EN',
      'BEGIN:VTODO',
      'UID:abc-123',
      'CREATED:20250101T100000Z',
      'LAST-MODIFIED:20250102T113000Z',
      'DTSTART;TZID=America/New_York:20250103T080000',
      'DUE;VALUE=DATE:20250105',
      'SUMMARY:Organic whole\\, fresh ',
      ' milk',
      'DESCRIPTION:2% fat\\nNo sugar',
      'CATEGORIES:Dairy,Aisle 3',
      'CATEGORIES:Cold\\, Refrigerated',
      'STATUS:COMPLETED',
      'PERCENT-COMPLETE:100',
      'COMPLETED:20250102T113000Z',
      'PRIORITY:5',
      'X-OC-HIDESUBTASKS:0',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const task = parseVTodo(ics, { calendarHref: '/cal/shopping/', etag: 'e1' });
    expect(task.uid).toBe('abc-123');
    expect(task.summary).toBe('Organic whole, fresh milk');
    expect(task.description).toBe('2% fat\nNo sugar');
    expect(task.categories).toEqual(['Dairy', 'Aisle 3', 'Cold, Refrigerated']);
    expect(task.status).toBe('COMPLETED');
    expect(task.percentComplete).toBe(100);
    expect(task.priority).toBe(5);
    expect(task.created).toBe('2025-01-01T10:00:00.000Z');
    expect(task.lastModified).toBe('2025-01-02T11:30:00.000Z');
    expect(task.completedAt).toBe('2025-01-02T11:30:00.000Z');
    expect(task.dtstart).toBe('2025-01-03T08:00:00[America/New_York]');
    expect(task.due).toBe('2025-01-05');
    expect(task.calendarHref).toBe('/cal/shopping/');
    expect(task.etag).toBe('e1');
  });

  it('rejects non-VTODO calendars and missing required fields', () => {
    const vevent = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Meet\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(() => parseVTodo(vevent)).toThrow(/VTODO/);

    const noUid = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nSUMMARY:Milk\r\nEND:VTODO\r\nEND:VCALENDAR';
    expect(() => parseVTodo(noUid)).toThrow(/UID/);

    const noSummary = 'BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:1\r\nEND:VTODO\r\nEND:VCALENDAR';
    expect(() => parseVTodo(noSummary)).toThrow(/SUMMARY/);
  });

  it('round-trips a new Task cleanly through serializeVTodo → parseVTodo', () => {
    const fixedNow = new Date('2026-03-10T15:00:00.000Z');
    const serialized = serializeVTodo(
      {
        uid: 'new-task-1',
        summary: 'Chips, salsa; dip',
        description: 'Line 1\nLine 2',
        status: 'NEEDS-ACTION',
        categories: ['Snacks', 'Aisle 7'],
        priority: 3,
        dtstart: '2026-03-11T09:00:00[America/New_York]',
        due: '2026-03-12',
      },
      { now: fixedNow },
    );

    expect(serialized).toContain('PRODID:-//tasker//EN');
    expect(serialized).toContain('DTSTAMP:20260310T150000Z');
    expect(serialized).toContain('CREATED:20260310T150000Z');

    const reparsed = parseVTodo(serialized);
    expect(reparsed.uid).toBe('new-task-1');
    expect(reparsed.summary).toBe('Chips, salsa; dip');
    expect(reparsed.description).toBe('Line 1\nLine 2');
    expect(reparsed.status).toBe('NEEDS-ACTION');
    expect(reparsed.categories).toEqual(['Snacks', 'Aisle 7']);
    expect(reparsed.priority).toBe(3);
    expect(reparsed.dtstart).toBe('2026-03-11T09:00:00[America/New_York]');
    expect(reparsed.due).toBe('2026-03-12');
  });

  it('losslessly preserves unknown properties and VALARM sub-components when patching', () => {
    const original = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Nextcloud Tasks//EN',
      'BEGIN:VTODO',
      'UID:keep-me',
      'SUMMARY:Milk',
      'STATUS:NEEDS-ACTION',
      'X-OC-HIDESUBTASKS:0',
      'RELATED-TO:parent-uid-99',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Buy milk!',
      'TRIGGER:-PT5M',
      'END:VALARM',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\r\n');

    const parsed = parseVTodo(original);
    const patched = patchVTodo(
      parsed.rawIcs!,
      {
        ...parsed,
        status: 'COMPLETED',
        percentComplete: 100,
        categories: ['Dairy'],
      },
      { now: new Date('2026-04-01T12:00:00.000Z') },
    );

    expect(patched).toContain('X-OC-HIDESUBTASKS:0');
    expect(patched).toContain('RELATED-TO:parent-uid-99');
    expect(patched).toContain('BEGIN:VALARM');
    expect(patched).toContain('DESCRIPTION:Buy milk!');
    expect(patched).toContain('STATUS:COMPLETED');
    expect(patched).toContain('COMPLETED:20260401T120000Z');
    expect(patched).toContain('CATEGORIES:Dairy');

    const reparsed = parseVTodo(patched);
    expect(reparsed.status).toBe('COMPLETED');
    expect(reparsed.categories).toEqual(['Dairy']);
    // VALARM's DESCRIPTION must NOT overwrite VTODO's DESCRIPTION
    expect(reparsed.description).toBeUndefined();
  });

  it('generates valid v4 UUIDs and formats/parses date helpers', () => {
    const id1 = generateUid();
    const id2 = generateUid();
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id1).not.toBe(id2);
    expect(formatICalDateUtc('2025-05-06T07:08:09.000Z')).toBe('20250506T070809Z');
    expect(parseICalDate('20250506T070809')).toBe('2025-05-06T07:08:09');
    expect(unfoldICalLines('LINE1\r\n CONT\n\tMORE')).toEqual(['LINE1CONTMORE']);
  });
});

describe('runtime-agnostic XML parser', () => {
  it('resolves inherited namespaces, attributes, CDATA, comments, and entities', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- comment -->
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/shopping/</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>Milk &amp; Eggs</d:displayname>
        <c:supported-calendar-component-set>
          <c:comp name="VTODO"/>
        </c:supported-calendar-component-set>
        <c:calendar-data><![CDATA[BEGIN:VCALENDAR
END:VCALENDAR]]></c:calendar-data>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`;

    const doc = parseXml(xml);
    const responses = findElementsByNS(doc, 'DAV:', 'response');
    expect(responses).toHaveLength(1);
    expect(getTextByNS(responses[0], 'DAV:', 'displayname')).toBe('Milk & Eggs');
    const comp = findFirstByNS(responses[0], 'urn:ietf:params:xml:ns:caldav', 'comp');
    expect(comp?.attributes.name).toBe('VTODO');
    expect(getTextByNS(responses[0], 'urn:ietf:params:xml:ns:caldav', 'calendar-data')).toBe(
      'BEGIN:VCALENDAR\nEND:VCALENDAR',
    );
  });
});
