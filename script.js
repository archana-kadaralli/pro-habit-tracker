import { db, auth, googleProvider, authPersistenceReady } from "./firebase.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, arrayUnion, arrayRemove, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

/* ================= Utilities ================= */
const $ = (id) => document.getElementById(id);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => toKey(new Date());
const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d, 12, 0, 0); };
const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
const DAY_MS = 86400000;

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function showError(msg) {
  const b = $("globalError");
  if (!msg) { b.hidden = true; b.textContent = ""; return; }
  b.hidden = false; b.textContent = msg;
}

/* ================= Modal focus management ================= */
const FOCUSABLE_SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const modalStack = []; // [{ id, returnEl }] — topmost is last

// Layout-independent focusability check (works in jsdom, refined by checkVisibility in real browsers).
function isFocusable(el) {
  if (!el || el.disabled) return false;
  if (el.hidden || el.closest("[hidden]")) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (typeof el.checkVisibility === "function") {
    try { if (!el.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true })) return false; } catch { /* ignore */ }
  }
  return true;
}
function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE_SEL)].filter(isFocusable);
}
function topModalFrame() {
  for (let i = modalStack.length - 1; i >= 0; i--) {
    const el = $(modalStack[i].id);
    if (el && !el.hidden) return modalStack[i];
  }
  return null;
}
function resolveFocusTarget(el, opts = {}) {
  let first = null;
  if (opts.focus) first = typeof opts.focus === "string" ? el.querySelector(opts.focus) : opts.focus;
  if (!first && opts.focusSelector) first = el.querySelector(opts.focusSelector);
  if (first && isFocusable(first)) return first;
  return focusablesIn(el)[0] || el;
}
// Show a modal, record the element to restore focus to, and move focus into it.
function openModal(id, opts = {}) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  const hasReturn = opts.returnEl != null; // null/undefined → fall back to activeElement
  let frame = modalStack.find((f) => f.id === id);
  if (!frame) {
    const active = document.activeElement;
    const defReturn = active && active !== document.body ? active : null;
    frame = { id, returnEl: hasReturn ? opts.returnEl : defReturn };
    modalStack.push(frame);
  } else if (hasReturn) {
    frame.returnEl = opts.returnEl;
  }
  const target = resolveFocusTarget(el, opts);
  if (target) { try { target.focus(); } catch { /* ignore */ } }
}
// Hide a modal and restore focus to its trigger (or the new topmost modal's first focusable).
function closeModal(id, opts = {}) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  const idx = modalStack.map((f) => f.id).lastIndexOf(id);
  let returnEl = null;
  if (idx > -1) { returnEl = modalStack[idx].returnEl; modalStack.splice(idx, 1); }
  if (opts.skipRestore) return;
  if (returnEl && returnEl.isConnected && isFocusable(returnEl)) {
    try { returnEl.focus(); } catch { /* ignore */ }
    return;
  }
  const top = topModalFrame();
  if (top) {
    const t = $(top.id);
    const f = focusablesIn(t)[0] || t;
    try { f.focus(); } catch { /* ignore */ }
  }
}

let confirmResolve = null;
let habitSnap = null;
function habitSnapshot() {
  return JSON.stringify({
    n: $("fName").value, d: $("fDesc").value, c: $("fCategory").value, i: $("fIcon").value, f: $("fFreq").value,
    days: [...document.querySelectorAll("#daysRow input:checked")].map((x) => x.value).join(","),
    color: pickedColor,
  });
}
function askConfirm(text, okLabel = "Delete") {
  $("confirmText").textContent = text;
  $("confirmOk").textContent = okLabel;
  openModal("confirmModal", { focus: "#confirmOk" });
  return new Promise((res) => { confirmResolve = res; });
}

/* ================= Theme ================= */
const themeStore = localStorage.getItem("pht_theme") || "light";
function applyTheme(mode) {
  const pick = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = pick;
  const label = pick === "dark" ? "Light mode" : "Dark mode";
  const icon = pick === "dark" ? "#i-sun" : "#i-moon";
  for (const id of ["themeToggle", "themeToggleSide"]) {
    const b = $(id);
    if (b) {
      b.innerHTML = `<svg class="ic" aria-hidden="true"><use href="${icon}"/></svg> <span class="tlabel">${label}</span>`;
      b.setAttribute("aria-label", label);
      b.setAttribute("aria-pressed", String(pick === "dark"));
    }
  }
  if ($("themeSelect")) $("themeSelect").value = mode;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(localStorage.getItem("pht_theme") || "light"));

