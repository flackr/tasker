import type { SyncConflict, Task } from '@tasker/core';
import { sortTasksByCategory } from '@tasker/core/watch';
import { isPromptApiUsable, type PromptApiAvailability } from '../ai/categorizer';
import { escapeAttr, escapeHtml } from './html';

export interface ListViewProps {
  tasks: Task[];
  categoryOrder: string[];
  conflicts: SyncConflict[];
  statusMessage: string;
  hideCompleted: boolean;
  calendarName?: string;
  promptApiAvailability: PromptApiAvailability;
  autoCategorizeProgress: string | null;
}

interface CategoryGroup {
  label: string;
  tasks: Task[];
}

function resolvePrimaryCategory(task: Task, categoryOrder: string[]): string {
  const normalizedOrder = categoryOrder.map((c) => c.trim().toLowerCase());
  let bestIdx = normalizedOrder.length;
  let bestLabel = '';

  for (const cat of task.categories) {
    const idx = normalizedOrder.indexOf(cat.trim().toLowerCase());
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      bestLabel = categoryOrder[idx];
    }
  }

  if (bestLabel) return bestLabel;
  if (task.categories.length > 0) return task.categories[0];
  return 'Uncategorized';
}

function groupTasksByCategory(tasks: Task[], categoryOrder: string[]): CategoryGroup[] {
  const sorted = sortTasksByCategory(tasks, categoryOrder);
  const groups: CategoryGroup[] = [];
  const groupMap = new Map<string, CategoryGroup>();

  for (const task of sorted) {
    const label = resolvePrimaryCategory(task, categoryOrder);
    let group = groupMap.get(label);
    if (!group) {
      group = { label, tasks: [] };
      groupMap.set(label, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }

  return groups;
}

export function renderListView({
  tasks,
  categoryOrder,
  conflicts,
  statusMessage,
  hideCompleted,
  calendarName,
  promptApiAvailability,
  autoCategorizeProgress,
}: ListViewProps): string {
  const visibleTasks = hideCompleted
    ? tasks.filter((t) => t.status !== 'COMPLETED')
    : tasks;
  const completedCount = tasks.filter((t) => t.status === 'COMPLETED').length;
  const uncategorizedCount = tasks.filter((t) => t.categories.length === 0).length;
  const groups = groupTasksByCategory(visibleTasks, categoryOrder);
  const canAutoCategorize = isPromptApiUsable(promptApiAvailability) && categoryOrder.length > 0;

  const categoryOptions = [
    '<option value="">Uncategorized</option>',
    ...categoryOrder.map(
      (cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`,
    ),
  ].join('');

  return `
    <section class="panel" data-testid="list-panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(calendarName || 'Task List')}</h2>
          <p class="status status-inline" data-testid="status">${escapeHtml(statusMessage)}</p>
        </div>
        <div class="list-controls">
          ${
            canAutoCategorize && !autoCategorizeProgress && uncategorizedCount > 0
              ? `<button type="button" id="run-auto-categorize" class="btn-ghost" data-testid="run-auto-categorize">Auto-categorize (${uncategorizedCount})</button>`
              : ''
          }
          <label class="toggle-label">
            <input type="checkbox" id="toggle-hide-completed" ${hideCompleted ? 'checked' : ''} />
            <span>Hide done (${completedCount})</span>
          </label>
        </div>
      </div>

      ${
        autoCategorizeProgress
          ? `<div class="ai-progress-banner" role="status" data-testid="ai-progress-banner">
              <span>${escapeHtml(autoCategorizeProgress)}</span>
              <button type="button" id="stop-auto-categorize" class="btn-ghost">Stop</button>
            </div>`
          : ''
      }

      ${conflicts.length > 0 ? renderConflictBanners(conflicts) : ''}

      <form id="quick-add-form" class="quick-add-form" data-testid="quick-add-form">
        <input
          name="summary"
          type="text"
          required
          placeholder="Add task…"
          aria-label="New task"
        />
        <select name="category" aria-label="Category">${categoryOptions}</select>
        <button type="submit">Add</button>
      </form>

      <div class="category-groups" data-testid="task-list">
        ${
          groups.length > 0
            ? groups.map(renderCategoryGroup).join('')
            : '<p class="empty">No items in this list yet.</p>'
        }
      </div>
    </section>
  `;
}

function renderConflictBanners(conflicts: SyncConflict[]): string {
  return `
    <div class="conflict-list" data-testid="conflict-banner">
      ${conflicts
        .map(
          (c) => `
        <div class="conflict-card" data-conflict-uid="${escapeAttr(c.uid)}">
          <div class="conflict-header">
            <strong>Sync conflict: ${escapeHtml(c.local.summary)}</strong>
            <span class="muted">Updated on another device while you were offline</span>
          </div>
          <div class="conflict-diff">
            <div>
              <span class="diff-label">Your version</span>
              <p>${escapeHtml(c.local.summary)} (${escapeHtml(c.local.status)})</p>
            </div>
            <div>
              <span class="diff-label">Server version</span>
              <p>${escapeHtml(c.server.summary)} (${escapeHtml(c.server.status)})</p>
            </div>
          </div>
          <div class="actions">
            <button type="button" class="btn-primary" data-resolve-conflict="local" data-uid="${escapeAttr(c.uid)}">Keep Local</button>
            <button type="button" class="btn-secondary" data-resolve-conflict="server" data-uid="${escapeAttr(c.uid)}">Keep Server</button>
          </div>
        </div>`,
        )
        .join('')}
    </div>
  `;
}

function renderCategoryGroup(group: CategoryGroup): string {
  return `
    <div class="category-group" data-category="${escapeAttr(group.label)}">
      <h3 class="category-heading">${escapeHtml(group.label)}</h3>
      <ul class="task-list">
        ${group.tasks.map(renderTaskItem).join('')}
      </ul>
    </div>
  `;
}

function renderTaskItem(task: Task): string {
  const completed = task.status === 'COMPLETED';
  const classes = [
    'task',
    completed ? 'completed' : '',
    task.dirty ? 'dirty' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const extraTags = task.categories.length
    ? `<span class="categories">${task.categories.map(escapeHtml).join(', ')}</span>`
    : '';
  const notes = task.description
    ? `<span class="task-notes">${escapeHtml(task.description)}</span>`
    : '';
  const dirtyTag = task.dirty
    ? '<span class="dirty-dot" title="Pending sync">Pending</span>'
    : '';

  return `
    <li class="${classes}" data-task-uid="${escapeAttr(task.uid)}">
      <label class="task-check">
        <input
          type="checkbox"
          data-toggle-uid="${escapeAttr(task.uid)}"
          ${completed ? 'checked' : ''}
          aria-label="Mark ${escapeAttr(task.summary)} as completed"
        />
        <span class="task-main">
          <span class="task-summary">${escapeHtml(task.summary)}</span>
          ${notes}
        </span>
      </label>
      <div class="task-meta">
        ${extraTags}
        ${dirtyTag}
        <button type="button" class="btn-ghost" data-edit-uid="${escapeAttr(task.uid)}">Edit</button>
      </div>
    </li>
  `;
}
