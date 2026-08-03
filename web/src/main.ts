import './style.css';
import { clearCredentials, loadCredentials, saveCredentials } from './auth';
import { fetchTasks } from './caldav/client';
import type { Credentials, Task } from './types';

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

function render(initial?: Credentials, tasks: Task[] = [], status = 'Enter your Nextcloud credentials to load tasks.') {
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
    const credentials = {
      baseUrl: String(formData.get('baseUrl') ?? ''),
      username: String(formData.get('username') ?? ''),
      appPassword: String(formData.get('appPassword') ?? ''),
    };
    await saveCredentials(credentials);
    render(credentials, tasks, 'Connecting…');
    await connect(credentials);
  });

  document.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', async () => {
    await clearCredentials();
    render(undefined, [], 'Credentials cleared.');
  });
}

async function connect(credentials: Credentials) {
  try {
    const tasks = await fetchTasks(credentials);
    render(credentials, tasks, `Connected to ${credentials.username}. Loaded ${tasks.length} tasks.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect';
    render(credentials, [], message);
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