/* ================= Account info (real Firebase user only) ================= */
function accountName(u) { return u?.displayName || u?.email?.split("@")[0] || "Account"; }
function accountInitials(u) {
  const n = u?.displayName?.trim();
  if (n) return n.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const local = (u?.email || "U").split("@")[0];
  return local.slice(0, 2).toUpperCase();
}
function paintAvatar(el, u) {
  if (!el) return;
  el.textContent = accountInitials(u);
  el.querySelector("img")?.remove();
  if (u?.photoURL) {
    const im = document.createElement("img");
    im.className = "user-img";
    im.src = u.photoURL;
    im.alt = "";
    im.referrerPolicy = "no-referrer";
    im.onerror = () => im.remove();
    el.appendChild(im);
  }
  el.setAttribute("title", u?.photoURL ? accountName(u) : accountInitials(u));
}
function renderAccountInfo(u) {
  if (!u) return;
  const name = accountName(u);
  const email = u.email || "\u2014";
  if ($("userName")) $("userName").textContent = name;
  if ($("userEmail")) $("userEmail").textContent = u.email || name;
  paintAvatar($("userAvatar"), u);
  if ($("settingsName")) $("settingsName").textContent = name;
  if ($("settingsEmail")) $("settingsEmail").textContent = email;
  if ($("dataPath")) $("dataPath").textContent = `users/${u.uid}/habits`;
  // account modal
  if ($("acctEmail")) $("acctEmail").textContent = email;
  if ($("acctStatusLine")) $("acctStatusLine").textContent = "Signed in";
  if ($("acctNameInput") && document.activeElement !== $("acctNameInput")) $("acctNameInput").value = u.displayName || "";
  if ($("acctEmailLine")) $("acctEmailLine").textContent = email;
  const pid = u.providerData?.[0]?.providerId || "";
  if ($("acctEmailNote")) {
    const note = $("acctEmailNote");
    if (pid === "google.com") { note.hidden = false; note.textContent = "Your email is managed by your Google account and can't be changed here."; }
    else { note.hidden = false; note.textContent = "Changing your email requires a verification flow that isn't available in this app."; }
  }
  if ($("acctCreatedRow") && $("acctCreated")) {
    const ct = u.metadata?.creationTime;
    if (ct) {
      const d = new Date(ct);
      $("acctCreatedRow").hidden = false;
      $("acctCreated").textContent = Number.isNaN(d.getTime()) ? ct : d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } else $("acctCreatedRow").hidden = true;
  }
  if ($("acctTheme")) {
    const t = document.documentElement.dataset.theme || "light";
    $("acctTheme").textContent = t === "dark" ? "Dark" : "Light";
  }
  if ($("acctProvider")) $("acctProvider").textContent = pid === "google.com" ? "Google" : pid === "password" ? "Email & password" : pid || "\u2014";
  if ($("acctPath")) $("acctPath").textContent = `users/${u.uid}`;
  paintAvatar($("acctAvatar"), u);
}
let acctSaving = false;
async function saveProfileName(e) {
  e?.preventDefault();
  if (acctSaving || !user) return;
  const input = $("acctNameInput"), err = $("acctNameErr"), okMsg = $("acctNameOk");
  const value = input.value.trim().replace(/\s+/g, " ");
  err.hidden = true; okMsg.hidden = true; input.removeAttribute("aria-invalid");
  if (value.length > 50) { err.textContent = "Name must be 50 characters or fewer."; err.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
  if (!value) { err.textContent = "Please enter a name."; err.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
  if (value === (user.displayName || "")) { err.textContent = "Enter a new name to save."; err.hidden = false; input.setAttribute("aria-invalid", "true"); input.focus(); return; }
  acctSaving = true;
  const btn = $("acctSaveBtn");
  btn.disabled = true; btn.classList.add("loading");
  try {
    await updateProfile(user, { displayName: value || null });
    renderAccountInfo(user);
    okMsg.textContent = "Profile updated.";
    okMsg.hidden = false;
    toast("Profile updated.", "ok");
  } catch (err2) {
    console.error("updateProfile failed", err2?.code || err2?.message || "unknown");
    err.textContent = "Couldn't save your name. Please try again.";
    err.hidden = false;
  } finally {
    acctSaving = false;
    btn.disabled = false; btn.classList.remove("loading");
  }
}
async function confirmLogout() {
  const ok = await askConfirm("Are you sure you want to log out?", "Log out");
  if (!ok) return;
  closeModal("accountModal", { skipRestore: true });
  for (const id of ["logoutBtn", "acctLogoutBtn"]) { const b = $(id); if (b) { b.disabled = true; b.classList.add("loading"); } }
  try {
    await signOut(auth);
    toast("Signed out.");
  } catch (err2) {
    console.error("signOut failed", err2?.code || err2?.message || "unknown");
    toast("Sign-out failed. Please try again.", "err");
  } finally {
    for (const id of ["logoutBtn", "acctLogoutBtn"]) { const b = $(id); if (b) { b.disabled = false; b.classList.remove("loading"); } }
  }
}

/* ================= State ================= */
let user = null;
let habits = [];
let unsub = null;
let activeView = "dashboard";
let detailId = null;
let selectedDay = null;
let _lastRenderedDayKey = null; // local day key the UI was last fully rendered for (stale-tab guard)
let _dataLoaded = false; // this session's habits snapshot has arrived (blocks pre-load renders)
const COLORS = ["#2f6df6", "#0ea5a0", "#8b5cf6", "#e2635f", "#e39a2d", "#3aa655", "#ec6ba8", "#64748b"];
let pickedColor = COLORS[0];

/* ================= Scheduling & streaks (history-derived) ================= */
function habitCreatedKey(h) {
  try {
    if (h.createdAt?.toDate) return toKey(h.createdAt.toDate());
    if (typeof h.createdAt === "string") return h.createdAt.slice(0, 10);
  } catch { /* ignore */ }
  return todayKey();
}
/* ================= Calendar range (account-aware) =================
   The heatmap covers the user's real history from their account creation
   date (Firebase Auth metadata) through today. If that metadata is
   unavailable the range falls back to the earliest habit creation date
   (labelled in the UI), or to the previous 15-week default window when no
   dated history exists at all. Days before real data existed are never
   rendered as completions. */
const HEATMAP_DEFAULT_DAYS = 104; // previous fixed window: 15 weeks including today
function accountCreatedKey() {
  const ct = user?.metadata?.creationTime;
  if (!ct) return null;
  const d = new Date(ct);
  return Number.isNaN(d.getTime()) ? null : toKey(d);
}
function earliestHabitCreatedKey() {
  let min = null;
  for (const h of habits) {
    const raw = h.createdAt;
    let k = null;
    if (raw?.toDate) { try { k = toKey(raw.toDate()); } catch { k = null; } }
    else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) k = raw.slice(0, 10);
    if (k && (!min || k < min)) min = k;
  }
  return min;
}
function heatmapRange() {
  const today = todayKey();
  const acct = accountCreatedKey();
  if (acct) return { startKey: acct > today ? today : acct, source: "account" };
  const habit = earliestHabitCreatedKey();
  if (habit) return { startKey: habit > today ? today : habit, source: "habits" };
  return { startKey: toKey(addDays(new Date(), -HEATMAP_DEFAULT_DAYS)), source: "default" };
}
function isScheduled(h, key) {
  const t = h.frequency?.type || "daily";
  if (t === "daily") return true;
  const dow = parseKey(key).getDay(); // 0 Sun
  if (t === "weekdays") return dow >= 1 && dow <= 5;
  if (t === "custom") {
    const days = h.frequency?.days ?? [1, 2, 3, 4, 5];
    return days.includes(dow);
  }
  return true;
}
function scheduledKeys(h, fromKey, toKeyStr) {
  const out = [];
  let d = parseKey(fromKey);
  const end = parseKey(toKeyStr);
  while (d <= end) { const k = toKey(d); if (isScheduled(h, k)) out.push(k); d = addDays(d, 1); }
  return out;
}
const doneOn = (h, k) => (h.completions || []).includes(k); // canonical completion predicate
// Re-derive every date-dependent view when the local day changed since the
// last full render (e.g. a backgrounded/suspended tab whose midnight timer
// was throttled). Without this, one view can re-render for the new day while
// another still shows the previous day's completion state.
function syncDay() {
  const k = todayKey();
  if (k === _lastRenderedDayKey) return false;
  _lastRenderedDayKey = k; // set before re-render so nested renderers no-op
  if (user && _dataLoaded) renderAll();
  return true;
}
function calcHabitStats(h, asOf = todayKey()) {
  const done = new Set(h.completions || []);
  const created = habitCreatedKey(h);
  const sched = scheduledKeys(h, created <= asOf ? created : asOf, asOf);
  let completed = 0, missed = 0;
  for (const k of sched) { if (done.has(k)) completed++; else if (k !== asOf) missed++; }
  // current streak: trailing scheduled days ending today/yesterday that are done
  let current = 0;
  const rev = [...sched].reverse();
  // if today is scheduled but not done yet, streak is measured up to yesterday (not broken yet)
  let startIdx = 0;
  if (rev.length && rev[0] === asOf && !done.has(asOf)) startIdx = 1;
  for (let i = startIdx; i < rev.length; i++) {
    if (done.has(rev[i])) current++;
    else break;
  }
  // longest streak over full history
  let longest = 0, run = 0;
  for (const k of sched) { if (done.has(k)) { run++; longest = Math.max(longest, run); } else run = 0; }
  const rate = sched.length ? Math.round((completed / sched.length) * 100) : 0;
  return { total: (h.completions || []).length, completed, missed, current, longest, rate, scheduledTotal: sched.length, doneToday: done.has(asOf) };
}
function accountStats(asOf = todayKey()) {
  const per = habits.map((h) => ({ h, s: calcHabitStats(h, asOf) }));
  const totalDone = per.reduce((a, p) => a + p.s.total, 0);
  const best = per.reduce((m, p) => (!m || p.s.longest > m.s.longest ? p : m), null);
  const todayDone = per.filter((p) => p.s.doneToday).length;
  const schedToday = per.filter((p) => isScheduled(p.h, asOf)).length;
  const weekKeys = [...Array(7)].map((_, i) => toKey(addDays(new Date(), i - 6)));
  const weekDone = weekKeys.reduce((a, k) => a + habits.reduce((x, h) => x + (doneOn(h, k) ? 1 : 0), 0), 0);
  const weekSched = weekKeys.reduce((a, k) => a + habits.reduce((x, h) => x + (isScheduled(h, k) ? 1 : 0), 0), 0);
  return { per, totalDone, best, todayDone, schedToday, weekRate: weekSched ? Math.round((weekDone / weekSched) * 100) : 0 };
}
function xpFor(stats) {
  let xp = stats.totalDone * 10;
  for (const p of stats.per) {
    if (p.s.longest >= 30) xp += 150;
    else if (p.s.longest >= 14) xp += 80;
    else if (p.s.longest >= 7) xp += 40;
  }
  return xp;
}
const levelFor = (xp) => ({ level: Math.floor(xp / 200) + 1, into: xp % 200 });
function milestones(stats) {
  const anyStreak = Math.max(0, ...stats.per.map((p) => p.s.longest));
  const total = stats.totalDone;
  const defs = [
    { id: "s7", name: "7-day streak", desc: "Reach a 7-day streak on any habit", ok: anyStreak >= 7, progress: `${Math.min(anyStreak, 7)}/7 days`, pct: Math.min(100, Math.round((anyStreak / 7) * 100)) },
    { id: "s14", name: "14-day streak", desc: "Reach a 14-day streak on any habit", ok: anyStreak >= 14, progress: `${Math.min(anyStreak, 14)}/14 days`, pct: Math.min(100, Math.round((anyStreak / 14) * 100)) },
    { id: "s30", name: "30-day streak", desc: "Reach a 30-day streak on any habit", ok: anyStreak >= 30, progress: `${Math.min(anyStreak, 30)}/30 days`, pct: Math.min(100, Math.round((anyStreak / 30) * 100)) },
    { id: "c50", name: "50 completions", desc: "Complete habits 50 times in total", ok: total >= 50, progress: `${Math.min(total, 50)}/50`, pct: Math.min(100, Math.round((total / 50) * 100)) },
    { id: "c100", name: "100 completions", desc: "Complete habits 100 times in total", ok: total >= 100, progress: `${Math.min(total, 100)}/100`, pct: Math.min(100, Math.round((total / 100) * 100)) },
    { id: "week", name: "Strong week", desc: "Reach 80%+ completion over the last 7 days", ok: stats.weekRate >= 80 && stats.per.length > 0, progress: `${stats.weekRate}% of 80% target`, pct: Math.min(100, Math.round((stats.weekRate / 80) * 100)) },
  ];
  return defs;
}
function buildInsights() {
  const out = [];
  if (!habits.length) return ["Add your first habit to start building insights."];
  const st = accountStats();
  if (st.best) out.push(`Longest streak: ${st.best.h.name} at ${st.best.s.longest} day${st.best.s.longest === 1 ? "" : "s"}.`);
  const cats = {};
  for (const p of st.per) { (cats[p.h.category] ||= { done: 0, sched: 0 }); cats[p.h.category].done += p.s.completed; cats[p.h.category].sched += p.s.scheduledTotal; }
  let topCat = null, topRate = -1;
  for (const [c, v] of Object.entries(cats)) { const r = v.sched ? v.done / v.sched : 0; if (r > topRate) { topRate = r; topCat = c; } }
  if (topCat) out.push(`Most consistent category: ${topCat} (${Math.round(topRate * 100)}%).`);
  const dowCount = [0, 0, 0, 0, 0, 0, 0];
  for (const h of habits) for (const k of (h.completions || [])) dowCount[parseKey(k).getDay()]++;
  const names = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  const bi = dowCount.indexOf(Math.max(...dowCount));
  if (Math.max(...dowCount) > 0) out.push(`You complete most often on ${names[bi]}.`);
  const sorted = [...st.per].sort((a, b) => (b.s.completed / Math.max(1, b.s.scheduledTotal)) - (a.s.completed / Math.max(1, a.s.scheduledTotal)));
  if (sorted.length > 1) out.push(`${sorted[0].h.name} is your most consistent habit; ${sorted[sorted.length - 1].h.name} needs attention.`);
  const wk = st.per.reduce((a, p) => a + (p.h.completions || []).filter((k) => parseKey(k) >= addDays(new Date(), -6)).length, 0);
  out.push(`${wk} completion${wk === 1 ? "" : "s"} in the last 7 days.`);
  return out.slice(0, 5);
}

/* ================= Auth ================= */
let authMode = "login";
function setAuthMode(m) {
  authMode = m;
  $("tabLogin").classList.toggle("active", m === "login");
  $("tabSignup").classList.toggle("active", m === "signup");
  $("tabLogin").setAttribute("aria-selected", String(m === "login"));
  $("tabSignup").setAttribute("aria-selected", String(m === "signup"));
  $("authSubmit").textContent = m === "login" ? "Log in" : "Create account";
  $("authTitle").textContent = m === "login" ? "Welcome back" : "Create your account";
  $("authSub").textContent = m === "login"
    ? "Log in to continue building your streaks."
    : "Start tracking habits on your own private dashboard.";
  $("authPassword").autocomplete = m === "login" ? "current-password" : "new-password";
}
function authErr(msg) { const e = $("authError"); e.hidden = !msg; e.textContent = msg || ""; }
// Human-readable messages for the sign-in failure modes we can actually hit.
function googleErrMsg(err) {
  const code = err?.code || "";
  if (code === "auth/popup-closed-by-user") return "Google sign-in was closed before completing.";
  if (code === "auth/cancelled-popup-request") return "A sign-in attempt is already in progress. Wait for it to finish, then retry.";
  if (code === "auth/popup-blocked") return "Your browser blocked the sign-in popup. Allow popups for this site, or try again (we will switch to a full-page redirect).";
  if (code === "auth/unauthorized-domain") return "This domain is not authorized for Google sign-in. Add it in the Firebase console under Authentication \u2192 Settings \u2192 Authorized domains.";
  if (code === "auth/operation-not-allowed") return "Google sign-in is not enabled for this project. Enable it in the Firebase console under Authentication \u2192 Sign-in method.";
  if (code === "auth/account-exists-with-different-credential") return "An account with this email already exists using a different sign-in method. Log in with email and password instead.";
  if (code === "auth/network-request-failed") return "Network error during Google sign-in. Check your connection and retry.";
  return friendlyErr(err);
}
// If the browser refuses durable auth storage (private mode / blocked or
// evicted IndexedDB), say so where it matters - on the login screen - instead
// of letting users wonder why they must log in again next time. Only shown
// when no other error message occupies the slot.
function noteWeakAuthPersistence() {
  authPersistenceReady.then((mode) => {
    if (mode === "memory" && !user && $("authError") && $("authError").hidden) {
      authErr("Heads-up: this browser can\u2019t keep you signed in between visits (storage blocked or private mode), so you\u2019ll need to log in again next time.");
    }
  }).catch(() => {});
}

/* ================= Firestore paths ================= */
const habitsCol = () => collection(db, "users", user.uid, "habits");
const habitDoc = (id) => doc(db, "users", user.uid, "habits", id);

/* ========= Sync status & offline-safe writes =========
   Firestore offline persistence (see firebase.js) queues writes while offline
   and replays them when connectivity returns. An awaited write promise only
   resolves once the backend commits it, so awaiting a write while offline would
   hang the UI. `settleWrite` reports honestly instead: when the device is
   offline it does not wait for a cloud commit, tells the user the change is
   stored on this device, and surfaces any later sync failure. The `#syncChip`
   indicator is driven by online status + the count of in-flight writes, so the
   user can always tell cached-on-device from confirmed-in-cloud. */
const _sync = { el: null, pending: 0, offline: typeof navigator !== "undefined" && navigator.onLine === false };
function paintSyncChip() {
  const el = _sync.el || (_sync.el = $("syncChip"));
  if (!el) return;
  let text = "Synced", cls = "sync-chip ok";
  if (_sync.offline) { text = "Offline — changes stay on this device"; cls = "sync-chip warn"; }
  else if (_sync.pending > 0) { text = "Syncing…"; cls = "sync-chip busy"; }
  el.className = cls;
  el.textContent = text;
  el.hidden = false;
}
function noteOnline() {
  const off = typeof navigator !== "undefined" && navigator.onLine === false;
  if (off !== _sync.offline) { _sync.offline = off; paintSyncChip(); }
}
if (typeof window !== "undefined") {
  window.addEventListener("online", noteOnline);
  window.addEventListener("offline", noteOnline);
}
async function settleWrite(promise, offlineMsg) {
  _sync.pending++; paintSyncChip();
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // Offline: don't await (would hang). The local change is already applied
    // via latency compensation; Firestore will sync it later. Be honest now,
    // and surface any later failure loudly.
    toast(offlineMsg);
    promise
      .then(() => { _sync.pending = Math.max(0, _sync.pending - 1); paintSyncChip(); })
      .catch((err) => {
        console.error(err);
        _sync.pending = Math.max(0, _sync.pending - 1); paintSyncChip();
        toast("A change saved on this device couldn't sync. " + friendlyErr(err), "err");
      });
    return false; // stored on this device, not yet confirmed by the server
  }
  try {
    await promise; // resolves only once the backend commits it
    return true; // confirmed in the cloud
  } finally {
    _sync.pending = Math.max(0, _sync.pending - 1); paintSyncChip();
  }
}

/* ================= CRUD ================= */
let habitSaving = false;
async function saveHabit(e) {
  e?.preventDefault();
  if (habitSaving) return;
  const name = $("fName").value.trim();
  if (name.length < 2) { formErr("Give your habit a name (2+ characters)."); return; }
  const freqType = $("fFreq").value;
  const days = [...document.querySelectorAll("#daysRow input:checked")].map((c) => Number(c.value));
  if (freqType === "custom" && !days.length) { formErr("Pick at least one weekday for a custom schedule."); return; }
  const id = $("habitId").value || null;
  const payload = {
    name: name.slice(0, 60),
    description: $("fDesc").value.trim().slice(0, 240),
    category: $("fCategory").value,
    icon: $("fIcon").value,
    color: pickedColor,
    frequency: { type: freqType, days: freqType === "custom" ? days : freqType === "weekdays" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6] },
    archived: false,
    updatedAt: serverTimestamp(),
  };
  try {
    habitSaving = true;
    $("saveHabitBtn").disabled = true;
    $("saveHabitBtn").classList.add("loading");
    const OFF = "Saved on this device — it will sync when you're back online.";
    if (id) {
      const committed = await settleWrite(updateDoc(habitDoc(id), payload), OFF);
      if (committed) toast("Habit updated.");
    } else {
      const committed = await settleWrite(
        addDoc(habitsCol(), { ...payload, completions: [], createdAt: serverTimestamp() }), OFF);
      // ensure profile doc exists (best-effort; non-blocking if offline)
      const prof = setDoc(doc(db, "users", user.uid), { email: user.email || "", updatedAt: serverTimestamp() }, { merge: true });
      if (typeof navigator !== "undefined" && navigator.onLine === false) prof.catch(() => {});
      else { try { await prof; } catch { /* non-critical */ } }
      if (committed) toast("Habit created. Good luck!", "ok");
    }
    closeHabitModal(true);
  } catch (err) { console.error(err); formErr(friendlyErr(err)); }
  finally { habitSaving = false; $("saveHabitBtn").disabled = false; $("saveHabitBtn").classList.remove("loading"); }
}
function formErr(m) { const e = $("formError"); e.hidden = !m; e.textContent = m || ""; }
async function toggleDone(id, dateKey = todayKey()) {
  const h = habits.find((x) => x.id === id);
  if (!h) return;
  if (!isScheduled(h, dateKey)) { toast("This habit isn't scheduled for that day."); return; }
  const has = doneOn(h, dateKey);
  try {
    const committed = await settleWrite(updateDoc(habitDoc(id), {
      completions: has ? arrayRemove(dateKey) : arrayUnion(dateKey),
      updatedAt: serverTimestamp(),
    }), "Saved on this device — it will sync when you're back online.");
    if (committed && !has && dateKey === todayKey()) toast(`"${h.name}" completed!`, "ok");
  } catch (err) { console.error(err); toast(friendlyErr(err), "err"); }
}
async function removeHabit(id) {
  const h = habits.find((x) => x.id === id);
  const ok = await askConfirm(`Delete "${h?.name ?? "this habit"}" and its full history? This cannot be undone.`);
  if (!ok) return;
  try {
    const committed = await settleWrite(deleteDoc(habitDoc(id)), "Deleted on this device — it will sync when you're back online.");
    if (committed) toast("Habit deleted.");
    if (detailId === id) closeDetail();
  }
  catch (err) { console.error(err); toast(friendlyErr(err), "err"); }
}
function friendlyErr(err) {
  const code = err?.code || "";
  if (code.includes("permission-denied")) return "Permission denied. Please sign in again.";
  if (code.includes("unavailable") || code.includes("network")) return "Network error. Check your connection and retry.";
  if (code.includes("auth/")) return code.replace("auth/", "").replace(/-/g, " ");
  return "Something went wrong. Please try again.";
}

