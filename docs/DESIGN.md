# tasker — Technical Design Document

## Table of Contents

1. [Goals and Principles](#goals-and-principles)
2. [System Overview](#system-overview)
3. [Backend: Nextcloud](#backend-nextcloud)
   - [CalDAV Task Storage](#caldav-task-storage)
   - [WebDAV Recipe Storage](#webdav-recipe-storage)
   - [Authentication](#authentication)
   - [CORS Configuration](#cors-configuration)
4. [PWA Client](#pwa-client)
   - [Technology Stack](#pwa-technology-stack)
   - [Application Structure](#pwa-application-structure)
   - [CalDAV Data Flow](#caldav-data-flow)
   - [Offline Storage with IndexedDB](#offline-storage-with-indexeddb)
   - [Service Worker and Background Sync](#service-worker-and-background-sync)
   - [Conflict Resolution](#conflict-resolution)
5. [Fitbit Client](#fitbit-client)
   - [Watch App](#watch-app)
   - [Companion App](#companion-app)
   - [Bluetooth Communication Protocol](#bluetooth-communication-protocol)
   - [Watch-side Caching and Sync](#watch-side-caching-and-sync)
6. [Data Model](#data-model)
   - [Task (VTODO)](#task-vtodo)
   - [Aisle / Category](#aisle--category)
   - [Recipe (JSON over WebDAV)](#recipe-json-over-webdav)
7. [Sync Protocol](#sync-protocol)
8. [Security Considerations](#security-considerations)

---

## Goals and Principles

| Principle | Rationale |
|---|---|
| **Local-first** | The app must be usable without an internet connection. Changes made offline are queued and replayed when connectivity is restored. |
| **Bring-Your-Own-Backend** | No proprietary server. The user's Nextcloud instance is the single source of truth. |
| **Open standards** | Tasks are stored as iCalendar `VTODO` objects via CalDAV. Any CalDAV-aware tool can read and edit the data. |
| **Minimal dependencies** | The PWA is built with plain HTML/CSS/TypeScript and Vite. No heavyweight framework is introduced unless clearly justified. |
| **Privacy by default** | Credentials are stored only in the user's own browser using the Web Crypto API for encryption. They never leave the device. |

---

## System Overview

```
┌─────────────────────────────────────────────┐
│               Nextcloud Instance             │
│  ┌──────────────┐   ┌──────────────────────┐ │
│  │  CalDAV       │   │  WebDAV              │ │
│  │  (VTODO tasks)│   │  (JSON recipe files) │ │
│  └──────────────┘   └──────────────────────┘ │
└───────────────────────────┬─────────────────┘
                            │ HTTPS + Basic Auth
               ┌────────────┴────────────┐
               │                         │
    ┌──────────▼──────────┐   ┌──────────▼──────────┐
    │  PWA (browser)      │   │  Fitbit Companion    │
    │  TypeScript / Vite  │   │  (smartphone JS)     │
    │  Service Worker     │   │  ┌──────────────┐   │
    │  IndexedDB          │   │  │ Bluetooth BLE│   │
    └─────────────────────┘   │  └──────┬───────┘   │
                              └─────────┼────────────┘
                                        │ Messaging API
                              ┌─────────▼───────────┐
                              │  Fitbit Watch App    │
                              │  (Versa 2 UI / JS)   │
                              │  File Storage API    │
                              └─────────────────────┘
```

---

## Backend: Nextcloud

### CalDAV Task Storage

Nextcloud ships a built-in CalDAV server (via the **Tasks** and **Calendar** apps). Tasks are stored as `VTODO` components inside iCalendar (`.ics`) objects.

**CalDAV base URL pattern:**
```
https://<nextcloud-domain>/remote.php/dav/calendars/<username>/
```

Each grocery list is a separate CalDAV **calendar** collection. Within a collection, each task is an individual resource identified by a `UID`.

**Key CalDAV operations used:**

| HTTP Method | Purpose |
|---|---|
| `PROPFIND` (depth 1) | List all calendars for a user |
| `REPORT` (calendar-query) | Fetch all `VTODO` components from a calendar |
| `PUT` | Create or update a single task (`/dav/calendars/<user>/<cal>/<uid>.ics`) |
| `DELETE` | Remove a task |
| `PROPFIND` (CTag / ETag) | Detect whether the collection has changed since the last sync |

**Sync token / CTag strategy:**

1. On first load, fetch the collection `CTag` and store it in IndexedDB alongside all tasks.
2. On subsequent syncs, compare the stored `CTag` to the server value.
3. If changed, issue a `calendar-query` REPORT to fetch updated resources and reconcile with the local store.

### WebDAV Recipe Storage

Recipes (what to cook for the week) are stored as raw JSON files under a dedicated WebDAV folder:

```
https://<nextcloud-domain>/remote.php/dav/files/<username>/tasker/recipes/
```

Each recipe is a file named `<recipe-slug>.json`. The PWA reads and writes these files using standard WebDAV `GET` / `PUT` / `DELETE` operations.

### Authentication

Authentication uses **HTTP Basic Auth** with a Nextcloud **App Password** (not the user's main password). App Passwords can be revoked individually and are scoped to a single application.

Credentials are stored client-side using the browser's `localStorage` or an encrypted IndexedDB entry, never transmitted to any server other than the user's own Nextcloud.

### CORS Configuration

The PWA and Nextcloud live on different origins. Browsers enforce the Same-Origin Policy, blocking cross-origin `PROPFIND` / `REPORT` / `PUT` requests by default.

**Solution:** The [WebAppPassword](https://apps.nextcloud.com/apps/webapppassword) Nextcloud app injects the necessary CORS response headers (`Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`) for the CalDAV and WebDAV endpoints.

Required headers added by WebAppPassword:
```
Access-Control-Allow-Origin: https://<pwa-origin>
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PROPFIND, REPORT, OPTIONS, MKCOL, MOVE, COPY
Access-Control-Allow-Headers: Authorization, Content-Type, Depth, Prefer, If-Match, If-None-Match
Access-Control-Expose-Headers: ETag, DAV
Access-Control-Allow-Credentials: true
```

---

## PWA Client

### PWA Technology Stack

| Layer | Technology |
|---|---|
| Language | TypeScript |
| Bundler | Vite |
| Markup / Styles | Plain HTML + CSS custom properties |
| Local DB | IndexedDB (via a thin typed wrapper) |
| Offline sync | Service Worker + Background Sync API |
| CalDAV parsing | Custom iCalendar parser (no external dependency) |
| Testing | Vitest + Playwright |

### PWA Application Structure

```
pwa/
├── index.html
├── src/
│   ├── main.ts              # Entry point; bootstraps app
│   ├── auth.ts              # Credential storage and Basic Auth helpers
│   ├── caldav/
│   │   ├── client.ts        # Raw CalDAV HTTP methods (PROPFIND, REPORT, PUT, DELETE)
│   │   ├── parser.ts        # iCalendar → internal task model
│   │   └── serializer.ts    # Internal task model → iCalendar string
│   ├── db/
│   │   ├── index.ts         # IndexedDB open/upgrade
│   │   ├── tasks.ts         # Task CRUD against IndexedDB
│   │   └── sync-queue.ts    # Pending-change queue for offline support
│   ├── sync/
│   │   ├── sync-engine.ts   # Orchestrates fetch → diff → persist → queue flush
│   │   └── conflict.ts      # Last-write-wins conflict resolution
│   ├── ui/
│   │   ├── app.ts           # Root component; routing
│   │   ├── list-view.ts     # Grocery list sorted by aisle
│   │   ├── task-editor.ts   # Add / edit task form
│   │   └── settings.ts      # Nextcloud connection settings
│   └── sw/
│       └── service-worker.ts  # Installs, caches assets, registers sync events
├── vite.config.ts
└── package.json
```

### CalDAV Data Flow

```
Browser tab
   │
   ├─ On load ──────────────────────────────────────────────────────────────────┐
   │   1. Read tasks from IndexedDB (renders instantly, offline-safe)           │
   │   2. If online: start background sync                                      │
   │                                                                            │
   ├─ Background sync ──────────────────────────────────────────────────────────┤
   │   1. PROPFIND collection → compare CTag to stored value                   │
   │   2. If changed: REPORT calendar-query → get all VTODO ETags + data       │
   │   3. Diff against local store (by UID + ETag)                              │
   │   4. Write new/changed tasks to IndexedDB                                 │
   │   5. Delete locally cached tasks that are gone from server                │
   │   6. Store new CTag                                                        │
   │                                                                            │
   └─ User creates/edits/deletes a task ───────────────────────────────────────┤
       1. Write change to IndexedDB immediately (optimistic update)             │
       2. Enqueue change in sync-queue (IndexedDB)                              │
       3. If online: flush queue immediately via PUT / DELETE                   │
       4. If offline: Service Worker registers a `sync` event; queue is        │
          flushed when connectivity is restored                                 │
```

### Offline Storage with IndexedDB

**Database name:** `tasker-db`

**Object stores:**

| Store | Key | Indexes | Description |
|---|---|---|---|
| `tasks` | `uid` (string) | `calendarId`, `categories`, `status` | Cached VTODO tasks |
| `calendars` | `id` (string) | — | Calendar collections + CTag |
| `sync-queue` | auto-increment | `status` | Pending create/update/delete operations |
| `credentials` | `"default"` | — | Encrypted Nextcloud credentials |
| `recipes` | `slug` (string) | — | Cached recipe JSON |

### Service Worker and Background Sync

The Service Worker (`sw/service-worker.ts`) is responsible for:

1. **Asset caching** — on `install`, pre-caches all Vite-built assets so the app shell loads instantly offline.
2. **Sync event handler** — listens for the `sync` event with the tag `caldav-flush`. When fired, it dequeues all pending operations from IndexedDB and replays them against Nextcloud CalDAV.
3. **Network-first for CalDAV** — CalDAV PROPFIND/REPORT requests bypass the cache and always go to the network; a failure falls back to the IndexedDB snapshot.

**Sync tag registration:**

```typescript
// Registered by the main thread whenever a change is queued while offline
navigator.serviceWorker.ready.then(reg => {
  reg.sync.register('caldav-flush');
});
```

### Conflict Resolution

tasker uses a **last-write-wins** strategy based on the CalDAV `ETag` and iCalendar `LAST-MODIFIED` property:

1. A `PUT` is sent with an `If-Match: <stored-etag>` header.
2. If the server returns `412 Precondition Failed`, a fresh copy is fetched from the server.
3. The server version is shown to the user with a diff indicator; the user can choose which version to keep (or the local version overwrites if in "auto" mode).

---

## Fitbit Client

### Watch App

The Watch App runs inside the Fitbit OS JavaScript sandbox on the Versa 2 device. It is responsible solely for rendering the UI and handling user input.

**Key responsibilities:**
- Display task lists sorted by aisle/category.
- Allow tapping an item to toggle its `completed` state.
- Show a "syncing" indicator while waiting for a Companion response.
- Persist the current task list to the Fitbit **File Storage API** for offline access.

**Technology:**
- Fitbit SDK (JavaScript + SVG-based UI)
- File Storage API for local persistence
- Messaging API for Companion communication

### Companion App

The Companion App runs on the paired smartphone (iOS or Android) inside the Fitbit mobile app. It has full network access.

**Key responsibilities:**
- Receive task-fetch and task-update requests from the watch via the Messaging API.
- Translate these into CalDAV HTTP requests against the user's Nextcloud.
- Parse the iCalendar response, extract the minimal task payload (uid, summary, categories, status), and send it back to the watch as a compact JSON message.

**Technology:**
- Fitbit Companion SDK (JavaScript)
- `fetch` API for HTTP requests
- iCalendar parser (shared module with PWA where possible)

### Bluetooth Communication Protocol

All messages between Watch App and Companion App use the Fitbit **Messaging API** (`peerSocket`). Messages are plain JSON objects.

**Message types:**

```typescript
// Watch → Companion: request the current task list
{ type: "FETCH_TASKS"; calendarId: string }

// Companion → Watch: deliver the task list
{ type: "TASKS_PAYLOAD"; tasks: CompactTask[]; calendarId: string }

// Watch → Companion: toggle a task's completion
{ type: "UPDATE_TASK"; uid: string; completed: boolean; calendarId: string }

// Companion → Watch: confirm the update was persisted
{ type: "UPDATE_ACK"; uid: string; etag: string }

// Companion → Watch: report an error
{ type: "ERROR"; message: string }

// Compact task representation sent over Bluetooth
interface CompactTask {
  uid: string;
  summary: string;
  categories: string[];   // aisle tags
  completed: boolean;
  etag: string;
}
```

Message size is kept minimal (< 1 KB per message) to respect Fitbit messaging limits.

### Watch-side Caching and Sync

The watch caches the last-known task list in the **Fitbit File Storage API** (`fs.writeFileSync` / `fs.readFileSync`). On startup:

1. Read the cached list from File Storage and render it immediately.
2. Send `FETCH_TASKS` to the Companion.
3. When `TASKS_PAYLOAD` arrives, merge it with the cached list (union by UID, prefer server version) and re-render.

If the Companion is unreachable (Bluetooth disconnected), the cached list is shown with a "offline" badge.

---

## Data Model

### Task (VTODO)

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//tasker//EN
BEGIN:VTODO
UID:550e8400-e29b-41d4-a716-446655440000
DTSTAMP:20240101T120000Z
CREATED:20240101T120000Z
LAST-MODIFIED:20240101T120000Z
SUMMARY:Organic whole milk
CATEGORIES:Dairy,Aisle 3
STATUS:NEEDS-ACTION          ; or COMPLETED
PERCENT-COMPLETE:0           ; 100 when done
PRIORITY:5
DESCRIPTION:2% fat preferred
END:VTODO
END:VCALENDAR
```

**Internal TypeScript model:**

```typescript
interface Task {
  uid: string;
  calendarId: string;
  summary: string;
  description?: string;
  categories: string[];       // aisle tags
  status: "NEEDS-ACTION" | "COMPLETED" | "IN-PROCESS" | "CANCELLED";
  priority: number;           // 0–9 (0 = undefined)
  created: Date;
  lastModified: Date;
  etag?: string;              // from CalDAV ETag header
  dirty: boolean;             // true if local change not yet synced
}
```

### Aisle / Category

CalDAV `CATEGORIES` values are used as aisle labels. The app maintains a local ordered list of aisle names (stored in IndexedDB) that controls the sort order of items in the grocery view. Users can add, rename, and reorder aisles from the Settings screen.

### Recipe (JSON over WebDAV)

```json
{
  "slug": "pasta-bolognese",
  "title": "Pasta Bolognese",
  "servings": 4,
  "ingredients": [
    { "item": "Ground beef", "quantity": "500g", "aisle": "Meat" },
    { "item": "Pasta", "quantity": "400g", "aisle": "Pasta & Rice" }
  ],
  "instructions": "..."
}
```

When a recipe is added to the weekly meal plan, its ingredients are automatically converted to tasks (VTODOs) in the grocery list calendar.

---

## Sync Protocol

### PWA Full Sync (online)

```
1. PROPFIND /dav/calendars/<user>/tasker/  (Depth: 0)
   → Read {getctag} property

2. If ctag == stored ctag: skip (nothing changed)

3. REPORT /dav/calendars/<user>/tasker/  (calendar-query, Depth: 1)
   → Filter VTODO
   → Request {getetag} + calendar-data

4. For each item in response:
   a. If UID not in local DB → INSERT
   b. If ETag differs → UPDATE
   c. Else → skip

5. For each UID in local DB not in response → soft-delete locally

6. Store new ctag

7. Flush sync-queue:
   For each pending operation:
     PUT /dav/calendars/.../uid.ics  (with If-Match header)
     on 412: fetch fresh, show conflict UI
     on 2xx: remove from queue, store new ETag
```

### PWA Offline → Online Transition

The Service Worker listens for the `sync` event tagged `caldav-flush`. When fired:

1. Re-run step 7 from the full sync above.
2. After all queued operations succeed, trigger a full sync (steps 1–6).

### Fitbit Sync

```
Watch startup
  → read File Storage cache → render

Companion socket open
  → Watch sends FETCH_TASKS
  → Companion: PROPFIND + REPORT → parse → send TASKS_PAYLOAD
  → Watch: merge cache + payload → render + save to File Storage

User checks off item
  → Watch sends UPDATE_TASK
  → Companion: PUT to CalDAV
  → on success: sends UPDATE_ACK → Watch updates cache
  → on failure: sends ERROR → Watch shows error badge, reverts optimistic update
```

---

## Security Considerations

| Concern | Mitigation |
|---|---|
| Credential storage | App Passwords stored in IndexedDB, encrypted with a key derived from a user-provided PIN via Web Crypto API (PBKDF2 → AES-GCM). |
| Transport security | All traffic to Nextcloud over HTTPS (TLS 1.2+). Self-signed certificates are rejected by default. |
| CORS | Only origins explicitly whitelisted in WebAppPassword can make credentialed requests. |
| App Password scope | Users should create a dedicated App Password for tasker so it can be revoked without affecting other integrations. |
| No data egress | No analytics, telemetry, or third-party services. The app never communicates with any server other than the user's own Nextcloud instance. |
| Content Security Policy | The PWA's `index.html` sets a strict `Content-Security-Policy` header restricting script, style, and connect sources. |
