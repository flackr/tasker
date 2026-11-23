# AGENTS.md

Guidance for AI agents and contributors working on **tasker**.

## Project Overview

**tasker** is a local-first, Bring-Your-Own-Backend (BYOB) task and grocery list management system backed by Nextcloud (or any standards-compliant CalDAV/WebDAV server). Tasks are stored as standard iCalendar `VTODO` objects over CalDAV; configuration and read-only Markdown recipes live on WebDAV.

There are two primary client applications, built around shared core infrastructure in a root npm workspace:

1. **PWA Web App (`web/`)** — Offline-first Progressive Web App for quickly managing grocery lists (sorted by store aisle), adding/editing tasks, and importing recipe ingredients.
2. **Fitbit Versa 2 App (`fitbit/`)** — Fitbit OS 4 (`@fitbit/sdk ~4.3.0`, target `mira`) watch app + smartphone companion app that syncs task lists to the wrist so items can be checked off while shopping and synced back to CalDAV.

## Documentation & Tracking Workflow

Always consult and keep these three living documents up to date as part of your work:

- [docs/BACKLOG.md](docs/BACKLOG.md) — **Task & milestone tracker.** Check off tasks as they are completed, and add newly discovered tasks or sub-tasks before implementing them.
- [docs/DESIGN.md](docs/DESIGN.md) — **Architecture & technical design.** Record workspace layout, shared data models, CalDAV/WebDAV contracts, sync protocols, and architectural decisions here.
- [docs/TESTING.md](docs/TESTING.md) — **Testing strategy & CI.** Document test layers, mock server capabilities, rendered Playwright harnesses (both PWA and Fitbit), visual regression policies, and coverage requirements here.
- [README.md](README.md) — User-facing overview, Nextcloud setup, and local development instructions.

## Repository Conventions

- **Code search:** Always use `git grep` when searching for code in this repository (pass `--untracked` only if inspecting untracked files).
- **Minimal dependencies:** Prefer plain TypeScript, HTML, and CSS over heavyweight frameworks. Keep shared modules dependency-free so they work across browser, Node, and Fitbit runtimes.
- **Fitbit Versa 2 compatibility (HARD REQUIREMENT):** The target hardware is a **Fitbit Versa 2** (`buildTargets: ["mira"]`), which requires `@fitbit/sdk ~4.3.0` (`@fitbit/sdk-cli ^1.7.3`) and preserves `appUUID: "99c33526-f098-4b3b-a932-168e244bee40"`. Do **not** upgrade `@fitbit/sdk` to v5+ or v6+ (those drop Versa 2 support).

## Repository Layout

```text
tasker/
├── package.json              # Root npm workspaces + unified build/test scripts
├── packages/
│   ├── core/                 # @tasker/core — shared domain, VTODO, CalDAV, sync, aisle sorting
│   │   ├── src/watch/        # @tasker/core/watch — ES5-compiled, JerryScript-safe watch subset
│   │   └── src/              # @tasker/core — ES2015-compiled core for PWA & Fitbit Companion
│   └── mock-caldav/          # @tasker/mock-caldav — stateful mock CalDAV/WebDAV server for tests
├── web/                      # @tasker/web — Offline-first PWA (Vite, TypeScript, IndexedDB, Playwright)
├── fitbit/                   # @tasker/fitbit — Versa 2 Watch App, Companion App, Settings (@fitbit/sdk ~4.3.0)
├── docs/                     # DESIGN.md, TESTING.md, BACKLOG.md
└── .github/workflows/        # CI (ci.yml) and GitHub Pages deployment (deploy.yml)
```

## Architecture & Code Sharing Principles

Design shared code with strict runtime boundaries so both clients reuse the same domain and sync logic without pulling incompatible APIs into constrained environments:

