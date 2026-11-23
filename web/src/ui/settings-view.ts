import type { CalendarInfo, Credentials } from '@tasker/core';
import { escapeAttr, escapeHtml } from './html';

export interface SettingsViewProps {
  credentials?: Credentials;
  calendars: CalendarInfo[];
  connectionStatus: string;
  connectionState: 'idle' | 'connecting' | 'connected' | 'error' | 'offline';
}

export function renderSettingsView({
  credentials,
  calendars,
  connectionStatus,
  connectionState,
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
