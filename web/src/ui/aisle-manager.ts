import { escapeAttr, escapeHtml } from './html';

export interface AisleManagerProps {
  aisles: string[];
  renamingIndex: number | null;
}

export function renderAisleManager({ aisles, renamingIndex }: AisleManagerProps): string {
  return `
    <section class="panel" data-testid="aisle-manager">
      <div class="panel-header">
        <div>
          <h2>Store Aisle Order</h2>
          <p class="muted">Items in both the PWA and Fitbit watch follow this walk order.</p>
        </div>
      </div>

      <form id="add-aisle-form" class="quick-add-form aisle-add-form">
        <input name="aisleName" type="text" required placeholder="Add aisle (e.g. Snacks, Bulk)…" aria-label="New aisle name" />
        <button type="submit">Add aisle</button>
      </form>

      <ol class="aisle-list" data-testid="aisle-list">
        ${
          aisles.length > 0
            ? aisles
                .map((aisle, idx) => renderAisleRow(aisle, idx, aisles.length, renamingIndex === idx))
                .join('')
            : '<li class="empty">No aisles configured.</li>'
        }
      </ol>
    </section>
  `;
}

function renderAisleRow(aisle: string, idx: number, total: number, isRenaming: boolean): string {
  if (isRenaming) {
    return `
      <li class="aisle-row" data-aisle-index="${idx}">
        <form class="rename-aisle-form" data-rename-index="${idx}">
          <input name="newName" type="text" required value="${escapeAttr(aisle)}" aria-label="Rename aisle" />
          <button type="submit">Save</button>
          <button type="button" class="btn-secondary" data-rename-cancel>Cancel</button>
        </form>
      </li>
    `;
  }

  return `
    <li class="aisle-row" data-aisle-index="${idx}">
      <span class="aisle-name">${idx + 1}. ${escapeHtml(aisle)}</span>
      <div class="aisle-actions">
        <button type="button" class="btn-ghost" data-move-up="${idx}" ${idx === 0 ? 'disabled' : ''} aria-label="Move ${escapeAttr(aisle)} up">↑</button>
        <button type="button" class="btn-ghost" data-move-down="${idx}" ${idx === total - 1 ? 'disabled' : ''} aria-label="Move ${escapeAttr(aisle)} down">↓</button>
        <button type="button" class="btn-ghost" data-start-rename="${idx}">Rename</button>
        <button type="button" class="btn-danger-outline" data-delete-aisle="${idx}">Remove</button>
      </div>
    </li>
  `;
}
