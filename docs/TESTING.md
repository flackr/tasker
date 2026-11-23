# tasker — Testing Strategy

## Table of Contents

1. [Overview](#overview)
2. [Shared Mock CalDAV / WebDAV Server](#shared-mock-caldav--webdav-server)
3. [Unit & Integration Tests (Vitest)](#unit--integration-tests-vitest)
4. [PWA Rendered & E2E Tests (Playwright)](#pwa-rendered--e2e-tests-playwright)
5. [Fitbit Versa 2 Rendered & E2E Tests (Playwright)](#fitbit-versa-2-rendered--e2e-tests-playwright)
6. [Visual / Screenshot Regression Policy](#visual--screenshot-regression-policy)
7. [CI Pipeline (GitHub Actions)](#ci-pipeline-github-actions)
8. [Test Coverage Requirements](#test-coverage-requirements)

---

## Overview

All unit, integration, and rendered UI tests must run **without real devices or an external Nextcloud instance**. tasker follows a **test pyramid** unified under Vitest (unit/integration) and Playwright (rendered E2E + visual regression) across all workspace packages:

```text
          ╱ E2E & Visual ╲       ← Playwright (PWA + Fitbit Versa 2 harness)
         ╱────────────────╲
        ╱   Integration    ╲     ← Vitest + @tasker/mock-caldav
       ╱────────────────────╲
      ╱     Unit Tests       ╲   ← Vitest (pure core, watch, DB, protocol)
     ╱────────────────────────╲
```

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest | `@tasker/core` & `@tasker/core/watch` (parsers, serializers, category sorting, conflict logic, watch merge/protocol), PWA DB/auth/AI categorizer helpers |
| Integration | Vitest + `@tasker/mock-caldav` | `CalDavClient`, `WebDavClient`, `SyncEngine`, Fitbit Companion sync handler, offline queue replay & `412` conflict flows |
| Rendered / E2E (PWA) | Playwright + `TestStepHelper` | Real Chromium against Vite dev server + `@tasker/mock-caldav` |
| Rendered / E2E (Fitbit) | Playwright + `TestStepHelper` + Versa 2 harness | Real Chromium (`300×300`) running Fitbit Watch SVG/JS + shimmed widgets/`fs`/messaging wired to real Companion + `@tasker/mock-caldav` |

---

## Shared Mock CalDAV / WebDAV Server

Located in `packages/mock-caldav/` (`@tasker/mock-caldav`).

A single stateful mock backend is shared by Vitest integration tests, PWA Playwright E2E tests, and Fitbit Playwright E2E tests. It provides both:
1. An **in-process `fetch` handler** for zero-port Vitest integration tests.
2. A **local Node `http.Server`** for browser-based Playwright E2E tests.

Capabilities:
- `PROPFIND` (calendar discovery with `supported-calendar-component-set`, `VTODO` vs `VEVENT` filtering, and `{getctag}`).
- `REPORT` (`calendar-query` returning `href`, `getetag`, and `calendar-data`).
- `PUT` creating/updating VTODO items, enforcing `If-Match` (returning `412 Precondition Failed` on ETag mismatch), returning new `ETag`, and bumping collection `CTag`.
- `DELETE` removing VTODO items and bumping `CTag`.
- WebDAV `GET` / `PROPFIND` for `tasker-config.json` and read-only Markdown recipe fixtures.
- Full CORS preflight (`OPTIONS`) and exposed `ETag`/`DAV` headers.
- Fault injection hooks (`401`, `412`, `500`, offline simulation).

---

## Unit & Integration Tests (Vitest)

All packages run unit and integration tests via Vitest from the repository root:

```bash
npm test                                    # Build core + run all workspace Vitest suites
npm -w @tasker/core run test                # Core & watch-safe unit/integration tests
npm -w @tasker/mock-caldav run test         # Mock CalDAV server self-tests
npm -w @tasker/web run test                 # PWA unit & integration tests
```

Key test targets:
- `packages/core/src/watch/`: `sortTasksByCategory`, watch cache merge & timestamp reconciliation, pending offline toggles, message protocol & chunking.
- `packages/core/src/caldav/`: lossless `VTODO` parser/serializer (including unknown property preservation & RFC 5545 folding), XML parser, `CalDavClient`, `WebDavClient`.
- `packages/core/src/sync/`: `SyncEngine` full/incremental CTag sync, FIFO `SyncQueue` replay, `If-Match` / `412` conflict resolution.
- `web/src/`: `auth.ts`, IndexedDB store adapter (`fake-indexeddb`), UI logic.
- `fitbit/`: Companion CalDAV sync handler, Watch↔Companion protocol round-trips.

---

## PWA Rendered & E2E Tests (Playwright)

Located in `web/e2e/`. Scenarios live in numbered directories driven by `TestStepHelper`, with committed baseline screenshots and zero-pixel-tolerance visual regression:

```text
web/e2e/
├── helpers/
│   └── test-step-helper.ts   # Shared TestStepHelper utility
├── 001-auth/
│   ├── 001-auth.spec.ts      # Scenario test file
│   ├── README.md             # Auto-generated verification doc
│   └── screenshots/          # Committed baseline images
```

Each step via `tester.step(id, options)`:
1. Runs Playwright assertions (`verifications`) first.
2. Captures a screenshot compared against `screenshots/{NNN}-{id}.png` with `maxDiffPixels: 0`.
3. Records metadata and assertions so `tester.generateDocs()` keeps each scenario's `README.md` permanently in sync with the test.

**Determinism:** Both `web/playwright.config.ts` and `fitbit/playwright.config.ts` launch Chromium with software rendering (`--disable-gpu`, `--use-gl=swiftshader`), disabled font hinting/subpixel positioning, fixed viewport, `deviceScaleFactor: 1`, and fixed locale/timezone (`en-US`, `America/New_York`). Both apps also bundle self-hosted `@fontsource/inter` (`latin` WOFF2) and use inline SVG for icons/checkmarks instead of `system-ui` or system symbol fonts so glyph rendering is pixel-identical across local machines and GitHub Actions `ubuntu-latest`.

Running PWA E2E tests:

```bash
npx playwright install --with-deps chromium
npm run test:e2e
```

---

## Fitbit Versa 2 Rendered & E2E Tests (Playwright)

Because Fitbit OS 4 (`@fitbit/sdk ~4.3.0`) targets a hardware watch (`mira`, `300×300` OLED screen) and cannot run natively in CI, rendered and interactive tests run in Playwright via a deterministic browser harness (`fitbit/e2e/`):

1. **Watch UI renderer (`300×300` viewport):** Loads the actual `fitbit/resources/index.gui` and `styles.css`, translating Fitbit SVG primitives (`#tile-list`, `#checkbox-tile`, `<use>`, `<set>`) into interactive browser SVG/DOM elements matching Versa 2 layout.
2. **Fitbit API shims:**
   - `document`: `getElementById`, `.text`, `.value`, `.style.display`, `.onclick`.
   - `fs`: in-memory/localStorage File Storage for testing watch-side offline cache persistence across watch restarts.
   - `device`: `{ screen: { width: 300, height: 300 } }`.
   - `fitbit-asap` / `peerSocket`: in-memory bidirectional message channel with toggleable online/offline simulation.
3. **Real Companion + Mock Server:** The shimmed messaging bridge connects directly to the real `fitbit/companion/` code, which talks over HTTP to `@tasker/mock-caldav`.
4. **Visual verification:** Uses the same `TestStepHelper` pattern (numbered scenario dirs, `maxDiffPixels: 0` screenshots, auto-generated scenario `README.md`s) to verify watch rendering, tap-to-check-off persistence to CalDAV, and offline queue replay.

---

## Visual / Screenshot Regression Policy

- **Zero-pixel tolerance (`maxDiffPixels: 0`)** for all PWA and Fitbit visual snapshots. Never relax thresholds to mask regressions.
- To update baselines after an intentional UI change:
  ```bash
  npm -w @tasker/web run test:e2e -- --update-snapshots
  ```
- Review PNG diffs carefully before committing.

---

## CI Pipeline (GitHub Actions)

Defined in `.github/workflows/ci.yml` (runs on push to `main` and pull requests):

| Job | Description |
|---|---|
| `test` | Installs workspace (`npm ci`), builds `@tasker/core` & `@tasker/mock-caldav`, runs all Vitest suites, installs Playwright Chromium, and runs E2E + visual regression tests (uploading Playwright HTML report on failure). |
| `build` | Runs after `test`; verifies production builds for **both** the PWA (`web/dist`) and the Fitbit Versa 2 `.fba` bundle (`fitbit/build/app.fba`). |

Deployment to GitHub Pages is handled by `.github/workflows/deploy.yml` on pushes to `main`.

---

## Test Coverage Requirements

| Area | Minimum line coverage |
|---|---|
| `packages/core/src/watch/` | 95% |
| `packages/core/src/caldav/parser.ts` & `serializer.ts` | 95% |
| `packages/core/src/sync/conflict.ts` | 100% |
| `packages/core/src/sync/sync-engine.ts` | 80% |
| `web/src/db/` | 80% |
| `web/src/auth.ts` | 90% |
