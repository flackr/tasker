# tasker — Development Backlog

This document tracks all planned work towards building the complete tasker ecosystem. Items are grouped by milestone. Check off items as they are completed.

---

## Milestone 0 — Project Foundations ✅

- [x] Create `README.md` with project overview and Nextcloud setup instructions
- [x] Create `docs/DESIGN.md` with full architecture and technical design
- [x] Create `docs/TESTING.md` with CI/testing strategy
- [x] Create `docs/BACKLOG.md` (this file)
- [x] Add `LICENSE` file (MIT)
- [x] Set up `.github/workflows/deploy.yml` deployment pipeline (build + GitHub Pages)
- [x] Add `.gitignore` for Node.js, Vite, and Fitbit SDK artifacts

---

## Milestone 1 — PWA Scaffold

- [x] Initialise Vite + TypeScript project under `web/`
- [ ] Configure Vite PWA plugin (`vite-plugin-pwa`) for Service Worker generation
- [x] Set up Vitest for unit and integration tests
- [x] Set up Playwright for E2E tests
- [x] Create `web/src/main.ts` entry point
- [x] Create bare-bones `index.html` with app shell
- [x] Add CSS custom properties design tokens (colours, spacing, typography)
- [x] Implement responsive layout (mobile-first, works on 375px viewport)
- [ ] Add `manifest.webmanifest` for PWA installability
- [ ] Add app icon assets (SVG source + PNG exports at 192×192 and 512×512)
- [x] Configure GitHub Pages deployment in CI

---

## Milestone 2 — Authentication

- [ ] Design and implement Settings screen (Nextcloud URL, username, app password, tasker config JSON path)
- [x] Implement `auth.ts`: Basic Auth header generation
- [x] Store credentials in IndexedDB; persist across sessions (no PIN required on reload)
- [ ] On first launch: read `tasker-config.json` from user-provided WebDAV path to bootstrap preferences
- [x] Show "connected" / "connection failed" status on Settings screen
- [x] Implement logout (clear credentials + cached data)
- [x] Write unit tests for `auth.ts`
- [x] Write E2E test: enter credentials → tasks load

---

## Milestone 3 — CalDAV Client

- [x] Implement `caldav/client.ts`:
  - [x] `propfindCalendars()` — list all calendar collections
  - [ ] `propfindCTag()` — fetch CTag for a single collection
  - [x] `reportTasks()` — fetch all VTODOs from a collection
  - [ ] `putTask()` — create or update a single task
  - [ ] `deleteTask()` — delete a task
- [x] Implement `caldav/parser.ts`:
  - [x] Parse VCALENDAR / VTODO structure
  - [x] Map VTODO fields to internal `Task` model
  - [x] Handle `CATEGORIES` (comma-separated and multi-value forms)
  - [x] Handle `COMPLETED`, `PERCENT-COMPLETE`, `STATUS`
  - [ ] Handle `DTSTART`, `DUE`, `CREATED`, `LAST-MODIFIED` with timezone
- [ ] Implement `caldav/serializer.ts`:
  - [ ] Serialize `Task` → iCalendar string
  - [ ] Generate UUID for new tasks
  - [ ] Set `DTSTAMP` and `LAST-MODIFIED` to current time
- [ ] Write unit tests for `parser.ts` (≥ 95% coverage)
- [ ] Write unit tests for `serializer.ts` (≥ 95% coverage)
- [x] Write unit tests for `client.ts` with MSW mocks

---

## Milestone 4 — IndexedDB Layer

- [ ] Implement `db/index.ts`: open `tasker-db`, define schema and upgrades
- [ ] Implement `db/tasks.ts`:
  - [ ] `getTask(uid)`, `getAllTasks(calendarId)`, `putTask(task)`, `deleteTask(uid)`
  - [ ] Query tasks by `status` and `categories`
- [ ] Implement `db/calendars.ts`: store and retrieve calendar metadata + CTag
- [ ] Implement `db/sync-queue.ts`:
  - [ ] `enqueue(operation)` — add a pending create/update/delete
  - [ ] `dequeue()` — get all pending operations
  - [ ] `acknowledge(id)` — remove operation after successful sync
- [ ] Write unit tests for all DB modules (fake IndexedDB via `fake-indexeddb`)

---

## Milestone 5 — Sync Engine

- [ ] Implement `sync/sync-engine.ts`:
  - [ ] `fullSync(calendarId)` — PROPFIND → compare CTag → REPORT → diff → persist
  - [ ] `flushQueue()` — replay all queued operations against CalDAV
  - [ ] `scheduleSync()` — run full sync on tab focus and every 5 minutes
- [ ] Implement `sync/conflict.ts`:
  - [ ] Last-write-wins based on `LAST-MODIFIED`
  - [ ] `If-Match` ETag handling for PUT requests
  - [ ] 412 conflict detection and user-facing conflict UI
- [ ] Write integration tests for sync engine with MSW mocks
- [ ] Write unit tests for `conflict.ts` (100% coverage)

---

## Milestone 6 — Service Worker & Offline

- [ ] Implement `sw/service-worker.ts`:
  - [ ] Pre-cache Vite build assets on `install`
  - [ ] Network-first strategy for CalDAV requests
  - [ ] Cache-first strategy for static assets
  - [ ] Handle `sync` event with tag `caldav-flush`
