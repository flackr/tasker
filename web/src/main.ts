import './style.css';
import { clearCredentials, loadCredentials, saveCredentials } from './auth';
import { fetchTasks } from './caldav/client';
import type { Credentials, Task } from './types';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

const statusEl = document.querySelector<HTMLParagraphElement>('[data-testid="status"]');
const form = document.querySelector<HTMLFormElement>('#auth-form');
const baseUrlInput = form?.querySelector<HTMLInputElement>('input[name="baseUrl"]');
const usernameInput = form?.querySelector<HTMLInputElement>('input[name="username"]');
const appPasswordInput = form?.querySelector<HTMLInputElement>('input[name="appPassword"]');
const logoutButton = document.querySelector<HTMLButtonElement>('#logout');
const taskList = document.querySelector<HTMLUListElement>('[data-testid="task-list"]');
const taskTemplate = document.querySelector<HTMLTemplateElement>('#task-template');

void bootstrap();

async function bootstrap() {
  const saved = await loadCredentials();
  render(saved);
  if (saved) {
    void connect(saved);
  }
}

function render(credentials?: Credentials, tasks: Task[] = [], status = 'Enter your Nextcloud credentials to load tasks.') {
  if (statusEl) statusEl.textContent = status;
  if (baseUrlInput) baseUrlInput.value = credentials?.baseUrl ?? '';
  if (usernameInput) usernameInput.value = credentials?.username ?? '';
  if (appPasswordInput) appPasswordInput.value = credentials?.appPassword ?? '';
  renderTasks(tasks);
}

function renderTasks(tasks: Task[]) {
  if (!taskList) return;
  taskList.innerHTML = '';
  if (!tasks.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No tasks loaded.';
    taskList.append(empty);
    return;
  }
  for (const task of tasks) {
    taskList.append(renderTask(task));
  }
}

function renderTask(task: Task): HTMLElement {
  if (!taskTemplate) throw new Error('Task template not found');
  const fragment = taskTemplate.content.cloneNode(true) as DocumentFragment;
  const item = fragment.querySelector<HTMLLIElement>('.task');
  if (!item) throw new Error('Task template missing .task element');
  if (task.status === 'COMPLETED') item.classList.add('completed');
  const summary = item.querySelector<HTMLSpanElement>('.task-summary');
  if (summary) summary.textContent = task.summary;
  const categories = item.querySelector<HTMLSpanElement>('.categories');
  if (categories) categories.textContent = task.categories.join(', ');
  return item;
}

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);
  const credentials = {
    baseUrl: String(formData.get('baseUrl') ?? ''),
    username: String(formData.get('username') ?? ''),
    appPassword: String(formData.get('appPassword') ?? ''),
  };
  await saveCredentials(credentials);
  render(credentials, [], 'Connecting…');
  await connect(credentials);
});

logoutButton?.addEventListener('click', async () => {
  await clearCredentials();
  render(undefined, [], 'Credentials cleared.');
});

async function connect(credentials: Credentials) {
  try {
    const tasks = await fetchTasks(credentials);
    render(credentials, tasks, `Connected to ${credentials.username}. Loaded ${tasks.length} tasks.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to connect';
    render(credentials, [], message);
  }
}