/* ================= Rendering ================= */
function habitCardHTML(h, s) {
  const sched = isScheduled(h, todayKey());
  const statusCls = s.doneToday ? "status-done" : sched ? "status-todo" : "status-off";
  const statusTxt = s.doneToday ? "Done today" : sched ? "To do today" : "Not scheduled today";
  return `<article class="habit-card" data-open="${h.id}" style="--hc:${esc(h.color || "#2563eb")}">
    <div class="habit-card-top">
      <span class="habit-dot" style="background:${esc(h.color || "#2563eb")}" aria-hidden="true">${esc(h.icon || "◉")}</span>
      <div class="habit-meta">
        <button class="habit-name-btn" type="button" data-open="${h.id}">${esc(h.name)}</button>
        <span class="habit-sub">${esc(h.category || "Other")}<span class="dot-sep"></span>${esc(h.frequency?.type === "weekdays" ? "Weekdays" : h.frequency?.type === "custom" ? "Custom" : "Every day")}</span>
      </div>
      <span class="streak-chip ${s.current === 0 ? "zero" : ""}"><svg class="ic" aria-hidden="true"><use href="#i-flame"/></svg>${s.current}d</span>
    </div>
    <div class="status-line"><span class="${statusCls}">${statusTxt}</span><span class="num">${s.rate}%</span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${s.rate}" aria-label="${esc(h.name)} completion rate"><div class="progress-fill" style="width:${s.rate}%"></div></div>
    <div class="rate-line"><span>${s.total} completions</span><span>Best ${s.longest}d</span></div>
    <div class="habit-actions">
      <button class="act-btn ${s.doneToday ? "is-done" : "complete"}" data-toggle="${h.id}" aria-pressed="${s.doneToday}" aria-label="${s.doneToday ? "Undo" : "Mark"} ${esc(h.name)} ${s.doneToday ? "today" : "done"}" type="button">
        <svg class="ic" aria-hidden="true"><use href="#i-check"/></svg>${s.doneToday ? "Done" : "Mark done"}
      </button>
      <button class="act-btn" data-edit="${h.id}" aria-label="Edit ${esc(h.name)}" title="Edit" type="button"><svg class="ic" aria-hidden="true"><use href="#i-pencil"/></svg></button>
      <button class="act-btn danger" data-del="${h.id}" aria-label="Delete ${esc(h.name)}" title="Delete" type="button"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button>
    </div>
  </article>`;
}
const emptyState = (icon, title, body, cta) =>
  `<div class="empty in-card"><span class="empty-ic"><svg class="ic"><use href="#${icon}"/></svg></span><h3>${esc(title)}</h3><p>${esc(body)}</p>${cta ? `<button class="btn primary" data-add-habit type="button"><svg class="ic ic-sm"><use href="#i-plus"/></svg> ${esc(cta)}</button>` : ""}</div>`;
function renderAll() {
  if (!user) return;
  showError(null);
  _lastRenderedDayKey = todayKey(); // this pass renders the current local day
  renderDashboard(); renderHabitsView(); renderHeatmap(); renderAnalytics(); renderAchievements(); renderSettingsMeta(); renderCycle(); renderActivity();
  if (detailId) renderDetailBody();
}
function renderDashboard() {
  if (syncDay()) return;
  const hr = new Date().getHours();
  $("greeting").textContent = `${hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}${user ? ", " + accountName(user) : ""}`;
  $("dateLine").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const st = accountStats();
  const cards = [
    { k: "Today", v: `${st.todayDone}/${st.schedToday}`, s: "completed", i: "i-check-c" },
    { k: "Week rate", v: `${st.weekRate}%`, s: "last 7 days", i: "i-chart" },
    { k: "Best streak", v: st.best ? `${st.best.s.longest}d` : "—", s: st.best ? st.best.h.name : "no data yet", i: "i-flame" },
    { k: "Total done", v: String(st.totalDone), s: "all time", i: "i-award" },
  ];
  $("statCards").innerHTML = cards.map((c) => `<div class="stat">
    <span class="stat-ic" aria-hidden="true"><svg class="ic"><use href="#${c.i}"/></svg></span>
    <div class="k">${c.k}</div><div class="v">${esc(c.v)}</div><div class="s">${esc(c.s)}</div>
  </div>`).join("");
  const pct = st.schedToday ? Math.round((st.todayDone / st.schedToday) * 100) : 0;
  $("todayCount").textContent = `${st.todayDone}/${st.schedToday}`;
  $("todaySub").textContent = st.schedToday
    ? `${st.todayDone} of ${st.schedToday} scheduled habits complete`
    : "No habits scheduled today";
  $("todayProgress").style.width = `${pct}%`;
  $("todayProgress").parentElement.setAttribute("aria-valuenow", String(pct));
  const rail = $("todayProgress").parentElement;
  if (st.schedToday) {
    rail.dataset.segs = String(st.schedToday);
    rail.style.setProperty("--segs", String(st.schedToday));
  } else {
    delete rail.dataset.segs;
    rail.style.removeProperty("--segs");
  }
  const todays = habits.filter((h) => isScheduled(h, todayKey()));
  $("todayList").innerHTML = todays.length ? todays.map((h) => {
    const s = calcHabitStats(h);
    return `<div class="habit-row ${s.doneToday ? "done" : ""}">
      <button class="check-btn" data-toggle="${h.id}" aria-pressed="${s.doneToday}" aria-label="${s.doneToday ? "Undo" : "Complete"} ${esc(h.name)} today" type="button"><svg class="ic" aria-hidden="true"><use href="#i-check"/></svg></button>
      <span class="habit-dot" style="background:${esc(h.color)}" aria-hidden="true">${esc(h.icon)}</span>
      <div class="habit-meta">
        <button class="habit-name-btn" type="button" data-open="${h.id}">${esc(h.name)}</button>
        <span class="habit-sub">${esc(h.category)}<span class="dot-sep"></span>${s.total} total</span>
      </div>
      <span class="streak-chip ${s.current === 0 ? "zero" : ""}"><svg class="ic" aria-hidden="true"><use href="#i-flame"/></svg>${s.current}d</span>
    </div>`;
  }).join("") : habits.length === 0
    ? emptyState("i-list", "Create your first habit", "Track something small today — streaks and insights build from there.", "New habit")
    : emptyState("i-cal", "Nothing scheduled today", "Enjoy the rest of your day, or add another habit to your schedule.", "New habit");
  // week strip: done/scheduled per day
  $("weekStrip").innerHTML = [...Array(7)].map((_, i) => {
    const d = addDays(new Date(), i - 3);
    const k = toKey(d);
    const done = habits.reduce((a, h) => a + (doneOn(h, k) ? 1 : 0), 0);
    const sched = habits.reduce((a, h) => a + (isScheduled(h, k) ? 1 : 0), 0);
    const cls = sched && done === sched ? "all-done" : done > 0 ? "some" : "";
    return `<div class="day-cell ${k === todayKey() ? "today" : ""}" title="${k}: ${done}/${sched} completed">
      <span class="dw">${d.toLocaleDateString(undefined, { weekday: "short" })}</span>
      <span class="dn">${d.getDate()}</span>
      <span class="dr ${cls}">${sched ? `${done}/${sched}` : "—"}</span>
    </div>`;
  }).join("");
  $("insightsList").innerHTML = buildInsights().map((t) => `<li>${esc(t)}</li>`).join("");
  const xp = xpFor(st), lv = levelFor(xp);
  $("levelMini").textContent = `Level ${lv.level} · ${xp} XP (${lv.into}/200 to next level)`;
}
function filteredHabits() {
  const q = ($("searchInput").value || "").toLowerCase();
  const cat = $("filterCategory").value, status = $("filterStatus").value, sort = $("sortBy").value;
  let list = habits.map((h) => ({ h, s: calcHabitStats(h) }));
  if (q) list = list.filter((p) => (p.h.name + " " + (p.h.description || "")).toLowerCase().includes(q));
  if (cat) list = list.filter((p) => p.h.category === cat);
  if (status === "done") list = list.filter((p) => p.s.doneToday);
  if (status === "todo") list = list.filter((p) => !p.s.doneToday);
  const by = {
    name: (a, b) => a.h.name.localeCompare(b.h.name),
    streak: (a, b) => b.s.current - a.s.current,
    rate: (a, b) => b.s.rate - a.s.rate,
    newest: (a, b) => (b.h.createdAt?.seconds || 0) - (a.h.createdAt?.seconds || 0),
  }[sort];
  return list.sort(by);
}
function renderHabitsView() {
  if (syncDay()) return;
  const list = filteredHabits();
  $("habitCount").textContent = list.length === habits.length ? String(habits.length) : `${list.length} of ${habits.length}`;
  $("allHabits").innerHTML = list.length ? list.map((p) => habitCardHTML(p.h, p.s)).join("")
    : habits.length === 0
      ? emptyState("i-list", "No habits yet", "Create your first habit — give it a schedule and the streak engine does the rest.", "New habit")
      : emptyState("i-search", "No habits match", "Try clearing the search or filters to see all of your habits.");
}
let hmGen = 0; // invalidates in-flight progressive fills when a newer render starts
const HM_SYNC_WEEKS = 104;  // <= 2 years of history renders in one pass
const HM_CHUNK_WEEKS = 26;  // older history fills in ~half-year steps, one frame each
const hmSchedule = (cb) => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 16);
};
function pinHeatmapScroll() {
  const sc = document.querySelector(".hm-scroll");
  if (sc && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
}
function renderHeatmap() {
  if (syncDay()) return;
  const gen = ++hmGen;
  const sel = $("heatmapHabit").value || "__all";
  const prev = sel;
  $("heatmapHabit").innerHTML = `<option value="__all">All habits</option>` + habits.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if ([...$("heatmapHabit").options].some((o) => o.value === prev)) $("heatmapHabit").value = prev;
  const focus = $("heatmapHabit").value;
  const counts = {};
  const list = focus === "__all" ? habits : habits.filter((h) => h.id === focus);
  for (const h of list) for (const k of (h.completions || [])) counts[k] = (counts[k] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  const range = heatmapRange();
  const start = parseKey(range.startKey);
  const end = parseKey(todayKey()); // today at local noon - the walk below is noon-anchored
  const d0 = addDays(start, -((start.getDay() + 6) % 7)); // Monday-align week rows
  if ($("heatmapSub")) {
    const fmt = (k) => parseKey(k).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    $("heatmapSub").textContent = range.source === "account"
      ? `Every day since your account was created (${fmt(range.startKey)}) \u2014 real completions only.`
      : range.source === "habits"
        ? `Account creation date unavailable \u2014 showing history from your earliest habit (${fmt(range.startKey)}).`
        : `No dated history yet \u2014 showing the last 15 weeks.`;
  }
  const weeks = [];
  let wk = null;
  for (let d = new Date(d0); d <= end; d = addDays(d, 1)) {
    const dow = (d.getDay() + 6) % 7;
    if (!wk || dow === 0) {
      const m = d.toLocaleDateString(undefined, { month: "short" });
      wk = { cells: [], month: m, label: weeks.length === 0 || m !== weeks[weeks.length - 1].month ? m : "" };
      weeks.push(wk);
    }
    const k = toKey(d);
    if (k < range.startKey) { wk.cells.push(`<span class="hm-cell hm-ph" aria-hidden="true"></span>`); continue; }
    const c = counts[k] || 0;
    const lvl = c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4));
    wk.cells.push(`<button class="hm-cell ${selectedDay === k ? "sel" : ""}" data-l="${lvl}" data-day="${k}" role="gridcell" aria-label="${k}: ${c} completion${c === 1 ? "" : "s"}" title="${k}: ${c} completion${c === 1 ? "" : "s"}"></button>`);
  }
  const secHTML = (sec) => sec.map((w) => w.cells.join("")).join("");
  const secMonths = (sec) => sec.map((w) => `<span>${w.label}</span>`).join("");
  if (weeks.length <= HM_SYNC_WEEKS) {
    $("heatmap").innerHTML = secHTML(weeks);
    $("hmMonths").innerHTML = secMonths(weeks);
    pinHeatmapScroll();
  } else {
    // Long histories: paint the newest chunk first, then prepend older chunks
    // frame by frame. Every day is still rendered (nothing is silently
    // omitted) but the main thread is never blocked by one huge insert.
    const sections = [];
    for (let i = 0; i < weeks.length; i += HM_CHUNK_WEEKS) sections.push(weeks.slice(i, i + HM_CHUNK_WEEKS));
    const newest = sections.pop();
    $("heatmap").innerHTML = secHTML(newest);
    $("hmMonths").innerHTML = secMonths(newest);
    pinHeatmapScroll();
    const queue = sections.reverse();
    const step = () => {
      if (gen !== hmGen) return; // superseded by a newer render
      const sec = queue.shift();
      if (!sec) return;
      const sc = document.querySelector(".hm-scroll");
      const before = sc ? sc.scrollWidth : 0;
      $("heatmap").insertAdjacentHTML("afterbegin", secHTML(sec));
      $("hmMonths").insertAdjacentHTML("afterbegin", secMonths(sec));
      if (sc) sc.scrollLeft += sc.scrollWidth - before; // keep the view anchored
      hmSchedule(step);
    };
    hmSchedule(step);
  }
  renderDayDetail();
}
function renderDayDetail() {
  const box = $("dayDetail");
  if (!selectedDay) { box.innerHTML = `<p class="muted">Click a day above to see which habits were completed.</p>`; return; }
  const items = habits.filter((h) => doneOn(h, selectedDay));
  const missed = calcMissed(selectedDay);
  const dLabel = parseKey(selectedDay).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  box.innerHTML = `<div class="dd-title">${esc(dLabel)}<span class="pill ${items.length ? "success" : ""}">${items.length} completion${items.length === 1 ? "" : "s"}</span></div>` +
    (items.length
      ? `<div class="day-chips">${items.map((h) => `<span class="day-chip"><span class="habit-dot" style="background:${esc(h.color)}" aria-hidden="true">${esc(h.icon)}</span>${esc(h.name)} <span class="muted">${esc(h.category)}</span></span>`).join("")}</div>`
      : `<p class="muted">${missed ? `No completions — ${missed} scheduled habit${missed === 1 ? " was" : "s were"} missed.` : "No completions were scheduled for this day."}</p>`);
}
function calcMissed(key) { return habits.filter((h) => isScheduled(h, key) && !doneOn(h, key) && key !== todayKey()).length; }
function renderAnalytics() {
  const st = accountStats();
  const cards = [
    { k: "7-day rate", v: `${st.weekRate}%`, i: "i-chart" },
    { k: "Today", v: `${st.todayDone}/${st.schedToday}`, i: "i-check-c" },
    { k: "Current best", v: st.best ? `${st.best.s.current}d` : "—", i: "i-flame" },
    { k: "Longest ever", v: st.best ? `${st.best.s.longest}d` : "—", i: "i-trophy" },
  ];
  $("analyticsStats").innerHTML = cards.map((c) => `<div class="stat">
    <span class="stat-ic" aria-hidden="true"><svg class="ic"><use href="#${c.i}"/></svg></span>
    <div class="k">${c.k}</div><div class="v">${esc(c.v)}</div>
  </div>`).join("");
  // last 7 days bars (absolute completions)
  const wk = [...Array(7)].map((_, i) => { const d = addDays(new Date(), i - 6); return { k: toKey(d), label: d.toLocaleDateString(undefined, { weekday: "short" }), n: habits.reduce((a, h) => a + (doneOn(h, toKey(d)) ? 1 : 0), 0) }; });
  const wmax = Math.max(1, ...wk.map((x) => x.n));
  $("chartWeek").innerHTML = wk.map((x) => `<div class="bar" title="${x.label}: ${x.n} completion${x.n === 1 ? "" : "s"}">
    <span class="bar-plot"><i style="height:${Math.max(3, (x.n / wmax) * 110)}px"></i></span>
    <span class="bar-v">${x.n}</span><span class="bar-l">${x.label}</span>
  </div>`).join("");
  const wTotal = wk.reduce((a, x) => a + x.n, 0);
  const bestDay = wk.reduce((m, x) => (x.n > m.n ? x : m), wk[0]);
  $("chartWeekNote").textContent = wTotal
    ? `${wTotal} completions in the last 7 days · strongest day: ${bestDay.label} (${bestDay.n})`
    : "No completions recorded in the last 7 days.";
  // last 30 days in 6 buckets of 5 days
  const buckets = [...Array(6)].map((_, b) => {
    const from = addDays(new Date(), -(29 - b * 5) - 4), to = addDays(new Date(), -(29 - b * 5));
    let n = 0; for (let d = new Date(from); d <= to; d = addDays(d, 1)) n += habits.reduce((a, h) => a + (doneOn(h, toKey(d)) ? 1 : 0), 0);
    return { label: `${to.getDate()}/${to.getMonth() + 1}`, n };
  });
  const bmax = Math.max(1, ...buckets.map((x) => x.n));
  $("chartMonth").innerHTML = buckets.map((x) => `<div class="bar" title="Period ending ${x.label}: ${x.n} completions">
    <span class="bar-plot"><i style="height:${Math.max(3, (x.n / bmax) * 110)}px"></i></span>
    <span class="bar-v">${x.n}</span><span class="bar-l">${x.label}</span>
  </div>`).join("");
  const bTotal = buckets.reduce((a, x) => a + x.n, 0);
  $("chartMonthNote").textContent = bTotal
    ? `${bTotal} completions across the last 30 days`
    : "No completions recorded in the last 30 days.";
  const per = [...st.per].sort((a, b) => b.s.rate - a.s.rate).slice(0, 6);
  $("chartHabits").innerHTML = per.length ? per.map((p, i) => `<div class="hbar">
    <span class="hb-label ${i === 0 ? "best" : ""}" title="${esc(p.h.name)}">${esc(p.h.name.slice(0, 28))}</span>
    <div class="track"><div class="fill" style="width:${p.s.rate}%"></div></div><b>${p.s.rate}%</b>
  </div>`).join("") : `<p class="muted">No habits yet — add one to see consistency.</p>`;
  const cats = {};
  for (const p of st.per) { (cats[p.h.category] ||= { d: 0, s: 0 }); cats[p.h.category].d += p.s.completed; cats[p.h.category].s += p.s.scheduledTotal; }
  const rows = Object.entries(cats).map(([c, v]) => ({ c, r: v.s ? Math.round((v.d / v.s) * 100) : 0 })).sort((a, b) => b.r - a.r);
  $("chartCategories").innerHTML = rows.length ? rows.map((x, i) => `<div class="hbar">
    <span class="hb-label ${i === 0 ? "best" : ""}">${esc(x.c)}</span>
    <div class="track"><div class="fill" style="width:${x.r}%"></div></div><b>${x.r}%</b>
  </div>`).join("") : `<p class="muted">No data yet.</p>`;
}
function renderAchievements() {
  const st = accountStats();
  const xp = xpFor(st), lv = levelFor(xp);
  $("xpLevel").textContent = String(lv.level);
  $("xpFill").style.width = `${(lv.into / 200) * 100}%`;
  $("xpFill").parentElement.setAttribute("aria-valuenow", String(lv.into));
  $("xpText").textContent = `${xp} XP earned · ${st.totalDone} total completions`;
  $("xpNext").textContent = `${200 - lv.into} XP to Level ${lv.level + 1}`;
  const icons = { s7: "i-flame", s14: "i-flame", s30: "i-flame", c50: "i-target", c100: "i-target", week: "i-cal" };
  $("badges").innerHTML = milestones(st).map((m) => `
    <div class="badge ${m.ok ? "earned" : "locked"}">
      <span class="badge-ic" aria-hidden="true"><svg class="ic"><use href="#${m.ok ? "i-check-c" : (icons[m.id] || "i-award")}"/></svg></span>
      <div class="badge-body">
        <div class="t">${esc(m.name)}<span class="pill ${m.ok ? "success" : ""}">${m.ok ? "Earned" : "Locked"}</span></div>
        <p class="desc">${esc(m.desc)}</p>
        <div class="prog-line ${m.ok ? "ok" : ""}">${m.ok ? "Completed" : esc(m.progress)}</div>
        <div class="mini-track"><div class="mini-fill" style="width:${m.ok ? 100 : m.pct}%"></div></div>
      </div>
    </div>`).join("");
}
function renderSettingsMeta() {
  renderAccountInfo(user);
  const r = loadReminders();
  $("reminderTime").value = r.time; $("reminderEnabled").checked = r.enabled;
  updateNotifStatus();
}