- [ ] Register Service Worker from `main.ts`
- [ ] Register `caldav-flush` Background Sync tag when a change is queued offline
- [ ] Test offline task creation → verify sync when back online (E2E)
- [ ] Add "offline" banner to UI when `navigator.onLine` is false

---

## Milestone 7 — Task List UI

- [ ] Implement `ui/list-view.ts`:
  - [ ] Fetch tasks from IndexedDB and render grouped by aisle/category
  - [ ] Sort aisles by user-defined order
  - [x] Render completed tasks with strikethrough; allow toggling completion
  - [ ] Pull-to-refresh gesture triggers a manual sync
- [ ] Implement `ui/task-editor.ts`:
  - [ ] Add task form (summary, category/aisle, notes, priority)
  - [ ] Edit task form (pre-populated with existing values)
  - [ ] Delete task with confirmation prompt
- [ ] Implement `ui/aisle-manager.ts`:
  - [ ] List aisles in sort order
  - [ ] Add, rename, reorder (drag-and-drop), and delete aisles
- [ ] Write E2E tests for task CRUD flows
- [ ] Write E2E visual snapshot tests for list and editor views

---

## Milestone 8 — Recipe / Meal Planning

- [ ] Document Markdown recipe format in `docs/DESIGN.md` § Recipe
- [ ] Implement WebDAV client for recipe files (`webdav/client.ts`) — **read-only**:
  - [ ] `listRecipes()` — PROPFIND configured recipes folder path
  - [ ] `getRecipe(slug)` — GET recipe Markdown file
- [ ] Implement Markdown ingredient parser (parse `## Ingredients` section → items + aisle tags)
- [ ] Implement recipe list UI (read-only; links to Nextcloud for editing)
- [ ] Implement "Add to grocery list" action: convert recipe ingredients to VTODOs
- [ ] Implement meal planner calendar view (weekly grid)
- [ ] Store meal plan entries as WebDAV JSON files
- [ ] Write unit tests for WebDAV client
- [ ] Write E2E tests for recipe → grocery list flow

---

## Milestone 9 — Fitbit Scaffold

- [ ] Initialise Fitbit SDK project under `fitbit/`
- [ ] Configure Fitbit CLI (`npx fitbit`) and build pipeline
- [ ] Create Watch App entry point (`fitbit/app/index.js`)
- [ ] Create Companion App entry point (`fitbit/companion/index.js`)
- [ ] Set up Jest for Fitbit unit tests
- [ ] Define message protocol types (see `docs/DESIGN.md` § Bluetooth Communication Protocol)

---

## Milestone 10 — Fitbit Watch App

- [ ] Design Watch UI (SVG-based list view, item detail view)
- [ ] Implement task list screen: render items sorted by aisle
- [ ] Implement item detail screen: show summary, categories, notes
- [ ] Implement toggle-complete action (tap item → send `UPDATE_TASK` message)
- [ ] Implement `watch/cache.js`: read/write task list from Fitbit File Storage API
- [ ] Show sync status indicator (spinner while waiting, error badge on failure)
- [ ] Handle `TASKS_PAYLOAD` message: merge with cache, re-render
- [ ] Handle `UPDATE_ACK` message: update cache, dismiss spinner
- [ ] Handle `ERROR` message: show error banner, revert optimistic update
- [ ] Write unit tests for `watch/cache.js`
- [ ] Write protocol unit tests

---

## Milestone 11 — Fitbit Companion App

- [ ] Implement Companion CalDAV client (`companion/caldav-client.js`):
  - [ ] Reuse / port iCalendar parser from PWA
  - [ ] `fetchTasks(calendarId)` → PROPFIND + REPORT
  - [ ] `updateTask(uid, completed, etag)` → PUT
- [ ] Handle `FETCH_TASKS` message from watch: fetch + send `TASKS_PAYLOAD`
- [ ] Handle `UPDATE_TASK` message from watch: PUT + send `UPDATE_ACK` or `ERROR`
- [ ] Store Nextcloud credentials securely in Companion settings storage
- [ ] Implement Companion settings page (Nextcloud URL, username, app password)
- [ ] Write unit tests for Companion CalDAV client
- [ ] Write message protocol round-trip tests

---

## Milestone 12 — Polish & Release

- [ ] Add accessibility: ARIA labels, keyboard navigation, sufficient colour contrast
- [ ] Add i18n foundation (English only initially; structure for future translations)
- [ ] Implement dark mode (CSS prefers-color-scheme)
- [ ] Audit and tighten Content-Security-Policy headers
- [ ] Performance audit: Lighthouse ≥ 90 on all categories
- [ ] Write `CONTRIBUTING.md`
- [ ] Tag `v0.1.0` release
- [ ] Publish Fitbit app to Fitbit Gallery (if Fitbit SDK policies permit)
- [ ] Announce on Nextcloud forums / community channels

---

## Future / Icebox

- [ ] Multi-calendar support (separate lists per store or meal type)
- [ ] Barcode scanning (camera API) to add grocery items by UPC
- [ ] Shared lists (CalDAV sharing / delegation)
- [ ] iOS Shortcuts integration for quick-add from Siri
- [ ] Android widget showing current grocery list
- [ ] Nextcloud Talk integration for shared shopping notifications
- [ ] Support for other CalDAV providers (iCloud, Google Tasks via bridge, etc.)
