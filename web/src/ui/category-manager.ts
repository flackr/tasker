import { escapeAttr, escapeHtml } from './html';

export interface CategoryManagerProps {
  categories: string[];
  renamingIndex: number | null;
}

export function renderCategoryManager({
  categories,
  renamingIndex,
}: CategoryManagerProps): string {
  return `
    <section class="panel" data-testid="category-manager">
      <div class="panel-header">
        <div>
          <h2>Category Order</h2>
          <p class="muted">Tasks in both the web app and Fitbit watch are grouped and sorted in this order.</p>
        </div>
      </div>

      <form id="add-category-form" class="quick-add-form category-add-form">
        <input name="categoryName" type="text" required placeholder="Add category (e.g. Errands, Snacks)…" aria-label="New category name" />
        <button type="submit">Add category</button>
      </form>

      <ol class="category-list" data-testid="category-list">
        ${
          categories.length > 0
            ? categories
                .map((category, idx) =>
                  renderCategoryRow(category, idx, categories.length, renamingIndex === idx),
                )
                .join('')
            : '<li class="empty">No categories configured.</li>'
        }
      </ol>
    </section>
  `;
}

function renderCategoryRow(
  category: string,
  idx: number,
  total: number,
  isRenaming: boolean,
): string {
  if (isRenaming) {
    return `
      <li class="category-row" data-category-index="${idx}">
        <form class="rename-category-form" data-rename-index="${idx}">
          <input name="newName" type="text" required value="${escapeAttr(category)}" aria-label="Rename category" />
          <button type="submit">Save</button>
          <button type="button" class="btn-secondary" data-rename-cancel>Cancel</button>
        </form>
      </li>
    `;
  }

  return `
    <li class="category-row" data-category-index="${idx}">
      <span class="category-name">${idx + 1}. ${escapeHtml(category)}</span>
      <div class="category-actions">
        <button type="button" class="btn-ghost" data-move-up="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${escapeAttr(category)} up">Up</button>
        <button type="button" class="btn-ghost" data-move-down="${idx}" ${idx === total - 1 ? 'disabled' : ''} aria-label="Move ${escapeAttr(category)} down">Down</button>
        <button type="button" class="btn-ghost" data-start-rename="${idx}">Rename</button>
        <button type="button" class="btn-danger-outline" data-delete-category="${idx}">Remove</button>
      </div>
    </li>
  `;
}
