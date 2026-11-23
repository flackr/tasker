import { describe, expect, it } from 'vitest';
import { sortTasksByAisle } from './aisles.js';
import type { CompactTask } from './types.js';

describe('sortTasksByAisle', () => {
  const aisleOrder = ['Produce', 'Bakery', 'Dairy'];

  it('orders tasks by configured aisle order and places uncategorized items last', () => {
    const tasks: CompactTask[] = [
      { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false },
      { uid: '2', summary: 'Batteries', categories: [], completed: false },
      { uid: '3', summary: 'Apples', categories: ['produce'], completed: false },
      { uid: '4', summary: 'Sourdough', categories: ['Bakery'], completed: false },
      { uid: '5', summary: 'Bananas', categories: ['Produce'], completed: false },
    ];

    const sorted = sortTasksByAisle(tasks, aisleOrder);
    expect(sorted.map((t) => t.summary)).toEqual([
      'Apples',
      'Bananas',
      'Sourdough',
      'Milk',
      'Batteries',
    ]);
  });

  it('uses the earliest matching aisle when a task has multiple categories', () => {
    const tasks: CompactTask[] = [
      { uid: '1', summary: 'Cheese', categories: ['Dairy'], completed: false },
      { uid: '2', summary: 'Herb Bread', categories: ['Dairy', 'Bakery'], completed: false },
    ];

    const sorted = sortTasksByAisle(tasks, aisleOrder);
    expect(sorted.map((t) => t.summary)).toEqual(['Herb Bread', 'Cheese']);
  });

  it('does not mutate the input array', () => {
    const tasks: CompactTask[] = [
      { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false },
      { uid: '2', summary: 'Apples', categories: ['Produce'], completed: false },
    ];

    const sorted = sortTasksByAisle(tasks, aisleOrder);
    expect(sorted).not.toBe(tasks);
    expect(tasks[0].summary).toBe('Milk');
  });
});
