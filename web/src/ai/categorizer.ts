import type { Task } from '@tasker/core';

export type PromptApiAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable'
  | 'unsupported';

export interface LanguageModelDownloadEvent {
  loaded?: number;
  total?: number;
}

export interface LanguageModelMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: LanguageModelDownloadEvent) => void,
  ): void;
}

export interface LanguageModelSession {
  prompt(
    input: string,
    options?: {
      responseConstraint?: Record<string, unknown>;
      signal?: AbortSignal;
    },
  ): Promise<string>;
  destroy(): void;
}

export interface LanguageModelStatic {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: {
    systemPrompt?: string;
    initialPrompts?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    expectedInputs?: Array<{ type: 'text'; languages?: string[] }>;
    expectedOutputs?: Array<{ type: 'text'; languages?: string[] }>;
    monitor?: (monitor: LanguageModelMonitor) => void;
    signal?: AbortSignal;
  }): Promise<LanguageModelStaticSession>;
}

type LanguageModelStaticSession = LanguageModelSession;

export interface AutoCategorizeCallbacks {
  onDownloadProgress?: (fraction: number) => void;
  onStepStart?: (task: Task, index: number, total: number) => void;
  onTaskCategorized?: (task: Task, category: string | null, index: number, total: number) => Promise<void> | void;
}

export interface AutoCategorizeOptions {
  languageModel?: LanguageModelStatic;
  signal?: AbortSignal;
  callbacks?: AutoCategorizeCallbacks;
}

export interface AutoCategorizeResult {
  processed: number;
  assigned: number;
  cancelled: boolean;
}

function getGlobalLanguageModel(): LanguageModelStatic | undefined {
  const g = globalThis as unknown as { LanguageModel?: LanguageModelStatic };
  if (
    g.LanguageModel &&
    typeof g.LanguageModel.availability === 'function' &&
    typeof g.LanguageModel.create === 'function'
  ) {
    return g.LanguageModel;
  }
  return undefined;
}

/**
 * Checks whether the browser's built-in on-device Prompt API (`LanguageModel`) is available.
 * See https://developer.mozilla.org/en-US/docs/Web/API/Prompt_API
 */
