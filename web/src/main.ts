import './style.css';
import { clearCredentials, loadCredentials, saveCredentials } from './auth';
import { fetchTasks, listTaskCalendars } from './caldav/client';
import type { CalendarInfo, Credentials, Task } from './types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

void bootstrap();

async function bootstrap() {
  const saved = await loadCredentials();
  render(saved);
  if (saved) {
    void connect(saved);
  }
}

function render(
  initial?: Credentials,
  tasks: Task[] = [],
  status = 'Enter your Nextcloud credentials to load tasks.',
  calendars: CalendarInfo[] = [],
) {
  app!.innerHTML = `
    <main class="layout">
      <section class="panel">
        <h1>tasker</h1>
        <p class="status" data-testid="status">${escapeHtml(status)}</p>
        <form id="auth-form" class="auth-form">
          <label>
            <span>Nextcloud URL</span>
            <input name="baseUrl" type="url" required value="${escapeAttr(initial?.baseUrl ?? '')}" />
          </label>
          <label>
            <span>Username</span>
            <input name="username" type="text" required value="${escapeAttr(initial?.username ?? '')}" />
          </label>
          <label>
            <span>App password</span>
            <input name="appPassword" type="password" required value="${escapeAttr(initial?.appPassword ?? '')}" />
          </label>
          <div class="actions">
            <button type="submit">Connect</button>
            <button type="button" id="logout">Clear</button>
          </div>
        </form>
        ${calendars.length ? renderCalendarPicker(calendars, initial?.calendarHref) : ''}
      </section>
      <section class="panel">
        <h2>Task list</h2>
        <ul class="task-list" data-testid="task-list">
          ${tasks.length ? tasks.map(renderTask).join('') : '<li class="empty">No tasks loaded.</li>'}
        </ul>
      </section>
    </main>
  `;

  const form = document.querySelector<HTMLFormElement>('#auth-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const credentials: Credentials = {
      baseUrl: String(formData.get('baseUrl') ?? ''),
      username: String(formData.get('username') ?? ''),
      appPassword: String(formData.get('appPassword') ?? ''),
    };
    await saveCredentials(credentials);
    render(credentials, [], 'Connecting…');
    await connect(credentials);
  });

  document.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', async () => {
    await clearCredentials();
    render(undefined, [], 'Credentials cleared.');
  });

  document.querySelector<HTMLFormElement>('#calendar-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!initial) return;
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const calendarHref = String(formData.get('calendarHref') ?? '');
    if (!calendarHref) return;
    const credentials = { ...initial, calendarHref };
    await saveCredentials(credentials);
    render(credentials, [], 'Loading tasks…', calendars);
    await loadTasks(credentials, calendars);
  });
}

function renderCalendarPicker(calendars: CalendarInfo[], selectedHref?: string): string {
  const options = calendars
    .map(
      (calendar) =>
        `<option value="${escapeAttr(calendar.href)}" ${calendar.href === selectedHref ? 'selected' : ''}>${escapeHtml(calendar.displayName)}</option>`,
    )
    .join('');
  return `
    <form id="calendar-form" class="calendar-form">
      <label>
        <span>Task list</span>
        <select name="calendarHref" data-testid="calendar-select">${options}</select>
      </label>
      <button type="submit">Load tasks</button>
    </form>
  `;
}

async function connect(credentials: Credentials) {
  try {
    const calendars = await listTaskCalendars(credentials);
    if (!calendars.length) {
      render(credentials, [], 'No task lists found.');
      return;
    }

    const selectedHref = credentials.calendarHref && calendars.some((c) => c.href === credentials.calendarHref)
      ? credentials.calendarHref
      : calendars[0].href;

    if (credentials.calendarHref === selectedHref) {
      render(credentials, [], 'Loading tasks…', calendars);
      await loadTasks(credentials, calendars);
    } else {
      render(credentials, [], 'Select a task list to load.', calendars);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect';
    render(credentials, [], message);
  }
}

async function loadTasks(credentials: Credentials, calendars: CalendarInfo[]) {
  try {
    const tasks = await fetchTasks(credentials, credentials.calendarHref!);
    render(credentials, tasks, `Connected to ${credentials.username}. Loaded ${tasks.length} tasks.`, calendars);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect';
    render(credentials, [], message, calendars);
  }
}

function renderTask(task: Task): string {
  const classes = task.status === 'COMPLETED' ? 'task completed' : 'task';
  const categories = task.categories.length ? `<span class="categories">${task.categories.map(escapeHtml).join(', ')}</span>` : '';
  return `<li class="${classes}"><span>${escapeHtml(task.summary)}</span>${categories}</li>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}