/* ================= Detail modal ================= */
function renderDetailBody() {
  if (syncDay()) return;
  const h = habits.find((x) => x.id === detailId);
  if (!h) return;
  const s = calcHabitStats(h);
  const recent = [...(h.completions || [])].sort().reverse().slice(0, 12);
  const last35 = [...Array(35)].map((_, i) => toKey(addDays(new Date(), i - 34)));
  const freq = h.frequency?.type || "daily";
  const freqLabel = freq === "weekdays" ? "Weekdays (Mon–Fri)" : freq === "custom" ? "Custom schedule" : "Every day";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const activeDays = freq === "custom" ? (h.frequency?.days || []).map((d) => dayNames[d]).join(" · ") : freq === "weekdays" ? "Mon · Tue · Wed · Thu · Fri" : "All 7 days";
  $("detailTitle").textContent = `${h.icon || ""} ${h.name}`;
  $("detailBody").innerHTML = `
    <div class="detail-meta">
      <span class="pill accent">${esc(h.category || "Other")}</span>
      <span class="pill"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-cal"/></svg> ${freqLabel}</span>
      <span class="pill">Since ${esc(habitCreatedKey(h))}</span>
    </div>
    ${h.description ? `<p class="detail-desc">${esc(h.description)}</p>` : ""}
    <div class="detail-grid">
      <div class="stat"><div class="k">Streak</div><div class="v">${s.current}</div></div>
      <div class="stat"><div class="k">Longest</div><div class="v">${s.longest}</div></div>
      <div class="stat"><div class="k">Rate</div><div class="v">${s.rate}%</div></div>
      <div class="stat"><div class="k">Total</div><div class="v">${s.total}</div></div>
    </div>
    <div class="detail-section">
      <h4>Schedule</h4>
      <p class="small">${esc(activeDays)} · ${s.scheduledTotal} scheduled days since creation · ${s.missed} missed</p>
    </div>
    <div class="detail-section">
      <h4>Last 35 days</h4>
      <div class="hist-grid">${last35.map((k) => {
        const done = doneOn(h, k);
        const sched = isScheduled(h, k);
        const missed = !done && sched && k !== todayKey();
        const cls = done ? "done" : missed ? "missed" : sched ? "sched" : "";
        const state = done ? "completed" : missed ? "missed" : sched ? "not yet completed" : "off-day";
        return `<span class="hist-cell ${cls}" title="${k}: ${state}"></span>`;
      }).join("")}</div>
      <div class="hist-legend">
        <span><i style="background:var(--success);border-color:var(--success)"></i> Completed</span>
        <span><i style="background:var(--danger-soft)"></i> Missed</span>
        <span><i style="background:var(--surface-2)"></i> Scheduled</span>
        <span><i></i> Off-day</span>
      </div>
    </div>
    <div class="detail-section">
      <h4>Recent completions</h4>
      ${recent.length
        ? `<ul class="recent-list">${recent.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>`
        : `<p class="muted small">No completions yet — mark today done to start your streak.</p>`}
    </div>`;
  $("detailToggleBtn").innerHTML = `<svg class="ic ic-sm" aria-hidden="true"><use href="#i-check"/></svg> ${s.doneToday ? "Undo today" : "Mark today done"}`;
}
function openDetail(id, trigger = null) { detailId = id; renderDetailBody(); openModal("detailModal", { focus: "#closeDetailBtn", returnEl: trigger }); }
function closeDetail() { detailId = null; closeModal("detailModal"); }

/* ================= Habit modal ================= */
function paintSwatches() {
  $("colorSwatches").innerHTML = COLORS.map((c) =>
    `<button type="button" class="swatch ${c === pickedColor ? "sel" : ""}" data-color="${c}" style="background:${c}" role="radio" aria-checked="${c === pickedColor}" aria-label="Color ${c}"></button>`).join("");
}
function paintDays() {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  $("daysRow").innerHTML = names.map((n, i) => `<label><input type="checkbox" value="${i}" ${[1, 2, 3, 4, 5].includes(i) ? "checked" : ""}>${n}</label>`).join("");
}
function openHabitModal(h = null, trigger = null) {
  formErr(null);
  $("habitModalTitle").textContent = h ? "Edit habit" : "New habit";
  $("habitId").value = h?.id || "";
  $("fName").value = h?.name || "";
  $("fDesc").value = h?.description || "";
  $("fCategory").value = h?.category || "Health";
  $("fIcon").value = h?.icon || "◉";
  pickedColor = h?.color || COLORS[0];
  $("fFreq").value = h?.frequency?.type || "daily";
  paintSwatches(); paintDays();
  if (h?.frequency?.type === "custom" && h.frequency.days) {
    document.querySelectorAll("#daysRow input").forEach((c) => { c.checked = h.frequency.days.includes(Number(c.value)); });
  }
  $("customDays").hidden = $("fFreq").value !== "custom";
  openModal("habitModal", { focus: "#fName", returnEl: trigger });
  habitSnap = habitSnapshot();
}
async function closeHabitModal(force = false) {
  if (!force && $("habitModal").hidden !== true) {
    if (habitSnap !== null && habitSnapshot() !== habitSnap) {
      const ok = await askConfirm("Discard unsaved changes to this habit?", "Discard");
      if (!ok) return;
    }
  }
  habitSnap = null;
  closeModal("habitModal");
}

/* ================= Cycle Tracker (optional, private, per-user) ================= */
let cycleData = { enabled: false, entries: [], reminder: false, lead: 3 };
const CYC_SYMPTOMS = ["Cramps", "Headache", "Fatigue", "Bloating", "Mood changes", "Other"];
const isKey = (k) => typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k);
const userDocRef = () => doc(db, "users", user.uid);
function sanitizeCycle(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries
    .filter((e) => e && isKey(e.start))
    .map((e) => ({
      id: String(e.id || e.start),
      start: e.start,
      end: isKey(e.end || "") ? e.end : null,
      symptoms: Array.isArray(e.symptoms) ? e.symptoms.filter((s) => CYC_SYMPTOMS.includes(s)) : [],
      note: typeof e.note === "string" ? e.note.slice(0, 200) : "",
    }))
    .sort((a, b) => b.start.localeCompare(a.start))
  : [];
  const leadRaw = Number(raw?.lead);
  const lead = Number.isFinite(leadRaw) ? Math.min(14, Math.max(0, Math.round(leadRaw))) : 3;
  return { enabled: !!raw?.enabled, entries, reminder: !!raw?.reminder, lead };
}
async function loadCycle() {
  if (!user) return;
  try {
    // With offline persistence enabled, getDoc returns the cached doc when
    // offline (it only errors if the doc was never cached on this device).
    const snap = await getDoc(userDocRef());
    cycleData = sanitizeCycle(snap.exists() ? snap.data()?.cycle : null);
  } catch { cycleData = { enabled: false, entries: [], reminder: false, lead: 3 }; }
  renderCycle();
}
async function saveCycle() {
  if (!user) return "failed";
  const p = setDoc(userDocRef(), { cycle: cycleData, updatedAt: serverTimestamp() }, { merge: true });
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    // Offline: latency compensation already applied the local change. Keep it
    // and let Firestore sync it when connectivity returns (don't hang the UI
    // or make callers revert). Surface any later failure loudly. No custom
    // queue is introduced — Firestore's own offline queue persists the write.
    p.catch((err) => { console.error(err); toast("Cycle changes couldn't sync. " + friendlyErr(err), "err"); });
    return "queued"; // accepted on this device, not yet confirmed on the backend
  }
  try { await p; return "synced"; }
  catch { toast("Couldn't save cycle data. Please try again.", "err"); return "failed"; }
}
// Accurate wording suffix for a write accepted while offline: it is stored on
// this device and queued, not yet confirmed in the cloud. Empty when synced so
// online saves keep their original, accurate wording.
const cycleOfflineNote = (status) => status === "queued" ? " (saved on this device \u2014 it will sync when you're back online)" : "";
function cycleDaySpan(a, b) { return Math.max(1, Math.round((parseKey(b) - parseKey(a)) / DAY_MS) + 1); }
function cycleStats() {
  const starts = cycleData.entries.map((e) => e.start).sort();
  const deltas = [];
  for (let i = 1; i < starts.length; i++) {
    const d = Math.round((parseKey(starts[i]) - parseKey(starts[i - 1])) / DAY_MS);
    if (d >= 15 && d <= 60) deltas.push(d);
  }
  const avg = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;
  const last = starts.length ? starts[starts.length - 1] : null;
  let next = null, nextEnd = null;
  if (avg && deltas.length >= 2 && last) {
    const nd = addDays(parseKey(last), avg);
    next = toKey(nd);
    nextEnd = toKey(addDays(nd, 2));
  }
  return { count: cycleData.entries.length, last, avg, deltas: deltas.length, next, nextEnd };
}
function renderCycle() {
  if (!$("cycleDisabled")) return;
  $("cycleDisabled").hidden = cycleData.enabled;
  $("cyclePanel").hidden = !cycleData.enabled;
  if (!cycleData.enabled) return;
  const st = cycleStats();
  $("cycLast").textContent = st.last || "\u2014";
  $("cycLastSub").textContent = st.last ? "Most recent start date" : "No entries yet";
  $("cycAvg").textContent = st.avg ? `${st.avg} d` : "\u2014";
  $("cycAvgSub").textContent = st.deltas ? `from ${st.deltas} recorded cycle${st.deltas === 1 ? "" : "s"}` : "Needs 2+ recorded starts";
  $("cycNext").textContent = st.next || "\u2014";
  $("cycNextSub").textContent = st.next ? `${st.next} \u00b12 days (estimate)` : "Not enough data yet";
  $("cycCount").textContent = String(st.count);
  if ($("cycleReminderChk")) $("cycleReminderChk").checked = !!cycleData.reminder;
  if ($("cycleLead")) { $("cycleLead").value = String(cycleData.lead ?? 3); $("cycleLead").disabled = !cycleData.reminder; }
  $("cycleHistory").innerHTML = st.count === 0
    ? `<p class="muted small">No entries yet. Record a period above to start building history.</p>`
    : cycleData.entries.map((e) => `
      <div class="cycle-entry">
        <div class="ce-main">
          <div class="ce-dates"><strong>${esc(e.start)}</strong>${e.end ? ` <span aria-hidden="true">\u2192</span> ${esc(e.end)} <span class="pill">${cycleDaySpan(e.start, e.end)} days</span>` : ` <span class="pill">No end date</span>`}</div>
          ${e.symptoms.length ? `<div class="ce-sym">${e.symptoms.map((s) => `<span class="pill">${esc(s)}</span>`).join("")}</div>` : ""}
          ${e.note ? `<p class="ce-note muted small">${esc(e.note)}</p>` : ""}
        </div>
        <div class="ce-actions">
          <button class="act-btn" type="button" data-cyc-edit="${esc(e.id)}" aria-label="Edit entry starting ${esc(e.start)}" title="Edit"><svg class="ic" aria-hidden="true"><use href="#i-pencil"/></svg></button>
          <button class="act-btn danger" type="button" data-cyc-del="${esc(e.id)}" aria-label="Delete entry starting ${esc(e.start)}" title="Delete"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button>
        </div>
      </div>`).join("");
  // Recalculate the reminder whenever entries, lead time or enable state change.
  if (user && cycleData.enabled) evaluateCycleReminder();
}
function cycleRemindKey(next) { return `pht_cyc_rem_${user.uid}_${next}`; }
function invalidateStaleCycleReminders(currentNext) {
  // Drop reminder markers whose predicted date no longer matches the live
  // prediction (an entry was added, edited or deleted), so a stale schedule
  // can't fire. Keys are per-user; only this user's markers are touched.
  const prefix = `pht_cyc_rem_${user.uid}_`;
  const keep = currentNext ? prefix + currentNext : null;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix) && k !== keep) localStorage.removeItem(k);
  }
}
function evaluateCycleReminder() {
  if (!user || !cycleData.enabled || !cycleData.reminder) return;
  const st = cycleStats();
  invalidateStaleCycleReminders(st.next);
  if (!st.next) return; // not enough history — never fabricate a date
  const lead = Number.isFinite(cycleData.lead) ? cycleData.lead : 3;
  const diffDays = Math.round((parseKey(st.next) - parseKey(todayKey())) / DAY_MS);
  // Fire once, within `lead` days before (or on) the estimated date.
  if (diffDays < 0 || diffDays > lead) return;
  const key = cycleRemindKey(st.next);
  if (localStorage.getItem(key)) return; // one reminder per prediction
  localStorage.setItem(key, "1");
  // Discreet, privacy-conscious wording: no dates or specifics in the alert.
  // Exactly one alert per logical reminder: a browser notification when
  // permitted, otherwise an in-app toast (never both). The previous code fired
  // a notification and then an unconditional toast, double-alerting the user
  // whenever permission was granted.
  const body = "A tracked date is coming up soon. Open Pro Habit Tracker for details.";
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("Cycle reminder", { body }); } catch { toast("Cycle reminder: an estimated date is coming up soon."); }
  } else {
    toast("Cycle reminder: an estimated date is coming up soon.");
  }
}
function cycleFieldErr(inputId, errId, msg) {
  const el = $(errId);
  el.textContent = msg || ""; el.hidden = !msg;
  if (msg) $(inputId).setAttribute("aria-invalid", "true"); else $(inputId).removeAttribute("aria-invalid");
}
function resetCycleForm() {
  $("cycleFormTitle").textContent = "Record a period";
  $("cycId").value = ""; $("cycStart").value = ""; $("cycEnd").value = ""; $("cycNote").value = "";
  document.querySelectorAll("#cycSymptoms input").forEach((i) => { i.checked = false; });
  $("cycCancelEdit").hidden = true;
  cycleFieldErr("cycStart", "cycStartErr", "");
  cycleFieldErr("cycEnd", "cycEndErr", "");
}
async function saveCycleEntry(e) {
  e?.preventDefault();
  if (!user || cycSaving) return;
  const start = $("cycStart").value, end = $("cycEnd").value || null;
  cycleFieldErr("cycStart", "cycStartErr", "");
  cycleFieldErr("cycEnd", "cycEndErr", "");
  if (!isKey(start)) { cycleFieldErr("cycStart", "cycStartErr", "Pick the first day of the period."); $("cycStart").focus(); return; }
  if (start > todayKey()) { cycleFieldErr("cycStart", "cycStartErr", "The first day can't be in the future."); $("cycStart").focus(); return; }
  if (end) {
    if (!isKey(end)) { cycleFieldErr("cycEnd", "cycEndErr", "Enter a valid date or leave it empty."); return; }
    if (end < start) { cycleFieldErr("cycEnd", "cycEndErr", "The last day can't be before the first day."); return; }
    if (end > todayKey()) { cycleFieldErr("cycEnd", "cycEndErr", "The last day can't be in the future."); return; }
  }
  const editing = $("cycId").value;
  if (cycleData.entries.some((x) => x.start === start && x.id !== editing)) {
    cycleFieldErr("cycStart", "cycStartErr", "An entry with this start date already exists — edit it instead.");
    return;
  }
  const symptoms = [...document.querySelectorAll("#cycSymptoms input:checked")].map((i) => i.value);
  const note = $("cycNote").value.trim().slice(0, 200);
  const id = editing || `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const entry = { id, start, end, symptoms, note };
  const prev = cycleData;
  cycleData = { ...cycleData, entries: editing ? cycleData.entries.map((x) => (x.id === editing ? entry : x)) : [...cycleData.entries, entry] };
  cycSaving = true;
  const btn = $("cycSaveBtn"); btn.disabled = true; btn.classList.add("loading");
  const status = await saveCycle();
  cycSaving = false; btn.disabled = false; btn.classList.remove("loading");
  if (status === "failed") { cycleData = prev; return; }
  resetCycleForm();
  renderCycle();
  toast((editing ? "Entry updated." : "Entry saved.") + cycleOfflineNote(status), "ok");
}
let cycSaving = false;
function cycleEdit(id) {
  const en = cycleData.entries.find((x) => x.id === id);
  if (!en) return;
  $("cycleFormTitle").textContent = "Edit entry";
  $("cycId").value = en.id; $("cycStart").value = en.start; $("cycEnd").value = en.end || ""; $("cycNote").value = en.note || "";
  document.querySelectorAll("#cycSymptoms input").forEach((i) => { i.checked = en.symptoms.includes(i.value); });
  $("cycCancelEdit").hidden = false;
  $("cycStart").focus();
}
async function cycleDelete(id) {
  const en = cycleData.entries.find((x) => x.id === id);
  if (!en) return;
  const ok = await askConfirm(`Delete the entry starting ${en.start}? This cannot be undone.`);
  if (!ok) return;
  const prev = cycleData;
  cycleData = { ...cycleData, entries: cycleData.entries.filter((x) => x.id !== id) };
  const status = await saveCycle();
  if (status === "failed") { cycleData = prev; return; }
  if ($("cycId").value === id) resetCycleForm();
  renderCycle();
  toast("Entry deleted." + cycleOfflineNote(status));
}
async function cycleEnable() {
  cycleData = { ...cycleData, enabled: true };
  const status = await saveCycle();
  if (status === "failed") { cycleData = { ...cycleData, enabled: false }; return; }
  renderCycle();
  toast("Cycle tracking enabled. Your data stays private to your account." + cycleOfflineNote(status), "ok");
}
async function cycleDisable() {
  const ok = await askConfirm("Turn off cycle tracking? Your entries are kept and will reappear if you enable it again.", "Turn off");
  if (!ok) return;
  cycleData = { ...cycleData, enabled: false };
  const status = await saveCycle();
  if (status === "failed") { cycleData = { ...cycleData, enabled: true }; return; }
  resetCycleForm();
  renderCycle();
  toast("Cycle tracking turned off." + cycleOfflineNote(status));
}
async function cycleDeleteAll() {
  const ok = await askConfirm("Delete ALL cycle data? Every recorded period will be removed. This cannot be undone.", "Delete all");
  if (!ok) return;
  const prev = cycleData;
  cycleData = { ...cycleData, entries: [] };
  const status = await saveCycle();
  if (status === "failed") { cycleData = prev; return; }
  resetCycleForm();
  renderCycle();
  toast("All cycle data deleted." + cycleOfflineNote(status));
}

/* ================= Location (one-shot, never stored) ================= */
function locStatus(msg, kind) {
  const el = $("locStatus");
  el.textContent = msg;
  el.className = `loc-status small${kind ? " " + kind : ""}`;
}
let locInFlight = false;
function requestLocation() {
  const btn = $("locBtn"), retry = $("locRetryBtn"), help = $("locHelp"), coords = $("locCoords");
  if (locInFlight) return;
  help.hidden = true; coords.hidden = true;
  if (!("geolocation" in navigator)) {
    locStatus("This browser doesn't support location.", "err");
    help.hidden = false;
    help.textContent = "Try a current version of Chrome, Edge, Firefox or Safari on this device.";
    retry.hidden = true;
    return;
  }
  locInFlight = true;
  btn.disabled = true; btn.classList.add("loading");
  retry.disabled = true;
  locStatus("Getting your location\u2026", "muted");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locInFlight = false;
      btn.disabled = false; btn.classList.remove("loading");
      retry.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      locStatus("Location obtained. This one-off result is not saved or sent anywhere.", "ok");
      coords.hidden = false;
      coords.textContent = `${latitude.toFixed(4)}\u00b0, ${longitude.toFixed(4)}\u00b0  \u00b7  \u00b1${Math.round(accuracy)} m accuracy`;
      retry.hidden = false;
    },
    (err) => {
      locInFlight = false;
      btn.disabled = false; btn.classList.remove("loading");
      retry.disabled = false;
      retry.hidden = false;
      if (err.code === 1) {
        locStatus("Permission denied.", "err");
        help.hidden = false;
        help.textContent = "Allow location for this site via the lock icon in the address bar (or browser Settings \u2192 Privacy \u2192 Location), then retry.";
      } else if (err.code === 2) {
        locStatus("Position unavailable right now.", "err");
        help.hidden = false;
        help.textContent = "Turn on device location services (and move outdoors if possible), then retry.";
      } else {
        locStatus("Request timed out.", "err");
        help.hidden = false;
        help.textContent = "The browser took too long to answer. Retry when you have a clearer signal.";
      }
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 0 }
  );
}

/* ================= Activity tracker (GPS) =================
   A real walk/ride tracker on top of the browser Geolocation API:
   - start / pause / resume / finish / cancel with explicit user control
   - live stats: distance (geodesic), active time, average + current speed,
     GPS accuracy
   - noisy fixes are rejected, never counted (see acceptFix)
   - paused time and the gap it leaves are excluded from distance, and each
     resume starts a NEW polyline segment so the route never draws a straight
     line across a gap
   - finished activities are written to users/{uid}/activities/{id} with a
     client-generated id, so retrying a save can never duplicate one
   - an in-progress session is mirrored to localStorage (this device only) so
     an interrupted activity can be recovered after a reload

   Honest limitations (also surfaced in the UI): a web page can only record
   while it is open and the screen is on. There is no background tracking, and
   points during any closed period are permanently lost — recovery resumes with
   a fresh segment and never fabricates positions. */

const ACT_MAX_ACC_M = 65;   // fixes with worse accuracy are rejected outright
const ACT_MIN_STEP_M = 1.2; // below this a fix is duplicate/noise jitter
const ACT_MAX_SPEED = { walk: 4.5, cycle: 25 }; // m/s implied-speed caps
const ACT_LABEL = { walk: "Walk", cycle: "Cycling" };
const actSessionKey = () => `pht_active_session_${user?.uid || "anon"}`;

let act = null;              // live session (null when idle)
let actWatch = null;         // watchPosition handle
let actTimer = null;         // 1s UI refresh while a session exists
let actSaving = false;       // guards the finish button against double-saves
let actMap = null, actRouteLayer = null;
let actHistory = [];
let unsubAct = null;

const actCol = () => collection(db, "users", user.uid, "activities");
const actDocRef = (id) => doc(db, "users", user.uid, "activities", id);
const actSeg = () => act.segments[act.segments.length - 1];

function actStatus(msg, kind = "muted") {
  const el = $("actStatus");
  if (!el) return;
  el.textContent = msg;
  el.className = `loc-status ${kind} small`;
}
function actHelp(msg) {
  const el = $("actHelp");
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
}
function showActRecover(on) { const el = $("actRecover"); if (el) el.hidden = !on; }

function newAct(type) {
  const now = Date.now();
  return {
    v: 1,
    id: `act_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type, status: "active",
    startedAtMs: now, activeMs: 0, lastT0: now,
    distanceM: 0, maxSpeedMps: 0, curSpeedMps: null, lastAcc: null,
    accepted: 0, rejected: 0,
    segments: [{ t0: now, pts: [] }],
  };
}

