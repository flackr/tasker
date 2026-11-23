# Test: Quick List Switching & Per-List Categories

As a user with multiple task lists, I want the active list name as the main title so clicking it lets me switch lists immediately, and I want each list to maintain its own categories.

## Clicking the active list title in the header opens the quick list switcher menu

![Clicking the active list title in the header opens the quick list switcher menu](./screenshots/000-list-switcher-open.png)

**Verifications:**
- [x] Main title shows Shopping and switcher menu lists Shopping and Hardware

---

## Selecting Hardware updates the main title and loads Hardware tasks sorted by its own categories

![Selecting Hardware updates the main title and loads Hardware tasks sorted by its own categories](./screenshots/001-switched-to-hardware.png)

**Verifications:**
- [x] Main title is Hardware and tasks are grouped Electrical before Fasteners

---

## Categories tab edits categories specifically for Hardware without modifying Shopping

![Categories tab edits categories specifically for Hardware without modifying Shopping](./screenshots/002-per-list-categories.png)

**Verifications:**
- [x] Hardware Categories shows Electrical, Fasteners, Lumber
- [x] Remote tasker-config.json preserves Shopping categories independently from Hardware

---

