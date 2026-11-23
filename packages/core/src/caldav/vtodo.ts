import type { Task, TaskStatus } from '../types.js';

export interface ParseVTodoMeta {
  calendarHref?: string;
  href?: string;
  etag?: string;
}

export interface SerializeVTodoOptions {
  now?: Date;
}

interface ParsedLine {
  raw: string;
  name: string;
  params: string;
  value: string;
}

/**
 * Generates an RFC 4122 v4 UUID without requiring DOM or Node globals.
 */
export function generateUid(): string {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.map((b) => (b < 16 ? '0' : '') + b.toString(16));
  return (
    hex.slice(0, 4).join('') +
    '-' +
    hex.slice(4, 6).join('') +
    '-' +
    hex.slice(6, 8).join('') +
    '-' +
    hex.slice(8, 10).join('') +
    '-' +
    hex.slice(10, 16).join('')
  );
}

/**
 * Formats an ISO string or Date into RFC 5545 UTC DATE-TIME (`YYYYMMDDTHHMMSSZ`).
 */
export function formatICalDateUtc(input: Date | string): string {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d{8}(T\d{6}Z?)?$/.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      return trimmed;
    }
    input = parsed;
  }
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n));
  return (
    input.getUTCFullYear() +
    pad(input.getUTCMonth() + 1) +
    pad(input.getUTCDate()) +
    'T' +
    pad(input.getUTCHours()) +
    pad(input.getUTCMinutes()) +
    pad(input.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Parses an RFC 5545 DATE or DATE-TIME value into an ISO-8601 string.
 * Supports UTC (`YYYYMMDDTHHMMSSZ`), floating (`YYYYMMDDTHHMMSS`),
 * date-only (`YYYYMMDD`), and `TZID=...` parameterized values.
 */
export function parseICalDate(value: string, params = ''): string {
  const trimmed = value.trim();
  const dtMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(trimmed);
  if (dtMatch) {
    const [, y, mo, d, h, mi, s, z] = dtMatch;
    if (z === 'Z') {
      return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    }
    const tzMatch = /TZID=([^;]+)/i.exec(params);
    if (tzMatch) {
      return `${y}-${mo}-${d}T${h}:${mi}:${s}[${tzMatch[1]}]`;
    }
    return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  const dateOnlyMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const [, y, mo, d] = dateOnlyMatch;
    return `${y}-${mo}-${d}`;
  }
  return trimmed;
}

/**
 * Unfolds RFC 5545 folded lines (`CRLF` or `LF` followed by a single space or tab).
 */
export function unfoldICalLines(ics: string): string[] {
  const normalized = ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  const unfolded: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if ((line.charAt(0) === ' ' || line.charAt(0) === '\t') && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function unescapeICalText(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\' && i + 1 < text.length) {
      const next = text.charAt(i + 1);
      if (next === 'n' || next === 'N') {
        out += '\n';
        i += 1;
      } else if (next === ',' || next === ';' || next === '\\') {
        out += next;
        i += 1;
      } else {
        out += ch;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function escapeICalText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function splitUnescapedCommas(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch === '\\' && i + 1 < value.length) {
      current += ch + value.charAt(i + 1);
      i += 1;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseContentLine(line: string): ParsedLine | null {
  const colonIdx = findUnquotedColon(line);
  if (colonIdx <= 0) return null;
  const header = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const semiIdx = header.indexOf(';');
  const name = (semiIdx >= 0 ? header.slice(0, semiIdx) : header).trim().toUpperCase();
  const params = semiIdx >= 0 ? header.slice(semiIdx + 1) : '';
  return { raw: line, name, params, value };
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ':' && !inQuotes) {
      return i;
    }
  }
  return -1;
}

function formatDateProp(propName: string, value: string): string {
  const trimmed = value.trim();
  const tzMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\[([^\]]+)\]$/.exec(trimmed);
  if (tzMatch) {
    const [, y, mo, d, h, mi, s, tzid] = tzMatch;
    return `${propName};TZID=${tzid}:${y}${mo}${d}T${h}${mi}${s}`;
  }
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnlyMatch) {
    const [, y, mo, d] = dateOnlyMatch;
    return `${propName};VALUE=DATE:${y}${mo}${d}`;
  }
  const floatingMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (floatingMatch) {
    const [, y, mo, d, h, mi, s] = floatingMatch;
    return `${propName}:${y}${mo}${d}T${h}${mi}${s}`;
  }
  return `${propName}:${formatICalDateUtc(trimmed)}`;
}

/**
 * Parses an iCalendar string containing a VTODO component into a canonical `Task`.
 * Rejects calendars without a VTODO component or missing required UID/SUMMARY fields.
 */
export function parseVTodo(ics: string, meta?: ParseVTodoMeta): Task {
  const lines = unfoldICalLines(ics);
  let inVTodo = false;
  let foundVTodo = false;
  let subComponentDepth = 0;

  let uid: string | undefined;
  let summary: string | undefined;
  let description: string | undefined;
  let status: TaskStatus | string | undefined;
  let priority: number | undefined;
  let percentComplete: number | undefined;
  let created: string | undefined;
  let lastModified: string | undefined;
  let completedAt: string | undefined;
  let dtstart: string | undefined;
  let due: string | undefined;
  const categories: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();

    if (upper === 'BEGIN:VTODO') {
      inVTodo = true;
      foundVTodo = true;
      continue;
    }
    if (upper === 'END:VTODO') {
      inVTodo = false;
      break;
    }
    if (!inVTodo) continue;

    if (upper.indexOf('BEGIN:') === 0) {
      subComponentDepth += 1;
      continue;
    }
    if (upper.indexOf('END:') === 0) {
      if (subComponentDepth > 0) subComponentDepth -= 1;
      continue;
    }
    if (subComponentDepth > 0) continue;

    const parsed = parseContentLine(line);
    if (!parsed) continue;

    switch (parsed.name) {
      case 'UID':
        uid = parsed.value.trim();
        break;
      case 'SUMMARY':
        summary = unescapeICalText(parsed.value.trim());
        break;
      case 'DESCRIPTION':
        description = unescapeICalText(parsed.value);
        break;
      case 'STATUS':
        status = parsed.value.trim().toUpperCase();
        break;
      case 'PRIORITY': {
        const n = parseInt(parsed.value.trim(), 10);
        if (!isNaN(n)) priority = n;
        break;
      }
      case 'PERCENT-COMPLETE': {
        const n = parseInt(parsed.value.trim(), 10);
        if (!isNaN(n)) percentComplete = n;
        break;
      }
      case 'CATEGORIES': {
        const parts = splitUnescapedCommas(parsed.value);
        for (let j = 0; j < parts.length; j++) {
          const cat = unescapeICalText(parts[j]).trim();
          if (cat && categories.indexOf(cat) === -1) {
            categories.push(cat);
          }
        }
        break;
      }
      case 'CREATED':
        created = parseICalDate(parsed.value, parsed.params);
        break;
      case 'LAST-MODIFIED':
        lastModified = parseICalDate(parsed.value, parsed.params);
        break;
      case 'COMPLETED':
        completedAt = parseICalDate(parsed.value, parsed.params);
        break;
      case 'DTSTART':
        dtstart = parseICalDate(parsed.value, parsed.params);
        break;
      case 'DUE':
        due = parseICalDate(parsed.value, parsed.params);
        break;
    }
  }

  if (!foundVTodo) {
    throw new Error('iCalendar payload does not contain a VTODO component');
  }
  if (!uid) {
    throw new Error('Missing required VTODO field: UID');
  }
  if (summary === undefined || summary === '') {
    throw new Error('Missing required VTODO field: SUMMARY');
  }

  let resolvedStatus: TaskStatus | string = status || 'NEEDS-ACTION';
  if (!status && (completedAt !== undefined || percentComplete === 100)) {
    resolvedStatus = 'COMPLETED';
  }

  const task: Task = {
    uid,
    summary,
    status: resolvedStatus,
    categories,
    rawIcs: ics,
  };

  if (description !== undefined) task.description = description;
  if (priority !== undefined) task.priority = priority;
  if (percentComplete !== undefined) task.percentComplete = percentComplete;
  if (created !== undefined) task.created = created;
  if (lastModified !== undefined) task.lastModified = lastModified;
  if (completedAt !== undefined) task.completedAt = completedAt;
  if (dtstart !== undefined) task.dtstart = dtstart;
  if (due !== undefined) task.due = due;
  if (meta?.calendarHref !== undefined) task.calendarHref = meta.calendarHref;
  if (meta?.href !== undefined) task.href = meta.href;
  if (meta?.etag !== undefined) task.etag = meta.etag;

  return task;
}

function buildManagedLines(task: Task, now: Date): { [key: string]: string | null } {
  const nowIcs = formatICalDateUtc(now);
  const status = task.status || 'NEEDS-ACTION';
  const isCompleted = status === 'COMPLETED';
  const percentComplete =
    task.percentComplete !== undefined ? task.percentComplete : isCompleted ? 100 : 0;

  const managed: { [key: string]: string | null } = {
    UID: `UID:${task.uid}`,
    DTSTAMP: `DTSTAMP:${nowIcs}`,
    'LAST-MODIFIED': `LAST-MODIFIED:${task.lastModified ? formatICalDateUtc(task.lastModified) : nowIcs}`,
    SUMMARY: `SUMMARY:${escapeICalText(task.summary)}`,
    STATUS: `STATUS:${status}`,
    'PERCENT-COMPLETE': `PERCENT-COMPLETE:${percentComplete}`,
    DESCRIPTION:
      task.description !== undefined && task.description !== ''
        ? `DESCRIPTION:${escapeICalText(task.description)}`
        : null,
    PRIORITY:
      task.priority !== undefined && task.priority > 0 ? `PRIORITY:${task.priority}` : null,
    CATEGORIES:
      task.categories.length > 0
        ? `CATEGORIES:${task.categories.map(escapeICalText).join(',')}`
        : null,
    COMPLETED: isCompleted
      ? `COMPLETED:${task.completedAt ? formatICalDateUtc(task.completedAt) : nowIcs}`
      : null,
    DTSTART: task.dtstart ? formatDateProp('DTSTART', task.dtstart) : null,
    DUE: task.due ? formatDateProp('DUE', task.due) : null,
  };

  if (task.created) {
    managed.CREATED = `CREATED:${formatICalDateUtc(task.created)}`;
  }

  return managed;
}

/**
 * Losslessly patches an existing iCalendar string with updated Task fields,
 * preserving all unknown VTODO properties, sub-components (like VALARM), and
 * surrounding VCALENDAR/VTIMEZONE blocks.
 */
export function patchVTodo(rawIcs: string, task: Task, options?: SerializeVTodoOptions): string {
  const now = options?.now ?? new Date();
  const managed = buildManagedLines(task, now);
  const handled: { [key: string]: boolean } = {};
  const lines = unfoldICalLines(rawIcs);
  const output: string[] = [];

  let inVTodo = false;
  let patched = false;
  let subComponentDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const upper = line.trim().toUpperCase();

    if (upper === 'BEGIN:VTODO') {
      inVTodo = true;
      output.push(line);
      continue;
    }

    if (upper === 'END:VTODO' && inVTodo) {
      const keys = Object.keys(managed);
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (!handled[key] && managed[key] !== null) {
          output.push(managed[key] as string);
        }
      }
      inVTodo = false;
      patched = true;
      output.push(line);
      continue;
    }

    if (!inVTodo) {
      output.push(line);
      continue;
    }

    if (upper.indexOf('BEGIN:') === 0) {
      subComponentDepth += 1;
      output.push(line);
      continue;
    }
    if (upper.indexOf('END:') === 0) {
      if (subComponentDepth > 0) subComponentDepth -= 1;
      output.push(line);
      continue;
    }
    if (subComponentDepth > 0) {
      output.push(line);
      continue;
    }

    const parsed = parseContentLine(line);
    if (parsed && Object.prototype.hasOwnProperty.call(managed, parsed.name)) {
      if (!handled[parsed.name]) {
        const replacement = managed[parsed.name];
        if (replacement !== null) {
          output.push(replacement);
        }
        handled[parsed.name] = true;
      }
      // Drop duplicate managed property lines (e.g. multiple CATEGORIES lines replaced by unified one)
      continue;
    }

    output.push(line);
  }

  if (!patched) {
    return serializeNewVTodo(task, now);
  }

  // Strip trailing blank lines and join with standard CRLF
  while (output.length > 0 && output[output.length - 1] === '') {
    output.pop();
  }
  return output.join('\r\n') + '\r\n';
}

