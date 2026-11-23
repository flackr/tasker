# tasker — Fitbit Versa 2 App (`@tasker/fitbit`)

Grocery checklist watch app and smartphone companion app targeting **Fitbit Versa 2** (`mira`, Fitbit OS 4, `@fitbit/sdk ~4.3.0`).

## Prerequisites

1. **Build the bundle** from the repository root:
   ```bash
   npm run build:fitbit
   ```
   This compiles `@tasker/core` (ES5 for watch, ES2015 for companion) and outputs `fitbit/build/app.fba`.

2. **Install the Fitbit CLI (`@fitbit/sdk-cli`)** for sideloading:
   - `@fitbit/sdk-cli` is listed in `optionalDependencies` because its `keytar` dependency requires native `libsecret` headers on Linux when no prebuilt binary exists for your Node version.
   - **On Linux (Ubuntu/Debian) with Node 18+:**
     ```bash
     sudo apt-get install libsecret-1-dev
     npm install
     ```
   - **Alternative without installing system headers (using nvm with Node 14/16):**
     ```bash
     nvm use 14   # or 16, where keytar prebuilds are available
     cd fitbit && npx -p @fitbit/sdk-cli@^1.7.3 fitbit
     ```

3. **Enable Developer Bridge on your phone and Versa 2:**
   - **On your Versa 2:** Open **Settings** → **Developer Bridge** and turn it **On** (watch must be connected to Wi-Fi and wait until it says *Connected to Server*).
   - **On your smartphone (Fitbit mobile app):** Tap your profile → **Versa 2** → **Developer Menu** → turn **Developer Bridge** **On**.
     *(If you don't see Developer Menu, make sure you are signed into a Fitbit developer account at [dev.fitbit.com](https://dev.fitbit.com/).)*

## Installing onto your Fitbit Versa 2

### Method 1: Private Install via Fitbit Gallery App Manager (`gam.fitbit.com`)

If `@fitbit/sdk-cli` login returns **403 Forbidden** at `www.fitbit.com/oauth2/authorize` (due to Google/Fitbit deprecating the legacy OAuth endpoint), you can install `fitbit/build/app.fba` directly as a private app:

1. Build the Versa 2 bundle from the repository root:
   ```bash
   npm run build:fitbit
   ```
2. Open [https://gam.fitbit.com](https://gam.fitbit.com) in your browser and sign in with your Fitbit/Google account.
3. Click **Add App** (or open your existing `99c33526-f098-4b3b-a932-168e244bee40` app entry), upload `fitbit/build/app.fba`, and save it as a **Private** app (no public gallery review required).
4. Copy/open the generated **Private Install Link** on your smartphone — it will open the Fitbit mobile app and install **Tasks** directly onto your Versa 2.

### Method 2: Developer Bridge Sideloading (`@fitbit/sdk-cli`)

*(Note: Requires `www.fitbit.com/oauth2/authorize` to be reachable for CLI OAuth login.)*

From the `fitbit/` directory (after running `npm run build:fitbit` at the repo root):

```bash
cd fitbit
npx fitbit
```

Inside the interactive `fitbit$` shell (the first run will open a browser tab to log into your Fitbit developer account):

```text
fitbit$ connect phone
fitbit$ connect device
fitbit$ install
```

- `install` uploads `fitbit/build/app.fba` to both your Versa 2 watch and the Fitbit mobile app Companion.
- After making code changes later, rebuild from the repo root with `npm run build:fitbit` (so `@tasker/core` is rebuilt too), then run `install` again inside the `fitbit$` shell.

## Configuring Nextcloud in Fitbit Mobile App

1. Open the **Fitbit** app on your phone → **Versa 2** → **Apps** → **Tasks** → **Settings**.
2. Fill in:
   - **Nextcloud Server URL** — e.g. `https://cloud.example.com` (no trailing slash needed)
   - **Username** — your Nextcloud username
   - **App Password** — dedicated Nextcloud App Password (**Personal Settings → Security → Devices & sessions → Create new app password**)
   - **Task List Name (optional)** — e.g. `shopping`, or leave blank to auto-detect your first VTODO list (or use `defaultCalendarHref` from `tasker-config.json`)
   - **Config JSON Path (optional)** — e.g. `Notes/tasker-config.json` to share the same category order as the PWA
3. Open **Tasks** on your Versa 2 — pick any task list to view and check off items sorted by category (offline check-offs are cached per list via File Storage and reconcile automatically when reconnected).

## Local Testing (No Device Required)

```bash
# Run Fitbit Watch + Companion unit/integration tests against @tasker/mock-caldav
npm -w @tasker/fitbit run test

# Run Fitbit Versa 2 (300x300) Playwright rendered + visual regression tests
npm -w @tasker/fitbit run test:e2e
```
