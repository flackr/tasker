# Test: Fitbit Versa 2 Multi-List & Offline Sync

As a Versa 2 user, I want to pick between my CalDAV task lists, check off items sorted by category online or offline, survive restarts from local watch storage, and go back to switch lists.

## Versa 2 shows available VTODO task lists (filtering out VEVENT-only calendars)

![Versa 2 shows available VTODO task lists (filtering out VEVENT-only calendars)](./screenshots/000-list-picker.png)

**Verifications:**
- [x] Status shows 2 available lists
- [x] Shopping and Hardware lists are shown

---

## Selecting Shopping loads tasks sorted by category order (Produce → Bakery → Dairy)

![Selecting Shopping loads tasks sorted by category order (Produce → Bakery → Dairy)](./screenshots/001-initial-sync.png)

**Verifications:**
- [x] Back (Lists) button is visible and status shows 3 left
- [x] Items appear in category order: Apples, Sourdough, Milk

---

## Tapping Apples checks it off on the watch and persists COMPLETED losslessly to CalDAV

![Tapping Apples checks it off on the watch and persists COMPLETED losslessly to CalDAV](./screenshots/002-toggled-online.png)

**Verifications:**
- [x] Apples tile is checked and status updates to 2 left
- [x] Mock CalDAV server persisted COMPLETED and preserved X-PRESERVE

---

## Watch restarts immediately into the stored Shopping list from Fitbit fs cache with pending toggle intact

![Watch restarts immediately into the stored Shopping list from Fitbit fs cache with pending toggle intact](./screenshots/003-offline-restart-cache.png)

**Verifications:**
- [x] Status shows Offline (1 pending) immediately after restart
- [x] Milk remains checked from local per-list fs storage

---

## Reconnecting syncs the newer offline watch toggle to CalDAV and clears pending state

![Reconnecting syncs the newer offline watch toggle to CalDAV and clears pending state](./screenshots/004-reconnected-synced.png)

**Verifications:**
- [x] Status clears pending count and shows 1 left
- [x] Milk is persisted as COMPLETED in CalDAV with X-PRESERVE intact

---

## User goes back to Lists and switches to the Hardware list

![User goes back to Lists and switches to the Hardware list](./screenshots/005-switched-list.png)

**Verifications:**
- [x] Hardware list task Wood Screws is displayed

---

