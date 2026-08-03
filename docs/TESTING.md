# tasker — Testing Strategy

## Table of Contents

1. [Overview](#overview)
2. [PWA Tests](#pwa-tests)
   - [Unit Tests (Vitest)](#unit-tests-vitest)
   - [Integration Tests (Vitest + MSW)](#integration-tests-vitest--msw)
   - [End-to-End Tests (Playwright)](#end-to-end-tests-playwright)
3. [Fitbit Tests](#fitbit-tests)
   - [Unit Tests (Jest)](#unit-tests-jest)
   - [Message Protocol Tests](#message-protocol-tests)
4. [CI Pipeline (GitHub Actions)](#ci-pipeline-github-actions)
   - [Workflow Overview](#workflow-overview)
   - [PR Check Summary](#pr-check-summary)
5. [Visual / Screenshot Testing](#visual--screenshot-testing)
6. [CalDAV Mock Server](#caldav-mock-server)
7. [Test Coverage Requirements](#test-coverage-requirements)

---

## Overview

tasker follows a **test pyramid** approach:

```
        ╱ E2E ╲           ← few, slow, high confidence
       ╱─────────╲
      ╱ Integration╲      ← moderate, mock network
     ╱───────────────╲
    ╱   Unit Tests    ╲   ← many, fast, pure logic
   ╱───────────────────╲
```

| Layer | Tool | Scope |
|---|---|---|
| Unit | Vitest (PWA) / Jest (Fitbit) | Pure functions: parsers, serializers, conflict logic, DB helpers |
| Integration | Vitest + Mock Service Worker (MSW) | CalDAV client, sync engine, IndexedDB interactions |
| E2E | Playwright | Full user flows in a real browser against a mock CalDAV server |
| Visual regression | Playwright screenshots + pixelmatch | UI snapshots captured on every PR |

---

## PWA Tests

### Unit Tests (Vitest)

Located in `web/src/**/*.test.ts`.

**What is tested:**

| Module | Test file | Key test cases |
|---|---|---|
| `caldav/parser.ts` | `parser.test.ts` | Parse VTODO with all fields; parse VTODO with minimal fields; handle COMPLETED status; handle multiple CATEGORIES; reject non-VTODO objects |
| `caldav/serializer.ts` | `serializer.test.ts` | Round-trip serialization (serialize → parse → deep-equal); CATEGORIES encoding; DATE-TIME timezone handling |
| `sync/conflict.ts` | `conflict.test.ts` | Local newer wins; server newer wins; equal timestamps → server wins |
| `db/sync-queue.ts` | `sync-queue.test.ts` | Enqueue create/update/delete; dequeue in FIFO order; remove after ACK |
| `auth.ts` | `auth.test.ts` | Basic Auth header generation; credential encrypt/decrypt roundtrip |

**Running unit tests:**

```bash
cd web
npm test           # run once
npm run test:watch # watch mode
```

**Example unit test (parser):**

```typescript
import { describe, it, expect } from 'vitest';
import { parseVTodo } from '../src/caldav/parser';

describe('parseVTodo', () => {
  it('parses a completed task with categories', () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:abc-123\r\nSUMMARY:Milk\r\nSTATUS:COMPLETED\r\nCATEGORIES:Dairy,Aisle 3\r\nEND:VTODO\r\nEND:VCALENDAR\r\n`;
    const task = parseVTodo(ics);
    expect(task.uid).toBe('abc-123');
    expect(task.summary).toBe('Milk');
    expect(task.status).toBe('COMPLETED');
    expect(task.categories).toEqual(['Dairy', 'Aisle 3']);
  });
});
```

### Integration Tests (Vitest + MSW)

Located in `web/src/**/*.integration.test.ts`.

[Mock Service Worker (MSW)](https://mswjs.io/) intercepts `fetch` calls inside the test environment and returns canned CalDAV XML responses, allowing the full CalDAV client and sync engine to be exercised without a real Nextcloud instance.

**What is tested:**

| Module | Test file | Key scenarios |
|---|---|---|
| `caldav/client.ts` | `client.integration.test.ts` | PROPFIND returns calendar list; REPORT returns VTODO list; PUT succeeds; PUT returns 412 on ETag mismatch |
| `sync/sync-engine.ts` | `sync-engine.integration.test.ts` | Full sync stores tasks in IndexedDB; incremental sync (changed CTag) fetches only deltas; offline queue is flushed on reconnect |

**Running integration tests:**

```bash
cd web
npm run test:integration
```

### End-to-End Tests (Playwright)

Located in `web/e2e/`.

Playwright launches a real Chromium browser, navigates to the Vite dev server, and interacts with the app as a user would. A lightweight mock CalDAV HTTP server (Node.js + `http`) is started alongside the browser to serve pre-canned responses.

**Test suites:**

| Suite | File | Scenarios |
|---|---|---|
| Authentication | `e2e/auth.spec.ts` | Enter credentials → tasks load; wrong password → error shown |
| Task list | `e2e/task-list.spec.ts` | Tasks displayed; sorted by aisle; completed tasks show strikethrough |
| Task CRUD | `e2e/task-crud.spec.ts` | Add task → appears in list; edit task → summary updated; delete task → removed from list |
| Offline mode | `e2e/offline.spec.ts` | Go offline → cached tasks visible; add task offline → synced when back online |
| Settings | `e2e/settings.spec.ts` | Change Nextcloud URL → app reconnects |

**Running E2E tests:**

```bash
cd web
npx playwright install --with-deps chromium
npm run test:e2e
```

---

## Fitbit Tests

The Fitbit SDK does not run in a standard Node.js environment, so tests target the shared logic modules that can be compiled and tested independently of the SDK.

### Unit Tests (Jest)

Located in `fitbit/src/**/*.test.js`.

**What is tested:**

| Module | Test file | Key test cases |
|---|---|---|
| `shared/ical-parser.js` | `ical-parser.test.js` | Same parser used by the Companion App; same test cases as PWA parser unit tests |
| `companion/caldav-client.js` | `caldav-client.test.js` | HTTP request construction; response parsing |
| `watch/cache.js` | `cache.test.js` | Merge server payload with local cache; handle deleted items |

**Running Fitbit unit tests:**

```bash
cd fitbit
npm test
```

### Message Protocol Tests

Located in `fitbit/src/protocol.test.js`.

These tests verify that Watch App and Companion App serialize and deserialize messages correctly and that the protocol handles edge cases:

- Message with unknown `type` is ignored without throwing.
- `TASKS_PAYLOAD` with 0 items renders empty-list UI.
- `UPDATE_ACK` for an unknown UID is silently discarded.
- Oversized payload (> 1 KB) is split and reassembled correctly.

---

## CI Pipeline (GitHub Actions)

### Workflow Overview

The CI pipeline is defined in `.github/workflows/ci.yml` and runs on every push to `main` and on every pull request.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  pwa-unit:
    name: PWA Unit & Integration Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd pwa && npm ci
      - run: cd pwa && npm test
      - run: cd pwa && npm run test:integration

  pwa-e2e:
    name: PWA E2E Tests (Playwright)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd pwa && npm ci
      - run: npx playwright install --with-deps chromium
      - run: cd pwa && npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: web/playwright-report/
          retention-days: 30

  fitbit-unit:
    name: Fitbit Unit Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd fitbit && npm ci
      - run: cd fitbit && npm test

  build:
    name: PWA Production Build
    runs-on: ubuntu-latest
    needs: [pwa-unit, pwa-e2e]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: cd pwa && npm ci
      - run: cd pwa && npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: pwa-dist
          path: web/dist/
```

### PR Check Summary

Every pull request must pass the following checks before merging:

| Check | Required | Description |
|---|---|---|
| `PWA Unit & Integration Tests` | ✅ | Vitest unit + integration suite |
| `PWA E2E Tests (Playwright)` | ✅ | Playwright browser automation |
| `Fitbit Unit Tests` | ✅ | Jest suite for shared Fitbit modules |
| `PWA Production Build` | ✅ | Ensures the Vite build compiles without errors |

---

## Visual / Screenshot Testing

Playwright captures full-page screenshots at the end of each E2E test. Screenshots are uploaded as CI artifacts and compared against baseline images using [pixelmatch](https://github.com/mapbox/pixelmatch) to detect unintended visual regressions.

**Baseline management:**

- Baseline screenshots live in `web/e2e/screenshots/baseline/`.
- To update baselines (e.g., after an intentional UI change), run:
  ```bash
  cd pwa && npm run test:e2e -- --update-snapshots
  ```
  then commit the updated baseline files.

**Screenshot artifact example (PR comment):**

When the `pwa-e2e` job runs on a PR, the workflow uploads the Playwright HTML report as a CI artifact. The report includes:

- A pass/fail summary for each test.
- Inline screenshots for failed assertions (actual vs. expected diff highlighted in red).
- A trace viewer link for step-by-step replay of failed tests.

![Playwright report example showing task list screenshot](../docs/assets/playwright-report-example.png)

*(The `docs/assets/` folder contains representative screenshots added during initial development.)*

---

## CalDAV Mock Server

For E2E and integration tests, a minimal CalDAV mock server (`web/test-utils/mock-caldav-server.ts`) is used instead of a real Nextcloud instance. It:

- Responds to `PROPFIND` requests with a configurable list of calendars and CTags.
- Responds to `REPORT` (calendar-query) with a configurable set of VTODO resources.
- Accepts `PUT` requests and records the sent iCalendar data for assertion.
- Accepts `DELETE` requests and records the deleted UIDs.
- Can be configured to return specific HTTP status codes (e.g., `412`) to test error handling.

The mock server is started in a `beforeAll` hook and torn down in `afterAll`.

---

## Test Coverage Requirements

| Area | Minimum line coverage |
|---|---|
| `caldav/parser.ts` | 95% |
| `caldav/serializer.ts` | 95% |
| `sync/sync-engine.ts` | 80% |
| `sync/conflict.ts` | 100% |
| `db/tasks.ts` | 80% |
| `db/sync-queue.ts` | 90% |
| `auth.ts` | 90% |

Coverage is reported by Vitest and uploaded to the CI summary. PRs that drop below the thresholds above will fail the `PWA Unit & Integration Tests` check.

**Generate a local coverage report:**

```bash
cd web
npm run test:coverage
# Report written to web/coverage/index.html
```
