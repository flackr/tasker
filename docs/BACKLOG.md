# tasker — Development Backlog

This document tracks all planned work towards building the complete tasker ecosystem. Items are grouped by milestone. Check off items as they are completed, and keep [DESIGN.md](DESIGN.md) and [TESTING.md](TESTING.md) aligned with architectural or test changes.

---

## Milestone 0 — Project Foundations ✅

- [x] Create `README.md` with project overview and Nextcloud setup instructions
- [x] Create `docs/DESIGN.md` with full architecture and technical design
- [x] Create `docs/TESTING.md` with CI/testing strategy
- [x] Create `docs/BACKLOG.md` (this file)
- [x] Create `AGENTS.md` with repository guidelines, Versa 2 constraints, and doc workflow
- [x] Add `LICENSE` file (MIT)
- [x] Set up `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`
- [x] Add `.gitignore` for Node.js, Vite, workspace builds, and Fitbit SDK artifacts

---

## Milestone 1 — Root Workspace & Shared Infrastructure

- [x] Verify `@fitbit/sdk ~4.3.0` (`mira` / Fitbit Versa 2 target) builds cleanly on the local Node toolchain
- [x] Create root `package.json` with npm workspaces (`packages/*`, `web`, `fitbit`) and unified build/test scripts
- [x] Scaffold `packages/core` (`@tasker/core`) with dual build targets:
  - [x] `@tasker/core/watch` compiled to ES5 (`lib: ["ES5"]`) for Fitbit Versa 2 (JerryScript)
  - [x] `@tasker/core` compiled to ES2015 ESM (no DOM/Node-only globals) for PWA and Fitbit Companion
- [x] Scaffold `packages/mock-caldav` (`@tasker/mock-caldav`) shared test backend package
- [x] Migrate Fitbit Versa 2 prototype into `fitbit/` (`@tasker/fitbit`), preserving `appUUID` (`99c33526-f098-4b3b-a932-168e244bee40`), `buildTargets: ["mira"]`, and `@fitbit/sdk ~4.3.0`
- [x] Verify `fitbit-build` bundles imports from both `@tasker/core/watch` (Watch App) and `@tasker/core` (Companion App) into `fitbit/build/app.fba`
- [x] Wire `web/` (`@tasker/web`) to consume shared types from `@tasker/core`
- [x] Update `.github/workflows/ci.yml` and `.github/workflows/deploy.yml` to build and test from the root workspace (including Fitbit `.fba` build verification)
- [x] Remove legacy untracked `app/` folder once `fitbit/` migration is verified and approved

---

## Milestone 2 — Shared Core (`@tasker/core`)

### Domain & Watch-Safe Module (`@tasker/core/watch`)
- [x] Define compact task (`CompactTask`) and Watch↔Companion message protocol types
- [x] Implement aisle/category sorting (`sortTasksByAisle`) with Vitest unit tests
- [x] Implement watch-side local state merge & optimistic toggle queue helpers (`mergeWatchTasks`, pending toggle reconciliation)
- [x] Implement message chunking/reassembly helpers for large task lists over Fitbit messaging / file transfer
- [x] Achieve ≥ 95% Vitest coverage on `@tasker/core/watch`

### iCalendar (`VTODO`) Parser & Serializer
- [x] Define canonical `Task`, `CalendarInfo`, `Credentials`, `AisleConfig`, and `TaskerConfig` models
- [x] Implement lossless `VTODO` parser (`parseVTodo`):
  - [x] Parse `UID`, `SUMMARY`, `DESCRIPTION`, `STATUS`, `PERCENT-COMPLETE`, `PRIORITY`, `CATEGORIES`, `CREATED`, `LAST-MODIFIED`, `COMPLETED`, `DTSTART`, `DUE`
  - [x] Handle RFC 5545 folded lines (`CRLF + space/tab`), escaped characters, and multi-line/comma-separated `CATEGORIES`
  - [x] Preserve raw/unknown `VTODO` properties so updates never clobber metadata from Nextcloud Tasks or other CalDAV clients
- [x] Implement lossless `VTODO` serializer (`serializeVTodo` / `patchVTodo`):
  - [x] Create new `VCALENDAR`/`VTODO` objects with generated UUID, `DTSTAMP`, `CREATED`, `LAST-MODIFIED`
  - [x] Patch existing raw `VTODO` strings in-place while preserving unknown properties
- [x] Write unit tests for parser & serializer (≥ 95% coverage, round-trip deep-equal tests)