// Great-circle distance in metres (haversine on a spherical earth).
function haversineM(a, b) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Decide whether a raw GPS fix may be trusted and may add distance:
// - unusable coordinates            -> rejected ["invalid"]
// - accuracy worse than ACT_MAX_ACC -> rejected ["accuracy"] (indoor/urban noise)
// - < ACT_MIN_STEP_M from previous  -> rejected ["duplicate"] (standing still)
// - non-increasing timestamps       -> rejected ["time"]
// - implied speed above the activity cap -> rejected ["jump"] (teleports)
function acceptFix(prev, fix, type) {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return { ok: false, why: "invalid" };
  if (!Number.isFinite(fix.acc) || fix.acc > ACT_MAX_ACC_M) return { ok: false, why: "accuracy" };
  if (!prev) return { ok: true };
  const d = haversineM(prev, fix);
  if (d < ACT_MIN_STEP_M) return { ok: false, why: "duplicate" };
  const dt = (fix.t - prev.t) / 1000;
  if (dt <= 0) return { ok: false, why: "time" };
  const speed = d / dt;
  if (speed > ACT_MAX_SPEED[type]) return { ok: false, why: "jump" };
  return { ok: true, d, speed };
}

function startActWatch() {
  stopActWatch();
  actWatch = navigator.geolocation.watchPosition(onActFix, onActGeoError, {
    enableHighAccuracy: true, timeout: 30000, maximumAge: 0,
  });
}
function stopActWatch() {
  if (actWatch != null) { try { navigator.geolocation.clearWatch(actWatch); } catch { /* ignore */ } actWatch = null; }
}
function startActTimer() { stopActTimer(); actTimer = setInterval(() => { if (act) renderActivity(); }, 1000); }
function stopActTimer() { if (actTimer) { clearInterval(actTimer); actTimer = null; } }

