import type { SyncConflict, Task } from '@tasker/core';
import { sortTasksByCategory } from '@tasker/core/watch';
import { isPromptApiUsable, type PromptApiAvailability } from '../ai/categorizer';
import { escapeAttr, escapeHtml } from './html';

export interface ListViewProps {
  tasks: Task[];
  categoryOrder: string[];
  conflicts: SyncConflict[];
  hideCompleted: boolean;
  focusedUid: string | null;
  promptApiAvailability: PromptApiAvailability;
  autoCategorizeProgress: string | null;
}

export interface AddTaskModalProps {
  categoryOrder: string[];
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
  hideCompleted,
  focusedUid,
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

  return `
    <section class="panel list-panel" data-testid="list-panel">
      <div class="list-toolbar">
        <span class="list-count">${visibleTasks.length} ${visibleTasks.length === 1 ? 'item' : 'items'}</span>
        <div class="list-controls">
          ${
            canAutoCategorize && !autoCategorizeProgress && uncategorizedCount > 0
              ? `<button type="button" id="run-auto-categorize" class="btn-ghost btn-compact" data-testid="run-auto-categorize">Auto-categorize (${uncategorizedCount})</button>`
              : ''
          }
          ${
            completedCount > 0
              ? `<button type="button" id="clear-completed-btn" class="btn-danger-outline btn-compact" data-testid="clear-completed-btn">Clear done (${completedCount})</button>`
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
              <button type="button" id="stop-auto-categorize" class="btn-ghost btn-compact">Stop</button>
            </div>`
          : ''
      }

      ${conflicts.length > 0 ? renderConflictBanners(conflicts) : ''}

      <div class="category-groups" data-testid="task-list">
        ${
          groups.length > 0
            ? groups.map((group) => renderCategoryGroup(group, focusedUid)).join('')
            : '<p class="empty">No items in this list yet. Tap + to add one.</p>'
        }
      </div>
    </section>

    <button
      type="button"
      id="add-task-fab"
      class="fab"
      data-testid="add-task-fab"
      aria-label="Add task"
      title="Add task"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
      </svg>
    </button>
  `;
}

export function renderAddTaskModal({ categoryOrder }: AddTaskModalProps): string {
  const categoryOptions = [
    '<option value="">Uncategorized</option>',
    ...categoryOrder.map(
      (cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`,
    ),
  ].join('');

  return `
    <div class="modal-backdrop" id="add-task-backdrop" data-testid="add-task-modal">
      <div class="panel modal-card" role="dialog" aria-modal="true" aria-labelledby="add-task-title">
        <div class="panel-header">
          <h2 id="add-task-title">Add Task</h2>
          <button type="button" class="btn-ghost" id="add-task-close-x" aria-label="Close">Close</button>
        </div>
        <form id="quick-add-form" class="stack-form" data-testid="quick-add-form">
          <label>
            <span>Task</span>
            <input
              id="quick-add-summary"
              name="summary"
              type="text"
              required
              placeholder="What needs to be done?"
              aria-label="New task"
            />
          </label>
          <label>
            <span>Category</span>
            <select name="category" aria-label="Category">${categoryOptions}</select>
          </label>
          <label>
            <span>Notes <small class="muted">(optional)</small></span>
            <textarea name="description" rows="2" placeholder="Optional details…"></textarea>
          </label>
          <div class="actions">
            <button type="submit">Add</button>
            <button type="button" class="btn-secondary" id="add-task-cancel">Cancel</button>
          </div>
        </form>
      </div>
    </div>
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

function renderCategoryGroup(group: CategoryGroup, focusedUid: string | null): string {
  return `
    <div class="category-group" data-category="${escapeAttr(group.label)}">
      <h3 class="category-heading">${escapeHtml(group.label)}</h3>
      <ul class="task-list">
        ${group.tasks.map((task) => renderTaskItem(task, task.uid === focusedUid)).join('')}
      </ul>
    </div>
  `;
}

function renderTaskItem(task: Task, isFocused: boolean): string {
  const completed = task.status === 'COMPLETED';
  const classes = [
    'task',
    completed ? 'completed' : '',
    task.dirty ? 'dirty' : '',
    isFocused ? 'focused' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const notes = task.description
    ? `<span class="task-notes">${escapeHtml(task.description)}</span>`
    : '';
  const dirtyTag = task.dirty
    ? '<span class="dirty-dot" title="Pending sync">Pending</span>'
    : '';

  const mainContent = isFocused
    ? `<div class="task-main">
        <input
          type="text"
          class="task-inline-input"
          data-inline-uid="${escapeAttr(task.uid)}"
          value="${escapeAttr(task.summary)}"
          aria-label="Edit task title"
        />
        ${notes}
      </div>`
    : `<button
        type="button"
        class="task-body"
        data-focus-uid="${escapeAttr(task.uid)}"
      >
        <span class="task-summary">${escapeHtml(task.summary)}</span>
        ${notes}
      </button>`;

  return `
    <li class="${classes}" data-task-uid="${escapeAttr(task.uid)}">
      <input
        type="checkbox"
        class="task-checkbox"
        data-toggle-uid="${escapeAttr(task.uid)}"
        ${completed ? 'checked' : ''}
        aria-label="Mark ${escapeAttr(task.summary)} as completed"
      />
      ${mainContent}
      <div class="task-meta">
        ${dirtyTag}
        <div class="task-actions">
          <button type="button" class="btn-ghost btn-compact" data-edit-uid="${escapeAttr(task.uid)}">Edit</button>
          <button type="button" class="btn-danger-outline btn-compact" data-delete-uid="${escapeAttr(task.uid)}">Delete</button>
        </div>
      </div>
    </li>
  `;
}
