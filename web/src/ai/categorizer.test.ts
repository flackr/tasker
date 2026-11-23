import type { Task } from '@tasker/core';
import { describe, expect, it, vi } from 'vitest';
import {
  categorizeUncategorizedTasks,
  checkPromptApiAvailability,
  parseCategoryResponse,
  type LanguageModelStatic,
} from './categorizer';

describe('Prompt API categorizer', () => {
  it('reports unsupported when LanguageModel is absent and maps standard availability states', async () => {
    expect(await checkPromptApiAvailability(undefined)).toBe('unsupported');

    const availableLm = {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    } as unknown as LanguageModelStatic;
    expect(await checkPromptApiAvailability(availableLm)).toBe('available');

    const downloadableLm = {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create: vi.fn(),
    } as unknown as LanguageModelStatic;
    expect(await checkPromptApiAvailability(downloadableLm)).toBe('downloadable');
  });

  it('parses JSON and plain-text category responses case-insensitively', () => {
    const categories = ['Produce', 'Bakery', 'Dairy'];
    expect(parseCategoryResponse('{"category": "dairy"}', categories)).toBe('Dairy');
    expect(parseCategoryResponse('{"category": null}', categories)).toBeNull();
    expect(parseCategoryResponse('Produce', categories)).toBe('Produce');
    expect(parseCategoryResponse('{"category": "Unknown"}', categories)).toBeNull();
    expect(parseCategoryResponse('none', categories)).toBeNull();
  });

  it('steps one by one through only uncategorized tasks, passes responseConstraint, and destroys session', async () => {
    const destroy = vi.fn();
    const prompt = vi
      .fn()
      .mockResolvedValueOnce('{"category": "Produce"}')
      .mockResolvedValueOnce('{"category": null}')
      .mockResolvedValueOnce('{"category": "Dairy"}');

    const lm: LanguageModelStatic = {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue({ prompt, destroy }),
    };

    const tasks: Task[] = [
      { uid: '1', summary: 'Apples', status: 'NEEDS-ACTION', categories: [] },
      { uid: '2', summary: 'Already Tagged', status: 'NEEDS-ACTION', categories: ['Bakery'] },
      { uid: '3', summary: 'Batteries', status: 'NEEDS-ACTION', categories: [] },
      { uid: '4', summary: 'Whole Milk', status: 'NEEDS-ACTION', categories: [] },
    ];
    const categories = ['Produce', 'Bakery', 'Dairy'];
    const steps: string[] = [];
    const results: Array<{ uid: string; category: string | null }> = [];

    const summary = await categorizeUncategorizedTasks(tasks, categories, {
      languageModel: lm,
      callbacks: {
        onStepStart(task, idx, total) {
          steps.push(`${idx + 1}/${total}:${task.uid}`);
        },
        onTaskCategorized(task, category) {
          results.push({ uid: task.uid, category });
        },
      },
    });

    expect(summary).toEqual({ processed: 3, assigned: 2, cancelled: false });
    expect(steps).toEqual(['1/3:1', '2/3:3', '3/3:4']);
    expect(results).toEqual([
      { uid: '1', category: 'Produce' },
      { uid: '3', category: null },
      { uid: '4', category: 'Dairy' },
    ]);

    // Verify responseConstraint enum contains exact categories + null
    const firstCallOpts = prompt.mock.calls[0][1];
    expect(firstCallOpts.responseConstraint.properties.category.enum).toEqual([
      'Produce',
      'Bakery',
      'Dairy',
      null,
    ]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('falls back to unconstrained prompt when responseConstraint fails and supports AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const destroy = vi.fn();
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(new Error('responseConstraint not supported'))
      .mockResolvedValueOnce('Bakery');

    const lm: LanguageModelStatic = {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue({ prompt, destroy }),
    };

    const tasks: Task[] = [
      { uid: '1', summary: 'Sourdough', status: 'NEEDS-ACTION', categories: [] },
      { uid: '2', summary: 'Milk', status: 'NEEDS-ACTION', categories: [] },
    ];

    const assigned: Array<{ uid: string; category: string | null }> = [];
    const summary = await categorizeUncategorizedTasks(tasks, ['Bakery', 'Dairy'], {
      languageModel: lm,
      signal: controller.signal,
      callbacks: {
        onTaskCategorized(task, category) {
          assigned.push({ uid: task.uid, category });
          // Cancel after the first item completes
          controller.abort();
        },
      },
    });

    expect(assigned).toEqual([{ uid: '1', category: 'Bakery' }]);
    expect(summary).toEqual({ processed: 1, assigned: 1, cancelled: true });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
