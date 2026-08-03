# tasker

A local-first, Bring-Your-Own-Backend (BYOB) grocery and task management ecosystem. **tasker** uses your own [Nextcloud](https://nextcloud.com/) instance as the sole backend — there is no proprietary server, no vendor lock-in, and no subscription fee. All tasks are stored as standard CalDAV VTODO components, meaning they are fully portable and accessible from any CalDAV-compatible client.

## Features

- **Offline-first Progressive Web App (PWA)** — works without an internet connection; changes sync automatically when connectivity is restored.
- **Fitbit Versa 2 companion app** — browse and check off grocery items directly from your wrist.
- **CalDAV-backed task storage** — every task is a standard `VTODO` object on your Nextcloud CalDAV server.
- **Aisle-based grocery sorting** — CalDAV `CATEGORIES` are used to tag items by store aisle, so the list is automatically sorted the way you walk the store.
- **Full CRUD** — create, read, update, and delete tasks from any client; changes reconcile via Nextcloud.

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│               Nextcloud Instance             │
│  ┌──────────────┐   ┌──────────────────────┐ │
│  │  CalDAV       │   │  WebDAV              │ │
│  │  (VTODO tasks)│   │  (JSON recipe files) │ │
│  └──────────────┘   └──────────────────────┘ │
└───────────────────────────┬─────────────────┘
                            │ HTTPS
               ┌────────────┴────────────┐
               │                         │
    ┌──────────▼──────────┐   ┌──────────▼──────────┐
    │  PWA (browser)      │   │  Fitbit Companion    │
    │  HTML/CSS/TypeScript│   │  (smartphone JS)     │
    │  Vite + Service     │   │  ┌──────────────┐   │
    │  Worker + IndexedDB │   │  │ Bluetooth BLE│   │
    └─────────────────────┘   │  └──────┬───────┘   │
                              └─────────┼────────────┘
                                        │
                              ┌─────────▼───────────┐
                              │  Fitbit Watch App    │
                              │  (Versa 2 UI)        │
                              └─────────────────────┘
```

See [docs/DESIGN.md](docs/DESIGN.md) for the full technical design.

## Prerequisites

- A running [Nextcloud](https://nextcloud.com/) instance (self-hosted or managed).
- A Nextcloud account with CalDAV enabled (enabled by default).
- The **WebAppPassword** Nextcloud app installed on your server (required for CORS when using the PWA from a different origin such as GitHub Pages).

## Nextcloud Setup

### 1. Install the WebAppPassword App

The PWA is served from a different origin than your Nextcloud instance (e.g., `https://<username>.github.io`). Browsers block cross-origin requests by default. The [WebAppPassword](https://apps.nextcloud.com/apps/webapppassword) Nextcloud app adds the required CORS headers so that the PWA can communicate directly with Nextcloud's CalDAV endpoint.

1. Log in to your Nextcloud instance as an administrator.
2. Go to **Apps** → search for **WebAppPassword** → click **Download and enable**.
3. Go to **Settings** → **WebAppPassword**.
4. Under **Allowed Origins**, add the origin from which the PWA is served, for example:
   ```
   https://<your-github-username>.github.io
   ```
   Add `http://localhost:5173` as well for local development.
5. Save the settings.

### 2. Create an App Password

Nextcloud App Passwords let you authenticate a specific application without exposing your main account password.

1. Log in to Nextcloud and go to **Settings** → **Security**.
2. Scroll to **Devices & sessions** → **Create new app password**.
3. Give it a name (e.g., `tasker-pwa`) and click **Create new app password**.
4. Copy the generated password — you will need it when logging in to the PWA for the first time.

### 3. Find Your CalDAV Endpoint

The PWA needs your CalDAV base URL. In most Nextcloud installations it is:

```
https://<your-nextcloud-domain>/remote.php/dav/calendars/<your-username>/
```

You can confirm this in **Settings** → **Calendar** (in the calendar app's sidebar under "Copy private link").

## Installation & Usage

### PWA

1. Open the hosted PWA at `https://<your-github-username>.github.io/tasker/` (or run it locally with `npm run dev`).
2. On first launch, enter:
   - **Nextcloud URL** — e.g., `https://cloud.example.com`
   - **Username** — your Nextcloud username
   - **App Password** — the password generated in step 2 above
3. The app will fetch your task lists, cache them locally in IndexedDB, and keep them in sync via the Service Worker Background Sync API.

### Fitbit Versa 2 App

See [docs/DESIGN.md § Fitbit Client](docs/DESIGN.md#fitbit-client) for sideloading instructions and Companion App setup.

## Local Development

```bash
# Install dependencies
npm install

# Start the dev server (PWA)
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

## Documentation

| Document | Description |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | Full architecture and technical design |
| [docs/TESTING.md](docs/TESTING.md) | Testing strategy and CI/CD setup |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Development backlog and roadmap |

## License

[MIT](LICENSE)