1. **Watch-Safe Core (`@tasker/core/watch`)**
   - Compiled to **ES5** (`tsconfig.watch.json`, `lib: ["ES5"]`) with zero external dependencies so Fitbit OS 4 (JerryScript) on Versa 2 can bundle and run it with minimal memory overhead.
   - Contains compact task payloads, Watch↔Companion message protocol types/constants, aisle/category sorting, and watch-side state merge helpers.
   - Must **never** import `fetch`, DOM APIs, Node built-ins, or ES2015+ runtime features.

2. **Full Shared Core (`@tasker/core`)**
   - Compiled to **ES2015** ESM (`tsconfig.json`, no DOM/Node-only globals) so it runs cleanly in the PWA (Vite), Fitbit Companion (`@fitbit/sdk` Rollup + Terser ES6), and Node/Vitest tests.
   - Contains canonical `Task`, `CalendarInfo`, `Credentials`, `AisleConfig`, `TaskerConfig`, lossless `VTODO` parser/serializer (preserving unknown properties on `PUT`), CalDAV/WebDAV client with injectable `fetch` and runtime-agnostic XML parsing, and storage-agnostic `TaskStore` / `SyncQueue` / `SyncEngine` interfaces + conflict resolution.

3. **Platform Adapters**
   - **PWA (`web/`):** IndexedDB storage adapter, Service Worker caching & Background Sync (`caldav-flush`), responsive mobile-first web UI.
   - **Fitbit Companion (`fitbit/companion/`):** Uses `@tasker/core` for CalDAV/WebDAV and sync, Fitbit `settingsStorage` for credentials, and `fitbit-asap` / file-transfer bridge to the watch.
   - **Fitbit Watch (`fitbit/app/`):** Uses `@tasker/core/watch`, Fitbit SVG widgets (`resources/`), and Fitbit File Storage (`fs`) for offline cache + pending toggles.

4. **Security & Privacy**
   - Strictly BYOB: clients communicate only with the user's configured Nextcloud/CalDAV server (no analytics, telemetry, or third-party relay servers).
   - Authenticate with HTTP Basic Auth using Nextcloud App Passwords.
   - Never commit real Nextcloud URLs, usernames, or app passwords to the repository.

## Testing & Verification Standards

All unit, integration, and rendered UI tests must run **without real devices or an external Nextcloud instance**.

- **Shared Mock CalDAV/WebDAV backend (`@tasker/mock-caldav`):** Stateful mock server implementing `PROPFIND`, `REPORT`, `PUT`, `DELETE`, `GET`, `ETag`/`CTag`, `If-Match` (`412`), WebDAV files, and CORS headers. Reused across `packages/core`, `web/`, and `fitbit/` tests.
- **Unit & integration tests:** Run with Vitest across `@tasker/core`, `@tasker/mock-caldav`, `@tasker/web`, and `@tasker/fitbit` logic.
- **Rendered & E2E tests:**
  - **PWA (`web/e2e/`):** Playwright in numbered scenario directories (e.g. `001-auth/`) using `TestStepHelper` with zero-pixel tolerance (`maxDiffPixels: 0`) and auto-generated scenario `README.md`s.
  - **Fitbit (`fitbit/e2e/`):** Playwright harness at Versa 2's `300×300` viewport shimming Fitbit's SVG widgets, `document`, `fs`, and messaging bridge wired directly to the real Companion code and `@tasker/mock-caldav`, using the same deterministic screenshot verification.
- **Visual baselines:** Never relax `maxDiffPixels: 0` to hide regressions. Only update baselines (`--update-snapshots`) for intentional UI changes, and review the diffs before committing.

## Commands

Run from the repository root:

```bash
npm install              # Install all workspace dependencies
npm test                 # Build core packages and run all unit & integration tests
npm run test:e2e         # Run Playwright E2E + visual regression tests
npm run build            # Build @tasker/core, @tasker/mock-caldav, web PWA, and fitbit .fba
npm run build:web        # Build core + web PWA
npm run build:fitbit     # Build core + Fitbit Versa 2 .fba bundle
npm run dev              # Build core and start the PWA Vite dev server
```

To update intentional Playwright screenshot baselines:

```bash
npm -w @tasker/web run test:e2e -- --update-snapshots
```