### Runtime-Agnostic CalDAV & WebDAV Client
- [x] Implement lightweight, dependency-free XML helper (namespace-aware, works in Browser, Fitbit Companion, and Node without browser `DOMParser`)
- [x] Implement `CalDavClient` (injectable `fetch`):
  - [x] `listTaskCalendars()` — `PROPFIND` filtering by `supported-calendar-component-set` (`VTODO`)
  - [x] `getCalendarCTag()` — `PROPFIND` (`Depth: 0`) for `{getctag}`
  - [x] `fetchTasks()` — `REPORT` (`calendar-query`) returning tasks with `href` and `etag`
  - [x] `putTask()` — `PUT` with `If-Match` header (detects `412 Precondition Failed`)
  - [x] `deleteTask()` — `DELETE` with optional `If-Match`
- [x] Implement `WebDavClient` (injectable `fetch`) for reading `tasker-config.json` and read-only Markdown recipe files
- [x] Write integration tests against `@tasker/mock-caldav`

### Storage-Agnostic Local Store & Sync Engine
- [x] Define `TaskStore`, `CalendarMetadataStore`, and `SyncQueueStore` interfaces (plus an `InMemoryStore` for tests)
- [x] Implement `SyncEngine`:
  - [x] Optimistic local create/update/toggle/delete + FIFO `SyncQueue`
  - [x] `fullSync(calendarHref)` — CTag check → `REPORT` → ETag diff → local upsert/prune → persist CTag
  - [x] `flushQueue()` — replay queued `PUT`/`DELETE` operations with `If-Match`
- [x] Implement conflict resolution (`resolveConflict`):
  - [x] `412` detection, fresh server fetch, `LAST-MODIFIED` comparison, auto last-write-wins or user-resolvable conflict record
- [x] Write unit tests for conflict logic (100% coverage) and integration tests for `SyncEngine` (≥ 80% coverage)

---

## Milestone 3 — Shared Mock CalDAV / WebDAV Server (`@tasker/mock-caldav`)

- [x] Scaffold `@tasker/mock-caldav` package with basic `PROPFIND`/`REPORT` and CORS support
- [x] Implement full stateful in-memory CalDAV store:
  - [x] Multiple calendars (mix of `VTODO` and `VEVENT`-only) with dynamic `CTag` bumping on writes
  - [x] `REPORT` (`calendar-query`) returning `href`, `getetag`, and `calendar-data`
  - [x] `PUT` creating/updating tasks, enforcing `If-Match` (returning `412 Precondition Failed` on stale ETag), and returning updated `ETag`
  - [x] `DELETE` removing tasks and bumping `CTag`
  - [x] Auth verification (HTTP Basic Auth, configurable `401` failure mode)
  - [x] Fault injection helpers (offline/500/412 simulation for conflict & error-handling tests)
- [x] Implement WebDAV file endpoints (`GET`/`PROPFIND`) for `tasker-config.json` and Markdown recipe fixtures
- [x] Export both an HTTP server helper (for Playwright E2E) and an in-process `fetch` handler (for fast Vitest integration tests)
- [x] Write self-tests for `@tasker/mock-caldav`

---

## Milestone 4 — PWA Web App (`web/`)

### Foundation & Auth
- [x] Vite + TypeScript + Vitest + Playwright (`TestStepHelper`) scaffold under `web/`
- [x] Basic Auth header generation and IndexedDB credential persistence (`auth.ts`)
- [x] Initial E2E authentication scenario (`web/e2e/001-auth/`) with zero-pixel screenshots
- [x] Configure PWA installability: `manifest.webmanifest`, app icons (SVG + 192×192 / 512×512 PNG), and custom Service Worker (`public/sw.js`)
- [x] Implement Settings screen (Nextcloud URL, username, app password, `tasker-config.json` WebDAV path, connection status, logout clearing cached data)
- [x] Bootstrap preferences (aisle order, default calendar, recipes path) from `tasker-config.json` on first launch

### Offline Storage, Sync & Service Worker
- [x] Implement IndexedDB adapter (`web/src/db/`) conforming to `@tasker/core` `TaskStore`, `CalendarMetadataStore`, and `SyncQueueStore` (`tasker-db`)
- [x] Wire `SyncEngine` from `@tasker/core` into the PWA (tab-focus sync, online-reconnect sync, manual refresh)
- [x] Implement Service Worker (`public/sw.js` + `src/sw-register.ts`): asset pre-caching, network-first CalDAV, `sync` event (`caldav-flush`)
- [x] Display offline indicator & sync status badge; register `caldav-flush` when mutations are queued offline
- [x] Add conflict resolution UI when `412` occurs

### Grocery List & Task Management UI
- [x] Implement aisle-grouped grocery list view (`ui/list-view.ts`) using `@tasker/core/watch` `sortTasksByAisle`
- [x] Quick-add bar and one-tap completion toggle (optimistic local update + sync)
- [x] Implement task editor (`ui/task-editor.ts`): add/edit summary, aisle/categories, notes, priority, and delete with confirmation
- [x] Implement aisle manager (`ui/aisle-manager.ts`): add, rename, reorder, delete aisles (persisted locally and synced to `tasker-config.json`)
- [x] Write Playwright E2E + zero-pixel visual regression scenarios:
  - [x] Task CRUD & aisle-sorted grocery list (`web/e2e/002-grocery-crud/`)
  - [x] Offline edits → reconnect → automatic sync & conflict (`412`) resolution flow (`web/e2e/003-offline-and-conflicts/`)

