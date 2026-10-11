# Pro Habit Tracker

A personal habit and productivity dashboard for building consistency. Track daily habits, maintain streaks, visualise activity on a heatmap, review real analytics derived from your own completion history, and optionally track menstrual cycle estimates — all with offline persistence and a clear sync-status indicator.

## Live Demo

https://pro-habit-tracker-bb9c8.web.app

## Features

- **Authentication** — email/password sign-up and login, Google sign-in, logout, per-user private data, auth error states
- **Habits CRUD** — create (name, description, category, icon, color, frequency), edit, delete with confirmation
- **Frequencies** — every day, weekdays (Mon–Fri), or specific weekdays; off-days are excluded from streaks and rates
- **Daily dashboard** — greeting, today's progress, today's habits, week strip, data-driven insights
- **Reliable streaks** — current streak, longest streak, completion rate, totals and missed days derived from a `completions` date history (no fragile `lastDone` counters); duplicates prevented; timezone-safe local date keys
- **Calendar heatmap** — GitHub-style activity grid for the last ~15 weeks with per-habit filter and click-a-day details
- **Analytics** — 7-day and 30-day charts, per-habit consistency, category performance (dependency-free, no chart library)
- **Habit details** — stats, 35-day mini calendar, recent activity, edit/delete/toggle from the detail view
- **Achievements** — 7/14/30-day streaks, 50/100 completions, strong-week milestones earned from real data
- **Gamification (light)** — XP (10 per completion + streak bonuses) and levels
- **Smart insights** — best category, most active weekday, longest-streak habit, most/least consistent habit
- **Offline persistence** — Firestore's persistent local cache stores habits and cycle data on-device; changes made offline are queued and sync automatically when connectivity returns
- **Sync-status indicator** — a live chip in the topbar shows `Synced`, `Syncing…`, or `Offline — changes stay on this device`
- **Cycle tracking** — optional period tracking with average-cycle estimation, estimated next-period date, and a configurable lead-time reminder (discreet wording, no sensitive details in notifications)
- **Reminders** — optional daily habit reminder time with browser Notification API and in-app toast fallback; cycle reminders fire once per prediction window
- **Dark / light / system theme** — persisted on device
- **Search, filter, sort** — by text, category, done/todo status; sort by name, streak, rate, newest
- **Responsive + accessible** — mobile sidebar, semantic HTML, labels, focus states, ARIA where needed
- **UX states** — loading, empty, error banners, toasts, confirm dialogs (no `alert()` for core flows)

## Tech Stack

- HTML, CSS, JavaScript (no build step, no framework)
- Firebase Authentication (email/password + Google)
- Cloud Firestore (per-user data) with persistent local cache (`persistentLocalCache`)
- Firebase Hosting

## Project Structure

- `index.html` — app shell: auth screen, sidebar navigation, dashboard/habits/calendar/analytics/achievements/cycle/settings views, modals
- `style.css` — design system (CSS variables, light/dark themes, cards, responsive layout, sync-chip styles)
- `script.js` — auth, realtime Firestore listener, offline-safe write pipeline (`settleWrite`), history-based streak engine, rendering, heatmap, analytics, habit and cycle reminders
- `firebase.js` — Firebase app, Auth, and Firestore initialisation with persistent offline cache
- `firestore.rules` — per-user security rules (`users/{uid}/habits`)
- `firebase.json` — Hosting + Firestore rules deployment config
- `404.html` — hosting fallback page

## Firestore Schema

```text
users/{uid}                      { email, updatedAt, cycle? }
users/{uid}/habits/{habitId}
  {
    name: string,
    description: string,
    category: "Health" | "Fitness" | "Learning" | "Productivity" | "Personal" | "Other",
    icon: string,
    color: string,
    frequency: { type: "daily" | "weekdays" | "custom", days: number[] },  // 0=Sun..6=Sat
    completions: string[],   // ["2026-10-07", ...] local-date keys, arrayUnion/arrayRemove
    createdAt: timestamp,
    updatedAt: timestamp,
    archived: false
  }
```

The optional `cycle` field on `users/{uid}` stores period-tracking data:

```text
cycle: {
  enabled: boolean,
  reminder: boolean,
  lead: number,              // days before estimated date to remind (0-14, default 3)
  entries: [{ id, start, end?, symptoms[], note }]
}
```

Streaks, rates, XP, badges, and insights are **derived at render time** from `completions` plus the schedule — they are never stored as separate counters that can drift.

Legacy note: the original version stored all habits in a shared top-level `habits` collection with `streak/longest/lastDone` fields and no authentication. The new rules deny that collection; data is per-user under `users/{uid}/habits`.

## Security Rules

`firestore.rules` allows only `request.auth.uid == userId` for `/users/{userId}` and `/users/{userId}/habits/{habitId}`, and denies everything else. Unauthenticated reads/writes are rejected.

## Offline Persistence

