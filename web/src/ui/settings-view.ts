import type { CalendarInfo, Credentials } from '@tasker/core';
import { isPromptApiUsable, type PromptApiAvailability } from '../ai/categorizer';
import { escapeAttr, escapeHtml } from './html';

export interface SettingsViewProps {
  credentials?: Credentials;
  calendars: CalendarInfo[];
  connectionStatus: string;
  connectionState: 'idle' | 'connecting' | 'connected' | 'error' | 'offline';
  autoCategorize: boolean;
  promptApiAvailability: PromptApiAvailability;
}

function getPromptApiBadge(availability: PromptApiAvailability): { label: string; className: string } {
  switch (availability) {
    case 'available':
      return { label: 'Local AI ready', className: 'conn-badge conn-connected' };
    case 'downloadable':
      return { label: 'Local AI downloadable', className: 'conn-badge conn-connecting' };
    case 'downloading':
      return { label: 'Downloading model…', className: 'conn-badge conn-connecting' };
    case 'unavailable':
      return { label: 'Local AI unavailable', className: 'conn-badge conn-idle' };
    default:
      return { label: 'Not supported by browser', className: 'conn-badge conn-idle' };
  }
}

export function renderSettingsView({
  credentials,
  calendars,
  connectionStatus,
  connectionState,
  autoCategorize,
  promptApiAvailability,
}: SettingsViewProps): string {
  const badgeClass = `conn-badge conn-${connectionState}`;
  const badgeLabel =
    connectionState === 'connected'
      ? 'Connected'
      : connectionState === 'connecting'
        ? 'Connecting…'
        : connectionState === 'offline'
          ? 'Offline'
          : connectionState === 'error'
            ? 'Connection failed'
            : 'Not connected';

  const aiUsable = isPromptApiUsable(promptApiAvailability);
  const aiBadge = getPromptApiBadge(promptApiAvailability);

  return `
    <section class="panel" data-testid="settings-panel">
      <div class="panel-header">
        <h2>Nextcloud Connection</h2>
        <span class="${badgeClass}" data-testid="connection-badge">${badgeLabel}</span>
      </div>
      <p class="status" data-testid="status">${escapeHtml(connectionStatus)}</p>
      <form id="auth-form" class="stack-form">
        <label>
          <span>Nextcloud URL</span>
          <input name="baseUrl" type="url" required placeholder="https://cloud.example.com" value="${escapeAttr(credentials?.baseUrl ?? '')}" />
        </label>
        <label>
          <span>Username</span>
          <input name="username" type="text" required placeholder="alice" value="${escapeAttr(credentials?.username ?? '')}" />
        </label>
        <label>
          <span>App password</span>
          <input name="appPassword" type="password" required value="${escapeAttr(credentials?.appPassword ?? '')}" />
        </label>
        <label>
          <span>Config JSON path <small class="muted">(optional WebDAV path)</small></span>
          <input name="configPath" type="text" placeholder="Notes/tasker-config.json" value="${escapeAttr(credentials?.configPath ?? '')}" />
        </label>
        <div class="actions">
          <button type="submit">Connect</button>
          <button type="button" id="logout" class="btn-secondary">Clear &amp; Logout</button>
        </div>
      </form>
      ${calendars.length > 0 ? renderCalendarPicker(calendars, credentials?.calendarHref) : ''}

      <div class="settings-section" data-testid="ai-settings-section">
        <div class="panel-header">
          <h3>Auto-Categorize (On-Device AI)</h3>
          <span class="${aiBadge.className}" data-testid="ai-availability-badge">${aiBadge.label}</span>
        </div>
        <label class="checkbox-setting">
          <input
            type="checkbox"
            id="toggle-auto-categorize"
            data-testid="auto-categorize-toggle"
            ${autoCategorize ? 'checked' : ''}
            ${aiUsable ? '' : 'disabled'}
          />
          <span>Automatically step through uncategorized tasks using the browser Prompt API and assign matching categories</span>
        </label>
        <p class="muted">
          ${
            aiUsable
              ? 'Runs locally in your browser using the Web Prompt API (LanguageModel) — task data never leaves your device.'
              : 'Requires a browser with the Web Prompt API (LanguageModel) enabled.'
          }
        </p>
      </div>
    </section>
  `;
}

function renderCalendarPicker(calendars: CalendarInfo[], selectedHref?: string): string {
  const options = calendars
    .map(
      (calendar) =>
        `<option value="${escapeAttr(calendar.href)}" ${calendar.href === selectedHref ? 'selected' : ''}>${escapeHtml(calendar.displayName)}</option>`,
    )
    .join('');

  return `
    <form id="calendar-form" class="stack-form calendar-form">
      <label>
        <span>Task list</span>
        <select name="calendarHref" data-testid="calendar-select">${options}</select>
      </label>
      <div class="actions">
        <button type="submit">Load tasks</button>
      </div>
    </form>
  `;
}