---

## Milestone 5 — Fitbit Versa 2 App (`fitbit/`)

### Watch & Companion Integration with `@tasker/core`
- [x] Implement Companion CalDAV sync (`fitbit/companion/sync.js`) using `@tasker/core` (`CalDavClient`, `WebDavClient`, lossless `VTODO` patching, `ETag`/`If-Match` with `412` retry, calendar selection from settings/config)
- [x] Update Companion Settings page (`fitbit/settings/index.jsx`) to configure Nextcloud URL, username, app password, and optional task list / config path
- [x] Replace ad-hoc messaging with shared chunked protocol from `@tasker/core/watch` (`FETCH_LISTS`/`LISTS_PAYLOAD`, `TASKS_PAYLOAD`/`TASKS_CHUNK`, `UPDATE_TASK`, `UPDATE_ACK`, `ERROR`)
- [x] Implement Watch App (`fitbit/app/watch-app.js` + `fitbit/app/index.js`) using `@tasker/core/watch`:
  - [x] Support selecting between available VTODO lists and navigating back to switch lists (header Back button + Versa 2 hardware back key)
  - [x] Render grocery tasks sorted by aisle with aisle labels on Versa 2 (`300×300` screen)
  - [x] Persist list catalog (`tasker-lists.json`) and per-list contents + pending local toggles (`tasker-list-<id>.json`) via Fitbit File Storage (`fs`) so restarts immediately render the cached list while syncing in the background
  - [x] Timestamp-aware watch reconciliation (`reconcileWatchTasks`): prefer newer/equal server edits over older unsynced watch toggles, while syncing strictly newer unsynced watch toggles back to CalDAV
  - [x] Syncing / offline / pending / error status indicator and manual Sync button

### Fitbit Unit, Protocol & Rendered E2E Testing (No Device Required)
- [x] Write Vitest unit & integration tests (`fitbit/test/fitbit-sync.test.ts`) for Companion sync handler and Watch state/cache/protocol logic against `@tasker/mock-caldav`
- [x] Build browser/Playwright Fitbit Versa 2 rendered test harness (`fitbit/e2e/harness/`):
  - [x] Renders `fitbit/resources/index.gui` in a deterministic `300×300` Versa 2 viewport
  - [x] Shims Fitbit `document`, `#tile-list` / `#checkbox-tile` widgets, `fs` File Storage, and messaging bridge
  - [x] Wires the shimmed bridge directly to the real Companion code talking to `@tasker/mock-caldav`
- [x] Write Playwright E2E + zero-pixel visual regression scenario (`fitbit/e2e/001-watch-sync/`) using `TestStepHelper`:
  - [x] Initial sync & aisle-sorted watch list render
  - [x] Tapping items on watch → verifying lossless `PUT` persistence in `@tasker/mock-caldav`
  - [x] Offline check-offs surviving watch restart via `fs` cache → reconnect → sync reconciliation

---

## Milestone 6 — Recipe & Meal Planning (PWA)

- [ ] Implement Markdown ingredient parser in `@tasker/core` (`## Ingredients` section → items + parenthesised aisle tags)
- [ ] Implement read-only recipe list & detail view in PWA (fetched via `@tasker/core` `WebDavClient`, link to Nextcloud for editing)
- [ ] Implement "Add ingredients to grocery list" action converting parsed ingredients into `VTODO` tasks
- [ ] Implement weekly meal planner view (stored as WebDAV JSON)
- [ ] Write unit tests for Markdown recipe parser and Playwright E2E tests for recipe → grocery list flow

---

## Milestone 7 — Polish & Release

- [ ] Accessibility audit: ARIA labels, keyboard navigation, colour contrast
- [ ] Dark mode support (`prefers-color-scheme`)
- [ ] Audit and tighten Content-Security-Policy headers in PWA
- [ ] Lighthouse audit (≥ 90 across categories)
- [ ] Write `CONTRIBUTING.md` and tag `v0.1.0` release
- [ ] Sideload & verify `.fba` bundle on physical Fitbit Versa 2

---

## Future / Icebox

- [ ] Multi-calendar support (separate lists per store or meal type)
- [ ] Barcode scanning (camera API) to add grocery items by UPC
- [ ] Shared lists (CalDAV sharing / delegation)
- [ ] iOS Shortcuts integration for quick-add from Siri
- [ ] Android widget showing current grocery list
- [ ] Support for additional CalDAV providers beyond Nextcloud