function serializeNewVTodo(task: Task, now: Date): string {
  const nowIcs = formatICalDateUtc(now);
  const uid = task.uid || generateUid();
  const createdIcs = task.created ? formatICalDateUtc(task.created) : nowIcs;
  const managed = buildManagedLines({ ...task, uid }, now);

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//tasker//EN',
    'BEGIN:VTODO',
    `UID:${uid}`,
    managed.DTSTAMP as string,
    `CREATED:${createdIcs}`,
    managed['LAST-MODIFIED'] as string,
    managed.SUMMARY as string,
    managed.STATUS as string,
    managed['PERCENT-COMPLETE'] as string,
  ];

  const optionalOrder = ['PRIORITY', 'CATEGORIES', 'DESCRIPTION', 'DTSTART', 'DUE', 'COMPLETED'];
  for (let i = 0; i < optionalOrder.length; i++) {
    const val = managed[optionalOrder[i]];
    if (val !== null && val !== undefined) {
      lines.push(val);
    }
  }

  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Serializes a `Task` to an RFC 5545 iCalendar string.
 * When `task.rawIcs` is present, patches the existing VTODO losslessly;
 * otherwise builds a fresh VCALENDAR/VTODO document.
 */
export function serializeVTodo(task: Task, options?: SerializeVTodoOptions): string {
  if (task.rawIcs) {
    return patchVTodo(task.rawIcs, task, options);
  }
  return serializeNewVTodo(task, options?.now ?? new Date());
}