export async function checkPromptApiAvailability(
  languageModel: LanguageModelStatic | undefined = getGlobalLanguageModel(),
): Promise<PromptApiAvailability> {
  if (!languageModel) {
    return 'unsupported';
  }
  try {
    let status: string;
    try {
      status = await languageModel.availability({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
      });
    } catch {
      status = await languageModel.availability();
    }
    if (
      status === 'available' ||
      status === 'downloadable' ||
      status === 'downloading' ||
      status === 'unavailable'
    ) {
      return status;
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function isPromptApiUsable(availability: PromptApiAvailability): boolean {
  return (
    availability === 'available' ||
    availability === 'downloadable' ||
    availability === 'downloading'
  );
}

/**
 * Matches a model output (JSON `{ "category": ... }` or plain text) against the
 * user's configured categories, returning the canonical category name or `null`.
 */
export function parseCategoryResponse(
  rawResponse: string,
  categories: readonly string[],
): string | null {
  const lookup = new Map<string, string>();
  for (const cat of categories) {
    lookup.set(cat.trim().toLowerCase(), cat);
  }

  const trimmed = rawResponse.trim();
  if (!trimmed) return null;

  // 1. Try JSON object parsing first (expected from responseConstraint schema)
  try {
    const parsed = JSON.parse(trimmed) as { category?: unknown } | string | null;
    if (parsed === null) return null;
    if (typeof parsed === 'string') {
      return lookup.get(parsed.trim().toLowerCase()) ?? null;
    }
    if (typeof parsed === 'object' && parsed.category !== undefined) {
      if (parsed.category === null) return null;
      if (typeof parsed.category === 'string') {
        return lookup.get(parsed.category.trim().toLowerCase()) ?? null;
      }
    }
  } catch {
    // Fall through to plain-text matching
  }

  // 2. Fallback: exact case-insensitive match on cleaned plain text
  const cleaned = trimmed.replace(/^["'`]+|["'`]+$/g, '').trim().toLowerCase();
  if (cleaned === 'null' || cleaned === 'none' || cleaned === 'other') {
    return null;
  }
  const direct = lookup.get(cleaned);
  if (direct) return direct;

  // 3. Fallback: find a configured category explicitly named in a short reply
  for (const cat of categories) {
    if (cleaned === cat.trim().toLowerCase()) {
      return cat;
    }
  }
  return null;
}

function buildCategoryConstraint(categories: readonly string[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      category: {
        type: ['string', 'null'],
        enum: [...categories, null],
      },
    },
    required: ['category'],
    additionalProperties: false,
  };
}

function buildItemPrompt(task: Task, categories: readonly string[]): string {
  const notesLine = task.description ? `\nNotes: ${task.description}` : '';
  return (
    `Assign the single best matching category from the allowed list for this task item.\n` +
    `Allowed categories: ${categories.join(', ')}\n` +
    `If none of the allowed categories fit, return null.\n` +
    `Item: ${task.summary}${notesLine}\n` +
    `Respond with JSON: {"category": "<exact category or null>"}`
  );
}

/**
 * Steps one by one through uncategorized tasks (`task.categories.length === 0`)
 * and asks the browser's on-device Prompt API (`LanguageModel`) which of the
 * available categories each item belongs to.
 */
export async function categorizeUncategorizedTasks(
  tasks: readonly Task[],
  categories: readonly string[],
  options: AutoCategorizeOptions = {},
): Promise<AutoCategorizeResult> {
  const uncategorized = tasks.filter((t) => t.categories.length === 0);
  if (uncategorized.length === 0 || categories.length === 0) {
    return { processed: 0, assigned: 0, cancelled: false };
  }

  const languageModel = options.languageModel ?? getGlobalLanguageModel();
  if (!languageModel) {
    throw new Error('Prompt API (LanguageModel) is not supported in this browser.');
  }

  const availability = await checkPromptApiAvailability(languageModel);
  if (!isPromptApiUsable(availability)) {
    throw new Error(`Prompt API is ${availability} on this device.`);
  }

  const systemPrompt =
    'You classify task list items into one of the user-provided categories. ' +
    'Always choose strictly from the allowed categories list, or null if none fit.';

  const session = await languageModel.create({
    systemPrompt,
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
    signal: options.signal,
    monitor(m) {
      m.addEventListener('downloadprogress', (event) => {
        if (options.callbacks?.onDownloadProgress) {
          const loaded = event.loaded ?? 0;
          const total = event.total && event.total > 0 ? event.total : 1;
          options.callbacks.onDownloadProgress(Math.max(0, Math.min(1, loaded / total)));
        }
      });
    },
  });

  const constraint = buildCategoryConstraint(categories);
  let processed = 0;
  let assigned = 0;
  let cancelled = false;

  try {
    for (let i = 0; i < uncategorized.length; i++) {
      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }

      const task = uncategorized[i];
      options.callbacks?.onStepStart?.(task, i, uncategorized.length);

      const promptText = buildItemPrompt(task, categories);
      let raw: string;
      try {
        raw = await session.prompt(promptText, {
          responseConstraint: constraint,
          signal: options.signal,
        });
      } catch (err) {
        if (options.signal?.aborted) {
          cancelled = true;
          break;
        }
        // Fallback without responseConstraint if a browser build doesn't support JSON schema constraints
        raw = await session.prompt(promptText, { signal: options.signal });
      }

      if (options.signal?.aborted) {
        cancelled = true;
        break;
      }

      const matched = parseCategoryResponse(raw, categories);
      processed += 1;
      if (matched !== null) {
        assigned += 1;
      }

      await options.callbacks?.onTaskCategorized?.(task, matched, i, uncategorized.length);
    }
  } finally {
    try {
      session.destroy();
    } catch {
      // Ignore cleanup errors
    }
  }

  return { processed, assigned, cancelled };
}
