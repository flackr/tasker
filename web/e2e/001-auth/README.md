# Test: Authentication

As a user, I want to connect to my Nextcloud server, choose a VTODO task list, and load my tasks.

## User sees the connection form

![User sees the connection form](./screenshots/000-initial-load.png)

**Verifications:**
- [x] Nextcloud URL field visible
- [x] Connect button visible

---

## Only the VTODO-capable task list is offered

![Only the VTODO-capable task list is offered](./screenshots/001-calendar-selection.png)

**Verifications:**
- [x] Connection status shows Connected
- [x] Shopping task list option present
- [x] Personal (VEVENT-only) calendar is filtered out

---

## Tasks load in the category-grouped task list after selecting a task list

![Tasks load in the category-grouped task list after selecting a task list](./screenshots/002-tasks-loaded.png)

**Verifications:**
- [x] Status shows loaded task count
- [x] Task list shows the fetched task under its category

---

