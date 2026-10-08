# Pro Habit Tracker

A personal habit and productivity dashboard for building consistency. Track daily habits, maintain streaks, visualise activity on a heatmap, and review real analytics derived from your own completion history.

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
- **Reminders** — optional daily reminder time with browser Notification API and in-app toast fallback
- **Dark / light / system theme** — persisted on device
- **Search, filter, sort** — by text, category, done/todo status; sort by name, streak, rate, newest
- **Responsive + accessible** — mobile sidebar, semantic HTML, labels, focus states, ARIA where needed
- **UX states** — loading, empty, error banners, toasts, confirm dialogs (no `alert()` for core flows)

## Tech Stack

- HTML, CSS, JavaScript (no build step, no framework)
- Firebase Authentication (email/password + Google)
- Cloud Firestore (per-user data)
- Firebase Hosting

## Project Structure

- `index.html` — app shell: auth screen, sidebar navigation, dashboard/habits/calendar/analytics/achievements/settings views, modals
- `style.css` — design system (CSS variables, light/dark themes, cards, responsive layout)
- `script.js` — auth, realtime Firestore listener, history-based streak engine, rendering, heatmap, analytics, reminders
- `firebase.js` — Firebase app, Auth, and Firestore initialisation
- `firestore.rules` — per-user security rules (`users/{uid}/habits`)
- `firebase.json` — Hosting + Firestore rules deployment config
- `404.html` — hosting fallback page

## Firestore Schema

```text
users/{uid}                      { email, updatedAt }
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

Streaks, rates, XP, badges, and insights are **derived at render time** from `completions` plus the schedule — they are never stored as separate counters that can drift.

Legacy note: the original version stored all habits in a shared top-level `habits` collection with `streak/longest/lastDone` fields and no authentication. The new rules deny that collection; data is per-user under `users/{uid}/habits`.

## Security Rules

`firestore.rules` allows only `request.auth.uid == userId` for `/users/{userId}` and `/users/{userId}/habits/{habitId}`, and denies everything else. Unauthenticated reads/writes are rejected.

## How to Run

Prerequisites: a Firebase project with Authentication (Email/Password + Google) and Firestore enabled.

```powershell
git clone https://github.com/archana-kadaralli/pro-habit-tracker.git
cd pro-habit-tracker
# No dependencies — open index.html directly, or serve it:
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

## What I Learned

- Designing a per-user Firestore schema and enforcing isolation with security rules (not just client-side filtering)
- Deriving streaks/rates from append-only date history instead of mutable counters, including schedule-aware streaks and timezone-safe date keys
- Realtime listeners (`onSnapshot`) with local derived state to minimise reads and avoid full refetches
- Building dashboard UX (heatmap, dependency-free charts, insights) from real user data without fake statistics

## Future Improvements

- Habit archiving/pausing instead of delete-only
- Weekly/monthly email or push summary
- Data export (CSV) of completion history
