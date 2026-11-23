import type { SyncConflict, Task } from '@tasker/core';
import { sortTasksByAisle } from '@tasker/core/watch';
import { escapeAttr, escapeHtml } from './html';

export interface ListViewProps {
  tasks: Task[];
  aisleOrder: string[];
  conflicts: SyncConflict[];
  statusMessage: string;
  hideCompleted: boolean;
  calendarName?: string;
}

interface AisleGroup {
  label: string;
  tasks: Task[];
}

function resolvePrimaryAisle(task: Task, aisleOrder: string[]): string {
  const normalizedOrder = aisleOrder.map((a) => a.trim().toLowerCase());
  let bestIdx = normalizedOrder.length;
  let bestLabel = '';

  for (const cat of task.categories) {
    const idx = normalizedOrder.indexOf(cat.trim().toLowerCase());
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      bestLabel = aisleOrder[idx];
    }
  }

  if (bestLabel) return bestLabel;
  if (task.categories.length > 0) return task.categories[0];
  return 'Other';
}

function groupTasksByAisle(tasks: Task[], aisleOrder: string[]): AisleGroup[] {
  const sorted = sortTasksByAisle(tasks, aisleOrder);
  const groups: AisleGroup[] = [];
  const groupMap = new Map<string, AisleGroup>();

  for (const task of sorted) {
    const label = resolvePrimaryAisle(task, aisleOrder);
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
  aisleOrder,
  conflicts,
  statusMessage,
  hideCompleted,
  calendarName,
}: ListViewProps): string {
  const visibleTasks = hideCompleted
    ? tasks.filter((t) => t.status !== 'COMPLETED')
    : tasks;
  const completedCount = tasks.filter((t) => t.status === 'COMPLETED').length;
  const groups = groupTasksByAisle(visibleTasks, aisleOrder);

  const aisleOptions = [
    '<option value="">Uncategorized</option>',
    ...aisleOrder.map(
      (aisle) => `<option value="${escapeAttr(aisle)}">${escapeHtml(aisle)}</option>`,
    ),
  ].join('');

  return `
    <section class="panel" data-testid="list-panel">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(calendarName || 'Grocery List')}</h2>
          <p class="status status-inline" data-testid="status">${escapeHtml(statusMessage)}</p>
        </div>
        <div class="list-controls">
          <label class="toggle-label">
            <input type="checkbox" id="toggle-hide-completed" ${hideCompleted ? 'checked' : ''} />
            <span>Hide done (${completedCount})</span>
          </label>
        </div>
      </div>

      ${conflicts.length > 0 ? renderConflictBanners(conflicts) : ''}

      <form id="quick-add-form" class="quick-add-form" data-testid="quick-add-form">
        <input
          name="summary"
          type="text"
          required
          placeholder="Add grocery item…"
          aria-label="New grocery item"
        />
        <select name="aisle" aria-label="Aisle">${aisleOptions}</select>
        <button type="submit">Add</button>
      </form>

      <div class="aisle-groups" data-testid="task-list">
        ${
          groups.length > 0
            ? groups.map(renderAisleGroup).join('')
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

function renderAisleGroup(group: AisleGroup): string {
  return `
    <div class="aisle-group" data-aisle="${escapeAttr(group.label)}">
      <h3 class="aisle-heading">${escapeHtml(group.label)}</h3>
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