function startTracking(typeArg) {
  if (!user || act) return;
  if (!("geolocation" in navigator)) { actStatus("This browser doesn\u2019t support geolocation.", "err"); return; }
  const type = ACT_MAX_SPEED[typeArg] ? typeArg : "walk";
  act = newAct(type);
  showActRecover(false);
  actHelp("");
  actStatus(`Waiting for GPS signal\u2026 (${ACT_LABEL[type].toLowerCase()})`);
  persistActSession();
  startActWatch();
  startActTimer();
  initActMap();
  drawRoute();
  renderActivity();
}

function onActFix(pos) {
  if (!act || act.status !== "active") return; // paused/saving: never accumulate
  const c = pos.coords;
  const fix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, t: pos.timestamp || Date.now() };
  const seg = actSeg();
  const prev = seg.pts.length ? seg.pts[seg.pts.length - 1] : null;
  const verdict = acceptFix(prev, fix, act.type);
  act.lastAcc = fix.acc;
  if (!verdict.ok) {
    act.rejected++;
    if (verdict.why === "accuracy") actStatus(`Weak GPS signal (\u00b1${Math.round(fix.acc)} m) \u2014 point skipped.`, "muted");
    persistActSession();
    return;
  }
  if (verdict.d) {
    act.distanceM += verdict.d;
    act.curSpeedMps = verdict.speed;
    if (verdict.speed > act.maxSpeedMps) act.maxSpeedMps = verdict.speed;
  } else {
    act.curSpeedMps = 0;
  }
  seg.pts.push(fix);
  act.accepted++;
  actHelp("");
  actStatus(`Tracking ${ACT_LABEL[act.type].toLowerCase()} \u2014 ${act.accepted} GPS point${act.accepted === 1 ? "" : "s"} recorded.`);
  persistActSession();
  drawRoute();
  renderActivity();
}

function onActGeoError(err) {
  if (!act) return;
  if (err && err.code === 1) { // permission denied
    if (act.status === "active") { act.status = "paused"; if (act.lastT0) { act.activeMs += Date.now() - act.lastT0; act.lastT0 = null; } }
    stopActWatch();
    persistActSession();
    actStatus("Location permission denied \u2014 recording is paused.", "err");
    actHelp("Allow location for this site via the lock icon in the address bar, then press Resume.");
    renderActivity();
  } else {
    // POSITION_UNAVAILABLE / TIMEOUT: keep the watch alive; it usually recovers.
    actStatus("No GPS fix yet \u2014 waiting for a clearer signal\u2026", "muted");
    actHelp("Move outdoors or near a window. Recording continues automatically.");
  }
}

function pauseTracking() {
  if (!act || act.status !== "active") return;
  act.status = "paused";
  if (act.lastT0) { act.activeMs += Date.now() - act.lastT0; act.lastT0 = null; }
  act.curSpeedMps = null;
  stopActWatch();
  persistActSession();
  actStatus("Paused \u2014 distance and active time are not recorded while paused.");
  actHelp("");
  drawRoute();
  renderActivity();
}

function resumeTracking() {
  if (!act || act.status !== "paused") return;
  act.status = "active";
  act.lastT0 = Date.now();
  act.segments.push({ t0: Date.now(), pts: [] }); // gap stays a gap: new segment
  persistActSession();
  startActWatch();
  startActTimer();
  actStatus("Tracking resumed \u2014 the pause shows as a gap in the route.");
  actHelp("");
  renderActivity();
}

async function finishTracking() {
  if (!act || actSaving) return;
  const points = act.segments.reduce((n, s) => n + s.pts.length, 0);
  if (!points) {
    actStatus("No GPS points recorded yet \u2014 nothing to save. Cancel to discard this session.", "err");
    return;
  }
  actSaving = true;
  try {
    if (act.status === "active" && act.lastT0) { act.activeMs += Date.now() - act.lastT0; act.lastT0 = null; }
    act.status = "saving";
    stopActWatch(); stopActTimer();
    renderActivity();
    const activeMs = Math.max(1000, act.activeMs);
    const payload = {
      type: act.type,
      startedAtMs: act.startedAtMs,
      endedAtMs: Date.now(),
      durationMs: activeMs,
      distanceM: Math.round(act.distanceM),
      avgSpeedMps: act.distanceM / (activeMs / 1000),
      maxSpeedMps: act.maxSpeedMps,
      pointCount: points,
      rejectedCount: act.rejected,
      // Firestore forbids nested arrays, so each segment wraps its points.
      segments: act.segments.filter((s) => s.pts.length).map((s) => ({ t0: s.t0, pts: s.pts })),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    // Fixed id + merge: re-running a failed finish can never duplicate the
    // activity, and an offline retry lands on the same document.
    const committed = await settleWrite(
      setDoc(actDocRef(act.id), payload, { merge: true }),
      "Activity saved on this device \u2014 it will sync when you\u2019re back online.");
    if (committed) toast("Activity saved.", "ok");
    clearActSession();
    act = null;
    drawRoute();
    renderActivity();
    actStatus("Not tracking.");
  } catch (err) {
    console.error(err);
    act.status = "paused";
    actStatus("Couldn\u2019t save the activity. " + friendlyErr(err), "err");
    renderActivity();
  } finally {
    actSaving = false;
  }
}

async function cancelTracking() {
  if (!act || actSaving) return;
  const ok = await askConfirm("Discard this activity? The recorded route will not be saved.", "Discard");
  if (!ok) return;
  stopActWatch(); stopActTimer();
  clearActSession();
  act = null;
  drawRoute();
  renderActivity();
  actStatus("Activity discarded.");
}

/* ----- session mirror (this device only) ----- */
function clearActSession() { try { localStorage.removeItem(actSessionKey()); } catch { /* ignore */ } }
function serializeAct() {
  let segs = act.segments;
  const count = segs.reduce((n, s) => n + s.pts.length, 0);
  if (count > 4000) {
    // Bound localStorage size for very long sessions: thin older segments
    // (always keeping their first/last points).
    segs = segs.map((s, i) => i === segs.length - 1 ? s : {
      t0: s.t0,
      pts: s.pts.filter((_, j) => j % 2 === 0 || j === s.pts.length - 1),
    });
  }
  return { ...act, segments: segs };
}
function persistActSession() {
  if (!act) return;
  try { localStorage.setItem(actSessionKey(), JSON.stringify(serializeAct())); } catch { /* quota: live session still works */ }
}
function restoreActSession() {
  if (!user || act) return;
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(actSessionKey()) || "null"); } catch { raw = null; }
  if (!raw || raw.v !== 1 || !ACT_MAX_SPEED[raw.type] || !Array.isArray(raw.segments)) return;
  if (raw.status === "active" && raw.lastT0) raw.activeMs += Date.now() - raw.lastT0;
  raw.status = "paused"; // recovery always starts paused; never fabricate the gap
  raw.lastT0 = null;
  raw.curSpeedMps = null;
  act = raw;
  showActRecover(true);
  actStatus("Recovered an unfinished activity from this device. Resume to continue (the closed period stays a gap), or discard it.");
  renderActivity();
}
function resumeActSession() {
  if (!act) return;
  showActRecover(false);
  resumeTracking();
}
function discardActSession() {
  showActRecover(false);
  clearActSession();
  act = null;
  drawRoute();
  renderActivity();
  actStatus("Recovered activity discarded.");
}

