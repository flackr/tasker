import type { Task } from '../types';

export function parseVTodo(ics: string): Task {
  const uid = matchRequired(ics, /^UID:(.+)$/m);
  const summary = matchRequired(ics, /^SUMMARY:(.+)$/m);
  const status = matchOptional(ics, /^STATUS:(.+)$/m) ?? 'NEEDS-ACTION';
  const categoriesValue = matchOptional(ics, /^CATEGORIES:(.+)$/m) ?? '';
  const categories = categoriesValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return { uid, summary, status, categories };
}

function matchRequired(source: string, pattern: RegExp): string {
  const value = matchOptional(source, pattern);
  if (!value) throw new Error('Missing required VTODO field');
  return value;
}

function matchOptional(source: string, pattern: RegExp): string | undefined {
  return source.match(pattern)?.[1]?.trim();
}
