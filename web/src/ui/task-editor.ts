import type { Task } from '@tasker/core';
import { escapeAttr, escapeHtml } from './html';

export interface TaskEditorProps {
  task: Task;
  categoryOrder: string[];
  confirmingDelete: boolean;
}

export function renderTaskEditor({
  task,
  categoryOrder,
  confirmingDelete,
}: TaskEditorProps): string {
  const categoryOptions = categoryOrder
    .map((cat) => `<option value="${escapeAttr(cat)}">${escapeHtml(cat)}</option>`)
    .join('');

  return `
    <div class="modal-backdrop" data-testid="task-editor-modal">
      <section class="panel modal-card">
        <div class="panel-header">
          <h2>Edit Item</h2>
          <button type="button" id="editor-cancel-x" class="btn-ghost" aria-label="Close editor">Close</button>
        </div>
        <form id="task-editor-form" class="stack-form" data-uid="${escapeAttr(task.uid)}">
          <label>
            <span>Summary</span>
            <input name="summary" type="text" required value="${escapeAttr(task.summary)}" />
          </label>
          <label>
            <span>Categories <small class="muted">(comma-separated)</small></span>
            <input name="categories" type="text" list="category-datalist" value="${escapeAttr(task.categories.join(', '))}" />
            <datalist id="category-datalist">${categoryOptions}</datalist>
          </label>
          <label>
            <span>Notes</span>
            <textarea name="description" rows="3" placeholder="Details, quantity, context…">${escapeHtml(task.description ?? '')}</textarea>
          </label>
          <label>
            <span>Priority <small class="muted">(0 = none, 1 = highest, 9 = lowest)</small></span>
            <input name="priority" type="number" min="0" max="9" value="${escapeAttr(String(task.priority ?? 0))}" />
          </label>
          <div class="editor-footer">
            <div class="actions">
              <button type="submit">Save changes</button>
              <button type="button" id="editor-cancel" class="btn-secondary">Cancel</button>
            </div>
            <div class="delete-zone">
              ${
                confirmingDelete
                  ? `<button type="button" id="editor-delete-confirm" class="btn-danger">Confirm Delete</button>
                     <button type="button" id="editor-delete-abort" class="btn-ghost">Keep</button>`
                  : `<button type="button" id="editor-delete" class="btn-danger-outline">Delete</button>`
              }
            </div>
          </div>
        </form>
      </section>
    </div>
  `;
}