/* ----- map (progressive enhancement; tracking works without it) ----- */
function initActMap() {
  const el = $("actMap");
  if (!el) return;
  if (typeof window === "undefined" || !window.L || typeof window.L.map !== "function") {
    const n = $("actMapNote");
    if (n) {
      n.hidden = false;
      n.textContent = "The map library couldn\u2019t load (it needs a network connection the first time). Tracking, distance and history still work.";
    }
    return;
  }
  if (actMap) return;
  actMap = window.L.map(el, { zoomControl: true, attributionControl: true });
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(actMap);
  actRouteLayer = window.L.layerGroup().addTo(actMap);
  actMap.setView([20, 0], 2);
  drawRoute();
}
function drawRoute() {
  if (!actMap || !actRouteLayer) return;
  const L = window.L;
  actRouteLayer.clearLayers();
  const all = [];
  let first = null, last = null;
  if (act) {
    for (const s of act.segments) {
      if (!s.pts.length) continue;
      const latlngs = s.pts.map((p) => [p.lat, p.lng]);
      if (!first) first = latlngs[0];
      last = latlngs[latlngs.length - 1];
      all.push(...latlngs);
      // One polyline per segment: paused/disconnected gaps are never bridged.
      if (latlngs.length > 1) L.polyline(latlngs, { color: "#2563eb", weight: 4, opacity: 0.85 }).addTo(actRouteLayer);
    }
  }
  if (first) L.circleMarker(first, { radius: 6, color: "#059669", fillColor: "#059669", fillOpacity: 1 }).addTo(actRouteLayer);
  if (last) L.circleMarker(last, { radius: 7, color: "#2563eb", fillColor: "#ffffff", fillOpacity: 1, weight: 3 }).addTo(actRouteLayer);
  if (all.length) {
    if (act && act.status === "active" && last) {
      if (all.length <= 1) actMap.setView(last, 16); else actMap.panTo(last);
    } else {
      actMap.fitBounds(L.latLngBounds(all).pad(0.2), { maxZoom: 17 });
    }
  }
}
function onActivityShown() {
  initActMap();
  renderActivity();
  if (actMap) setTimeout(() => { try { actMap.invalidateSize(); } catch { /* ignore */ } }, 50);
}

/* ----- stats + history rendering ----- */
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m");
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}
const fmtSpeed = (mps) => (mps * 3.6).toFixed(1) + " km/h";

function renderActivity() {
  if (!$("actType")) return;
  const has = !!act;
  $("actType").disabled = has;
  $("actStart").hidden = has;
  $("actPause").hidden = !has;
  $("actFinish").hidden = !has;
  $("actCancel").hidden = !has;
  $("actStats").hidden = !has;
  if (has) {
    const live = act.status === "active" && act.lastT0 ? Date.now() - act.lastT0 : 0;
    const ms = act.activeMs + live;
    $("actPause").textContent = act.status === "active" ? "Pause" : act.status === "saving" ? "Saving\u2026" : "Resume";
    $("actPause").disabled = act.status === "saving" || actSaving;
    $("actFinish").disabled = actSaving;
    $("actCancel").disabled = actSaving;
    $("actDistance").textContent = fmtDist(act.distanceM);
    $("actTime").textContent = fmtDur(ms);
    $("actAvg").textContent = ms > 3000 && act.distanceM > 0 ? fmtSpeed(act.distanceM / (ms / 1000)) : "\u2014";
    $("actCur").textContent = act.status === "active" && act.curSpeedMps != null ? fmtSpeed(act.curSpeedMps) : "\u2014";
    $("actAcc").textContent = act.lastAcc != null ? `\u00b1${Math.round(act.lastAcc)} m` : "\u2014";
  }
  renderActHistory();
}
function renderActHistory() {
  const el = $("actHistory");
  if (!el) return;
  if (!user) { el.innerHTML = ""; return; }
  if (!actHistory.length) {
    el.innerHTML = '<p class="muted small">No activities yet. Start a walk or ride to record your first route.</p>';
    return;
  }
  el.innerHTML = actHistory.map((a) => `
    <div class="act-entry">
      <div class="act-entry-main">
        <strong>${ACT_LABEL[a.type] || "Activity"}</strong>
        <span class="muted small">${esc(new Date(a.startedAtMs).toLocaleString())} \u00b7 ${fmtDur(a.durationMs || 0)} \u00b7 ${fmtDist(a.distanceM || 0)}${a.avgSpeedMps ? " \u00b7 avg " + fmtSpeed(a.avgSpeedMps) : ""}</span>
      </div>
      <button class="icon-btn ghost" type="button" data-act-del="${esc(a.id)}" aria-label="Delete activity"><svg class="ic ic-sm"><use href="#i-trash"/></svg></button>
    </div>`).join("");
}
async function deleteAct(id) {
  const ok = await askConfirm("Delete this activity and its route? This cannot be undone.", "Delete");
  if (!ok) return;
  try {
    const committed = await settleWrite(
      deleteDoc(actDocRef(id)),
      "Deletion saved on this device \u2014 it will sync when you\u2019re back online.");
    if (committed) toast("Activity deleted.");
  } catch (err) { console.error(err); toast(friendlyErr(err), "err"); }
}
function subscribeAct() {
  unsubAct?.();
  actHistory = [];
  if (!user) return;
  unsubAct = onSnapshot(actCol(), (snap) => {
    actHistory = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((a) => a && ACT_MAX_SPEED[a.type] && Number.isFinite(a.startedAtMs))
      .sort((a, b) => b.startedAtMs - a.startedAtMs);
    renderActHistory();
  }, (err) => {
    console.error(err);
    showError(friendlyErr(err) + " (Activity history needs Firestore rules for users/{uid}/activities.)");
  });
}

/* ================= Reminders =================
   These are page-context timers only. A website cannot execute JavaScript after
   its tab/page has been closed, so reminders fire only while this page is
   running. When the tab is hidden, browsers throttle timers (often to >=1min),
   so a reminder near a minute boundary can still fire late but on the same day.
   Nothing here runs in the background once the page is gone — that requires a
   native build (future phase) or a push service (not added, needs approval). */
const reminderKey = () => `pht_reminders_${user?.uid || "anon"}`;
const firedKey = (uid, hhmm, day) => `pht_fired_${uid}_${hhmm}_${day}`;
function loadReminders() {
  try { return { time: "20:00", enabled: false, ...JSON.parse(localStorage.getItem(reminderKey()) || "{}") }; }
  catch { return { time: "20:00", enabled: false }; }
}
function saveReminders(patch) {
  localStorage.setItem(reminderKey(), JSON.stringify({ ...loadReminders(), ...patch }));
}
async function updateNotifStatus() {
  const el = $("notifStatus");
  if (!("Notification" in window)) { el.textContent = "Browser notifications: not supported — in-app toasts will be used."; return; }
  el.textContent = `Browser notifications: ${Notification.permission}.`;
}
// Fires at most once per (user, time, calendar-day). Dedup key is account-scoped
// and date-aware, so multiple tabs / reloads / rerenders never double-fire, and
// a timezone or date change naturally moves to a new day's key (old keys are
// never reused for a past day).
function checkHabitReminder() {
  if (!user) return;
  const r = loadReminders();
  if (!r.enabled || !/^\d{2}:\d{2}$/.test(r.time || "")) return;
  const now = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  if (now !== r.time) return;
  const day = todayKey();
  if (localStorage.getItem(firedKey(user.uid, now, day))) return;
  localStorage.setItem(firedKey(user.uid, now, day), "1");
  const left = habits.filter((h) => isScheduled(h, day) && !doneOn(h, day));
  const msg = left.length ? `You still have ${left.length} habit(s) to complete today.` : "All habits done for today. Nice work!";
  if ("Notification" in window && Notification.permission === "granted") { try { new Notification("Habit reminder", { body: msg }); } catch { toast(msg); } }
  else toast(msg);
}
let _reminderTimer = null;
function startReminderTimer() { if (!_reminderTimer) _reminderTimer = setInterval(checkHabitReminder, 20000); }
function stopReminderTimer() { if (_reminderTimer) { clearInterval(_reminderTimer); _reminderTimer = null; } }
startReminderTimer();
// Remove this user's expired reminder dedup markers (old calendar days) so
// localStorage can't grow without bound. Never touches the saved reminder-time
// preference (pht_reminders_{uid}), the theme key, or any other user's keys.
function pruneFiredReminderKeys() {
  if (!user) return;
  const today = todayKey();
  const prefix = `pht_fired_${user.uid}_`;
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) {
      const m = k.match(/_(\d{4}-\d{2}-\d{2})$/);
      if (m && m[1] < today) localStorage.removeItem(k);
    }
  }
}