Firestore is initialised with `persistentLocalCache` (backed by IndexedDB), so habit and cycle data survive page refreshes and work offline. When a write is issued while offline:

- The change is applied locally immediately (latency compensation).
- Firestore queues the write and syncs it automatically when connectivity returns.
- The sync chip shows `Offline — changes stay on this device` and updates to `Synced` once the queue drains.
- If a queued write fails after reconnecting, a loud error toast surfaces the failure.

**What works offline:** viewing cached habits and cycle data, toggling habit completions, creating/editing/deleting habits, recording/editing/deleting cycle entries.

**What requires internet:** initial sign-in, Google sign-in, and the first load for a given account on a given device (before the cache is populated).

## Reminders

### Habit reminders
- Set a daily reminder time in Settings; the app checks every 20 seconds and on page focus/visibility.
- Fires at most once per (user, time, calendar-day) — dedup key is account-scoped and date-aware, so multiple tabs, reloads, or rerenders never double-fire.
- Uses the browser Notification API when permission is granted; falls back to an in-app toast otherwise.
- Permission is only requested on explicit user action, never on page load.

### Cycle reminders
- Optional; fires once within the configured lead window (0–14 days) before the estimated next-period date.
- One reminder per prediction — dedup key is account-scoped and prediction-scoped.
- Stale predictions are invalidated automatically when period entries change.
- Notification wording is deliberately discreet (no dates or sensitive details).

**Important limitation:** reminders only run while the page is open in this browser. A website cannot execute JavaScript after its tab or window has been closed. Closed-site notification delivery would require a native app build or a push service — neither is included.

## Browser Support & Accessibility

- Modern evergreen browsers (Chrome, Firefox, Edge, Safari).
- Responsive layout with mobile sidebar navigation.
- Semantic HTML, proper labels, focus management in modals, ARIA roles where needed.
- Light/dark/system theme with `prefers-color-scheme` support.

## How to Run

Prerequisites: a Firebase project with Authentication (Email/Password + Google) and Firestore enabled.

```powershell
git clone https://github.com/archana-kadaralli/pro-habit-tracker.git
cd pro-habit-tracker
# No dependencies — serve the directory over HTTP:
npx serve .
```

The app uses the Firebase project `pro-habit-tracker-bb9c8` by default (see `firebase.js`). To point at your own project, replace the `firebaseConfig` object and enable the same auth providers.

## Deployment

```powershell
firebase login
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

Live URL: https://pro-habit-tracker-bb9c8.web.app

Before deploying, enable in the Firebase console:

1. Authentication → Sign-in method → Email/Password and Google → enable. Add `pro-habit-tracker-bb9c8.web.app` (and `localhost` for testing) to authorised domains.
2. Firestore → create database → deploy `firestore.rules`.

## Testing

Automated test suites run in jsdom with stubbed Firebase services (not against a live backend):

- **Unit tests** — UI interactions, streak engine, auth flows, gap handling, and Phase B offline-write / reminder regression checks (41 checks covering sync chip, `settleWrite` contract, habit reminder dedup/permission fallback, cycle reminder lead-window/dedup/stale-invalidation, and offline cycle toast wording).
- **Browser tests** — screenshot-based layout audits, design consistency checks, focus management, and accessibility spot-checks.

These suites validate logic and UI behaviour with mocks. They do **not** verify real-browser IndexedDB persistence, live Firestore reconnect/write-replay, or closed-site notification delivery — those require a live backend and real browser, and have not been tested.

## Known Limitations

- **No closed-site reminders** — reminders only fire while the page is open. A website cannot run in the background after the tab is closed.
- **No background GPS activity tracking** — walking/cycling GPS sessions require a native app with background location permissions; not implemented.
- **No native Android/iOS project** — this is a web-only application. A Capacitor/native build is a separate future phase.
- **Offline persistence is browser-profile-scoped** — data is cached in IndexedDB per browser profile; clearing site data removes the cache (Firestore re-syncs from the cloud on next load).
- **Cycle estimates are informational** — average-based predictions with a ±2-day window; not a medical device.

## What I Learned

- Designing a per-user Firestore schema and enforcing isolation with security rules (not just client-side filtering)
- Deriving streaks/rates from append-only date history instead of mutable counters, including schedule-aware streaks and timezone-safe date keys
- Realtime listeners (`onSnapshot`) with local derived state to minimise reads and avoid full refetches
- Building dashboard UX (heatmap, dependency-free charts, insights) from real user data without fake statistics
- Enabling Firestore's persistent local cache and building an honest offline-write pipeline that distinguishes device-local acceptance from cloud sync

## Future Improvements

- Habit archiving/pausing instead of delete-only
- Weekly/monthly email or push summary
- Data export (CSV) of completion history
- Native Android/iOS build (Capacitor) with background notifications and GPS activity tracking

## Author

- GitHub: [archana-kadaralli](https://github.com/archana-kadaralli)
- LinkedIn: [archana-kadaralli](https://www.linkedin.com/in/archana-kadaralli-2392a2400/)