/* ================= Navigation ================= */
function go(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll(".nav-item").forEach((b) => {
    const on = b.dataset.nav === view;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $("topbarTitle").textContent = view[0].toUpperCase() + view.slice(1);
  $("appShell").querySelector(".sidebar").classList.remove("open");
  $("navScrim").hidden = true;
  $("menuBtn").setAttribute("aria-expanded", "false");
  if (user && _dataLoaded) syncDay(); // re-derive views if the local day changed since the last render
  if (view === "activity") onActivityShown();
  if (view === "calendar") pinHeatmapScroll();
}

/* ================= Events ================= */
function bind() {
  $("tabLogin").onclick = () => setAuthMode("login");
  $("tabSignup").onclick = () => setAuthMode("signup");
  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim(), pw = $("authPassword").value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authErr("Enter a valid email address.");
    if (pw.length < 6) return authErr("Password must be at least 6 characters.");
    authErr(null); $("authSubmit").disabled = true;
    try {
      // Persistence is configured before any sign-in so a just-signed-in
      // session actually survives reloads (see firebase.js).
      await authPersistenceReady.catch(() => {});
      if (authMode === "login") await signInWithEmailAndPassword(auth, email, pw);
      else await createUserWithEmailAndPassword(auth, email, pw);
    } catch (err) { console.error(err); authErr(friendlyErr(err)); }
    finally { $("authSubmit").disabled = false; }
  });
  let googleSigningIn = false;
  $("googleBtn").onclick = async () => {
    if (googleSigningIn) return;
    googleSigningIn = true;
    const gbtn = $("googleBtn");
    gbtn.disabled = true;
    gbtn.classList.add("loading");
    authErr(null);
    try {
      await authPersistenceReady.catch(() => {});
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error(err);
      // Popups are unavailable (blocked, iOS/webview restrictions): use the
      // supported full-page redirect flow, completed by getRedirectResult on
      // the next load.
      if (err?.code === "auth/popup-blocked" || err?.code === "auth/operation-not-supported-in-this-environment") {
        toast("Popup unavailable \u2014 switching to redirect sign-in\u2026");
        try { await signInWithRedirect(auth, googleProvider); }
        catch (err2) { console.error(err2); authErr(googleErrMsg(err2)); }
      } else {
        authErr(googleErrMsg(err));
      }
    }
    finally { googleSigningIn = false; gbtn.disabled = false; gbtn.classList.remove("loading"); }
  };
  $("logoutBtn").onclick = () => confirmLogout();
  $("accountBtn").onclick = () => {
    if (!user) return;
    renderAccountInfo(user);
    $("acctError").hidden = true;
    $("acctNameErr").hidden = true; $("acctNameOk").hidden = true;
    openModal("accountModal", { focus: "#acctNameInput" });
  };
  $("acctLogoutBtn").onclick = () => confirmLogout();
  $("acctNameForm").addEventListener("submit", saveProfileName);
  $("acctCancelBtn").onclick = () => {
    if (!user) return;
    $("acctNameInput").value = user.displayName || "";
    $("acctNameErr").hidden = true; $("acctNameOk").hidden = true;
    $("acctNameInput").removeAttribute("aria-invalid");
  };
  $("cycleEnableBtn").onclick = () => cycleEnable();
  $("cycleDisableBtn").onclick = () => cycleDisable();
  $("cycleDeleteAllBtn").onclick = () => cycleDeleteAll();
  $("cycleForm").addEventListener("submit", saveCycleEntry);
  $("cycCancelEdit").onclick = () => resetCycleForm();
  $("cycleHistory").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-cyc-edit]");
    if (ed) { cycleEdit(ed.dataset.cycEdit); return; }
    const del = e.target.closest("[data-cyc-del]");
    if (del) cycleDelete(del.dataset.cycDel);
  });
  if ($("cycleReminderChk")) $("cycleReminderChk").onchange = async (e) => {
    cycleData = { ...cycleData, reminder: e.target.checked };
    if (e.target.checked && "Notification" in window && Notification.permission === "default") {
      // Only request permission on an explicit user action, never on page load.
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      updateNotifStatus();
    }
    if ((await saveCycle()) === "failed") { cycleData = { ...cycleData, reminder: !e.target.checked }; e.target.checked = !e.target.checked; }
    if ($("cycleLead")) $("cycleLead").disabled = !cycleData.reminder;
    evaluateCycleReminder();
  };
  if ($("cycleLead")) $("cycleLead").onchange = async (e) => {
    const n = Number(e.target.value);
    cycleData = { ...cycleData, lead: Number.isFinite(n) ? Math.min(14, Math.max(0, Math.round(n))) : 3 };
    const status = await saveCycle();
    if (status === "failed") { renderCycle(); return; }
    evaluateCycleReminder();
  };
  $("locBtn").onclick = () => requestLocation();
  $("locRetryBtn").onclick = () => requestLocation();
  $("actStart").onclick = () => startTracking($("actType").value);
  $("actPause").onclick = () => { if (!act) return; if (act.status === "active") pauseTracking(); else resumeTracking(); };
  $("actFinish").onclick = () => finishTracking();
  $("actCancel").onclick = () => cancelTracking();
  $("actRecoverResume").onclick = () => resumeActSession();
  $("actRecoverDiscard").onclick = () => discardActSession();
  $("actHistory").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act-del]");
    if (b) deleteAct(b.dataset.actDel);
  });
  document.querySelectorAll(".nav-item").forEach((b) => { b.onclick = () => go(b.dataset.nav); });
  const setNav = (open) => {
    document.querySelector(".sidebar").classList.toggle("open", open);
    $("navScrim").hidden = !open;
    $("menuBtn").setAttribute("aria-expanded", String(open));
  };
  $("menuBtn").onclick = () => setNav($("navScrim").hidden);
  $("navScrim").onclick = () => setNav(false);
  $("addHabitBtn").onclick = (e) => openHabitModal(null, e.currentTarget);
  $("addHabitTopBtn").onclick = (e) => openHabitModal(null, e.currentTarget);
  $("cancelHabitBtn").onclick = () => closeHabitModal();
  $("habitForm").addEventListener("submit", saveHabit);
  $("fFreq").onchange = () => { $("customDays").hidden = $("fFreq").value !== "custom"; };
  $("colorSwatches").addEventListener("click", (e) => {
    const b = e.target.closest("[data-color]"); if (!b) return;
    pickedColor = b.dataset.color; paintSwatches();
  });
  for (const id of ["searchInput", "filterCategory", "filterStatus", "sortBy"]) $(id).addEventListener("input", renderHabitsView);
  $("heatmapHabit").onchange = renderHeatmap;
  $("heatmap").addEventListener("click", (e) => {
    const c = e.target.closest("[data-day]"); if (!c) return;
    selectedDay = selectedDay === c.dataset.day ? null : c.dataset.day;
    document.querySelectorAll(".hm-cell").forEach((x) => x.classList.toggle("sel", x.dataset.day === selectedDay));
    renderDayDetail();
  });
  document.addEventListener("click", async (e) => {
    const add = e.target.closest("[data-add-habit]");
    if (add) { e.stopPropagation(); openHabitModal(null, add); return; }
    const cm = e.target.closest("[data-close-modal]");
    if (cm) {
      e.stopPropagation();
      if (cm.dataset.closeModal === "habitModal") closeHabitModal();
      else closeModal(cm.dataset.closeModal);
      return;
    }
    const t = e.target.closest("[data-toggle]");
    if (t) { e.stopPropagation(); await toggleDone(t.dataset.toggle); return; }
    const ed = e.target.closest("[data-edit]");
    if (ed) { e.stopPropagation(); const h = habits.find((x) => x.id === ed.dataset.edit); openHabitModal(h, ed); return; }
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); await removeHabit(del.dataset.del); return; }
    const op = e.target.closest("[data-open]");
    if (op) { openDetail(op.dataset.open, op); return; }
    const ob = e.target.closest("[data-open-btn]");
    if (ob) { e.stopPropagation(); openDetail(ob.dataset.openBtn, ob); return; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      // trap Tab/Shift+Tab within the topmost open modal
      const frame = topModalFrame();
      if (!frame) return;
      const modal = $(frame.id);
      const items = focusablesIn(modal);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (!modal.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); return; }
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); return; }
      return;
    }
    if (e.key === "Escape") {
      if (!$("navScrim").hidden) { document.querySelector(".sidebar").classList.remove("open"); $("navScrim").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false"); return; }
      // close only the topmost layer — never hide a confirm the habit dirty-check just opened
      const frame = topModalFrame();
      if (!frame) return;
      if (frame.id === "confirmModal") { closeModal("confirmModal"); confirmResolve?.(false); return; }
      if (frame.id === "accountModal") { closeModal("accountModal"); return; }
      if (frame.id === "habitModal") { closeHabitModal(); return; }
      if (frame.id === "detailModal") { closeDetail(); return; }
    }
  });
  $("closeDetailBtn").onclick = closeDetail;
  $("detailEditBtn").onclick = () => { const h = habits.find((x) => x.id === detailId); closeDetail(); openHabitModal(h); };
  $("detailDeleteBtn").onclick = () => removeHabit(detailId);
  $("detailToggleBtn").onclick = async () => { await toggleDone(detailId); };
  $("confirmCancel").onclick = () => { closeModal("confirmModal"); confirmResolve?.(false); };
  $("confirmOk").onclick = () => { closeModal("confirmModal"); confirmResolve?.(true); };
  const setTheme = (m) => { localStorage.setItem("pht_theme", m); applyTheme(m); };
  $("themeSelect").onchange = (e) => setTheme(e.target.value);
  $("themeToggle").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("themeToggleSide").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("reminderTime").onchange = (e) => {
    const v = e.target.value;
    if (!/^\d{2}:\d{2}$/.test(v)) { e.target.value = loadReminders().time; return; }
    saveReminders({ time: v });
    checkHabitReminder(); // re-evaluate immediately for the newly chosen time
  };
  $("reminderEnabled").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      updateNotifStatus();
    }
    saveReminders({ enabled: e.target.checked });
    toast(e.target.checked ? "Daily reminder enabled. It runs while this page is open." : "Daily reminder disabled.");
    checkHabitReminder();
  };
  $("testNotifBtn").onclick = async () => {
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    if ("Notification" in window && Notification.permission === "granted") { try { new Notification("Pro Habit Tracker", { body: "Reminders are working." }); } catch { toast("Reminders are working."); } }
    else toast("Notifications blocked — in-app reminders will still appear.", "err");
    updateNotifStatus();
  };
  ["habitModal", "detailModal", "confirmModal", "accountModal"].forEach((id) => {
    $(id).addEventListener("click", (e) => {
      if (e.target.id === id) {
        if (id === "habitModal") closeHabitModal();
        else if (id === "detailModal") closeDetail();
        else { closeModal(id); if (id === "confirmModal") confirmResolve?.(false); }
      }
    });
  });
}

/* ================= Boot ================= */
function setAuthState(state) {
  $("authLoading").hidden = state !== "loading";
  $("authView").hidden = state !== "auth";
  $("appShell").hidden = state !== "app";
}
let snapTimer = null;
function subscribe() {
  unsub?.();
  clearTimeout(snapTimer);
  _dataLoaded = false; // this session's habits have not been delivered yet
  $("loadingBar").hidden = false;
  showError(null);
  const waitMs = (typeof window !== "undefined" && window.__PHT_SNAP_TIMEOUT) || 12000;
  snapTimer = setTimeout(() => {
    $("loadingBar").hidden = true;
    showError("Still waiting for your habits. Check your connection \u2014 they will appear automatically when data arrives.");
  }, waitMs);
  unsub = onSnapshot(habitsCol(), (snap) => {
    clearTimeout(snapTimer);
    habits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Backfill safety: old docs used lastDone/streak without completions
    habits = habits.map((h) => ({ completions: [], ...h }));
    _dataLoaded = true;
    $("loadingBar").hidden = true;
    showError(null);
    renderAll();
  }, (err) => {
    clearTimeout(snapTimer);
    console.error(err);
    $("loadingBar").hidden = true;
    showError(friendlyErr(err) + " (Check Firestore rules: users/{uid}/habits must allow your own uid.)");
  });
}
function handleAuth(u) {
  const prevUid = user?.uid || null;
  if (act && u && prevUid && prevUid !== u.uid) {
    // A different account signed in while a session was live: stop recording
    // immediately. The interrupted session stays in this device's storage
    // under the previous uid's key and can only be recovered by that account.
    stopActWatch(); stopActTimer(); act = null; showActRecover(false);
  }
  user = u;
  if (u) {
    setAuthState("app");
    renderAccountInfo(u);
    subscribe(); go("dashboard");
    loadCycle();
    subscribeAct();           // activity history for this account only
    restoreActSession();      // offer recovery of an interrupted GPS session
    pruneFiredReminderKeys(); // tidy this user's expired reminder markers
    noteOnline(); paintSyncChip();
  } else {
    unsub?.(); clearTimeout(snapTimer); habits = []; detailId = null; _dataLoaded = false;
    unsubAct?.(); actHistory = []; act = null; stopActWatch(); stopActTimer();
    showActRecover(false); renderActHistory(); actStatus("Not tracking."); actHelp("");
    cycleData = { enabled: false, entries: [], reminder: false, lead: 3 };
    _sync.pending = 0; // no writes should outlive the session's UI state
    if ($("syncChip")) $("syncChip").hidden = true;
    $("loadingBar").hidden = true;
    showError(null); authErr(null); noteWeakAuthPersistence();
    for (const m of ["accountModal", "habitModal", "detailModal", "confirmModal"]) { const el = $(m); if (el) el.hidden = true; }
    modalStack.length = 0;
    confirmResolve?.(false); confirmResolve = null;
    habitSnap = null;
    $("userName").textContent = "Account";
    if ($("userEmail")) $("userEmail").textContent = "\u2014";
    const av = $("userAvatar");
    if (av) { av.textContent = "?"; av.querySelector("img")?.remove(); }
    if ($("settingsName")) $("settingsName").textContent = "\u2014";
    if ($("settingsEmail")) $("settingsEmail").textContent = "\u2014";
    if ($("acctNameInput")) { $("acctNameInput").value = ""; $("acctNameErr").hidden = true; $("acctNameOk").hidden = true; }
    renderCycle();
    document.querySelector(".sidebar")?.classList.remove("open");
    $("navScrim").hidden = true;
    setAuthState("auth");
    setTimeout(() => { try { $("authEmail")?.focus(); } catch { /* ignore */ } }, 0);
  }
}
function handleAuthError(err) {
  console.error(err);
  unsub?.(); clearTimeout(snapTimer); user = null; habits = []; detailId = null;
  $("loadingBar").hidden = true;
  setAuthState("auth");
  authErr("We couldn\u2019t verify your sign-in state (" + (err?.code || err?.message || "unknown error") + "). Please log in again.");
}
if (typeof window !== "undefined") {
  // keep at most one auth listener even if boot code ever ran twice
  window.__phtAuthUnsub?.();
  window.__phtAuthUnsub = onAuthStateChanged(auth, handleAuth, handleAuthError);
} else {
  onAuthStateChanged(auth, handleAuth, handleAuthError);
}
// Completes a Google sign-in started via signInWithRedirect (the fallback used
// when popups are blocked). Must run on every load; resolves to null when no
// redirect is pending. Failures surface on the auth screen while signed out.
getRedirectResult(auth)
  .then((res) => { if (res && res.user) toast("Signed in with Google.", "ok"); })
  .catch((err) => {
    console.error(err);
    if (!$("appShell") || $("appShell").hidden) authErr(googleErrMsg(err));
  });
applyTheme(themeStore);
setAuthMode("login");
bind();

// Re-render when the calendar day rolls over (stale "today" after midnight).
const _dayCheckMs = () => (typeof window !== "undefined" && window.__PHT_DAY_CHECK_MS) || 30000;
let _dayTimer = setInterval(() => { if (syncDay() && user) evaluateCycleReminder(); }, _dayCheckMs());

// Catch reminders and connectivity changes when the tab becomes active again
// (timers are throttled while hidden, so re-check on focus/visibility).
if (typeof document !== "undefined") {
  const _onVisible = () => {
    if (document.visibilityState !== "visible") return;
    noteOnline(); paintSyncChip();
    syncDay();
    checkHabitReminder(); evaluateCycleReminder();
  };
  document.addEventListener("visibilitychange", _onVisible);
  if (typeof window !== "undefined") window.addEventListener("focus", _onVisible);
}

// Test seam (inert unless a test pre-sets window.__PHT_TEST__). Matches the
// existing window.__PHT_SNAP_TIMEOUT / __PHT_DAY_CHECK_MS convention so the
// offline-write + reminder logic can be exercised without a live backend.
if (typeof window !== "undefined" && window.__PHT_TEST__) {
  Object.assign(window.__PHT_TEST__, {
    settleWrite, checkHabitReminder, evaluateCycleReminder,
    pruneFiredReminderKeys, cycleRemindKey, firedKey, paintSyncChip,
    saveCycle, cycleOfflineNote,
    // activity tracker internals for the GPS test suites
    haversineM, acceptFix, fmtDist, fmtDur, fmtSpeed,
    startTracking, pauseTracking, resumeTracking, finishTracking, cancelTracking,
    restoreActSession, persistActSession, serializeAct, clearActSession,
    getAct: () => act, renderActivity, deleteAct, actSessionKey,
    heatmapRange, accountCreatedKey, earliestHabitCreatedKey, renderHeatmap, pinHeatmapScroll,
    resetActForTest() { stopActWatch(); stopActTimer(); act = null; },
  });
}
