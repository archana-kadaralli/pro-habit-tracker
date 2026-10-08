import { db, auth, googleProvider } from "./firebase.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, arrayUnion, arrayRemove, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signOut
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
let confirmResolve = null;
function askConfirm(text) {
  $("confirmText").textContent = text;
  $("confirmModal").hidden = false;
  return new Promise((res) => { confirmResolve = res; });
}

/* ================= Theme ================= */
const themeStore = localStorage.getItem("pht_theme") || "system";
function applyTheme(mode) {
  const pick = mode === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = pick;
  const label = pick === "dark" ? "Light mode" : "Dark mode";
  for (const id of ["themeToggle", "themeToggleSide"]) { const b = $(id); if (b) { b.textContent = label; b.setAttribute("aria-pressed", String(pick === "dark")); } }
  if ($("themeSelect")) $("themeSelect").value = mode;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(localStorage.getItem("pht_theme") || "system"));

/* ================= State ================= */
let user = null;
let habits = [];
let unsub = null;
let activeView = "dashboard";
let detailId = null;
let selectedDay = null;
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
  const weekDone = weekKeys.reduce((a, k) => a + habits.reduce((x, h) => x + ((h.completions || []).includes(k) ? 1 : 0), 0), 0);
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
    { id: "s7", name: "7-day streak", desc: "Reach a 7-day streak on any habit", ok: anyStreak >= 7 },
    { id: "s14", name: "14-day streak", desc: "Reach a 14-day streak on any habit", ok: anyStreak >= 14 },
    { id: "s30", name: "30-day streak", desc: "Reach a 30-day streak on any habit", ok: anyStreak >= 30 },
    { id: "c50", name: "50 completions", desc: "Complete habits 50 times in total", ok: total >= 50 },
    { id: "c100", name: "100 completions", desc: "Complete habits 100 times in total", ok: total >= 100 },
    { id: "week", name: "Strong week", desc: "Reach 80%+ completion over the last 7 days", ok: stats.weekRate >= 80 && stats.per.length > 0 },
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
}
function authErr(msg) { const e = $("authError"); e.hidden = !msg; e.textContent = msg || ""; }

/* ================= Firestore paths ================= */
const habitsCol = () => collection(db, "users", user.uid, "habits");
const habitDoc = (id) => doc(db, "users", user.uid, "habits", id);

/* ================= CRUD ================= */
async function saveHabit(e) {
  e?.preventDefault();
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
    $("saveHabitBtn").disabled = true;
    if (id) { await updateDoc(habitDoc(id), payload); toast("Habit updated."); }
    else {
      await addDoc(habitsCol(), { ...payload, completions: [], createdAt: serverTimestamp() });
      // ensure profile doc exists
      await setDoc(doc(db, "users", user.uid), { email: user.email || "", updatedAt: serverTimestamp() }, { merge: true });
      toast("Habit created. Good luck!", "ok");
    }
    closeHabitModal();
  } catch (err) { console.error(err); formErr(friendlyErr(err)); }
  finally { $("saveHabitBtn").disabled = false; }
}
function formErr(m) { const e = $("formError"); e.hidden = !m; e.textContent = m || ""; }
async function toggleDone(id, dateKey = todayKey()) {
  const h = habits.find((x) => x.id === id);
  if (!h) return;
  if (!isScheduled(h, dateKey)) { toast("This habit isn't scheduled for that day."); return; }
  try {
    const has = (h.completions || []).includes(dateKey);
    await updateDoc(habitDoc(id), {
      completions: has ? arrayRemove(dateKey) : arrayUnion(dateKey),
      updatedAt: serverTimestamp(),
    });
    if (!has && dateKey === todayKey()) toast(`"${h.name}" completed!`, "ok");
  } catch (err) { console.error(err); toast(friendlyErr(err), "err"); }
}
async function removeHabit(id) {
  const h = habits.find((x) => x.id === id);
  const ok = await askConfirm(`Delete "${h?.name ?? "this habit"}" and its full history? This cannot be undone.`);
  if (!ok) return;
  try { await deleteDoc(habitDoc(id)); toast("Habit deleted."); if (detailId === id) closeDetail(); }
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
  return `<article class="habit-card" data-open="${h.id}" tabindex="0" role="button" aria-label="Open ${esc(h.name)} details">
    <div class="habit-card-top">
      <span class="habit-dot" style="background:${esc(h.color || "#2f6df6")}" aria-hidden="true">${esc(h.icon || "◉")}</span>
      <div class="habit-meta"><b>${esc(h.name)}</b><span class="habit-sub">${esc(h.category || "Other")} · ${s.doneToday ? "Done today" : (isScheduled(h, todayKey()) ? "To do today" : "Not scheduled today")}</span></div>
      <span class="streak-chip">${s.current}d streak</span>
    </div>
    <div class="progress" aria-hidden="true"><div class="progress-fill" style="width:${s.rate}%"></div></div>
    <div class="rate-line"><span>${s.rate}% · ${s.total} completions</span><span>Best ${s.longest}d</span></div>
    <div class="habit-actions" style="margin-top:10px">
      <button class="mini-btn ${s.doneToday ? "done-state" : ""}" data-toggle="${h.id}">${s.doneToday ? "✓ Done" : "Mark done"}</button>
      <button class="mini-btn" data-edit="${h.id}">Edit</button>
      <button class="mini-btn" data-del="${h.id}">Delete</button>
    </div>
  </article>`;
}
function renderAll() {
  if (!user) return;
  showError(null);
  renderDashboard(); renderHabitsView(); renderHeatmap(); renderAnalytics(); renderAchievements(); renderSettingsMeta();
  if (detailId) renderDetailBody();
}
function renderDashboard() {
  const hr = new Date().getHours();
  $("greeting").textContent = `${hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}${user?.email ? ", " + esc(user.email.split("@")[0]) : ""}`;
  $("dateLine").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const st = accountStats();
  const cards = [
    { k: "Today", v: `${st.todayDone}/${st.schedToday}`, s: "completed" },
    { k: "Week rate", v: `${st.weekRate}%`, s: "last 7 days" },
    { k: "Best streak", v: st.best ? `${st.best.s.longest}d` : "—", s: st.best ? st.best.h.name : "no data" },
    { k: "Total done", v: String(st.totalDone), s: "all time" },
  ];
  $("statCards").innerHTML = cards.map((c) => `<div class="stat"><div class="k">${c.k}</div><div class="v">${esc(c.v)}</div><div class="muted small">${esc(c.s)}</div></div>`).join("");
  const pct = st.schedToday ? Math.round((st.todayDone / st.schedToday) * 100) : 0;
  $("todayCount").textContent = `${st.todayDone}/${st.schedToday}`;
  $("todayProgress").style.width = `${pct}%`;
  const todays = habits.filter((h) => isScheduled(h, todayKey()));
  $("todayList").innerHTML = todays.length ? todays.map((h) => {
    const s = calcHabitStats(h);
    return `<div class="habit-row ${s.doneToday ? "done" : ""}">
      <span class="habit-dot" style="background:${esc(h.color)}" aria-hidden="true">${esc(h.icon)}</span>
      <div class="habit-meta"><b>${esc(h.name)}</b><span class="habit-sub">${esc(h.category)} · ${s.current}d streak</span></div>
      <div class="habit-actions">
        <button class="mini-btn ${s.doneToday ? "done-state" : ""}" data-toggle="${h.id}" aria-pressed="${s.doneToday}">${s.doneToday ? "✓ Done" : "Mark done"}</button>
        <button class="mini-btn" data-open-btn="${h.id}">Details</button>
      </div></div>`;
  }).join("") : `<div class="empty"><h3>Nothing scheduled today</h3><p>Create a habit or adjust its schedule.</p></div>`;
  // week strip
  $("weekStrip").innerHTML = [...Array(7)].map((_, i) => {
    const d = addDays(new Date(), i - 3);
    const k = toKey(d);
    const n = habits.reduce((a, h) => a + ((h.completions || []).includes(k) ? 1 : 0), 0);
    return `<div class="day-cell ${k === todayKey() ? "today" : ""}"><b>${d.toLocaleDateString(undefined, { weekday: "short" })}</b><div style="font-weight:800">${n}</div><span class="muted small">${d.getDate()}</span></div>`;
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
  const list = filteredHabits();
  $("allHabits").innerHTML = list.length ? list.map((p) => habitCardHTML(p.h, p.s)).join("")
    : `<div class="empty card"><h3>No habits match</h3><p>Try clearing search/filters, or create a new habit.</p></div>`;
}
function renderHeatmap() {
  const sel = $("heatmapHabit").value || "__all";
  const prev = sel;
  $("heatmapHabit").innerHTML = `<option value="__all">All habits</option>` + habits.map((h) => `<option value="${h.id}">${esc(h.name)}</option>`).join("");
  if ([...$("heatmapHabit").options].some((o) => o.value === prev)) $("heatmapHabit").value = prev;
  const focus = $("heatmapHabit").value;
  const counts = {};
  const list = focus === "__all" ? habits : habits.filter((h) => h.id === focus);
  for (const h of list) for (const k of (h.completions || [])) counts[k] = (counts[k] || 0) + 1;
  const max = Math.max(1, ...Object.values(counts));
  const end = new Date(); const start = addDays(end, -104);
  // align start to Monday for stable grid
  const d0 = addDays(start, -((start.getDay() + 6) % 7));
  let html = "";
  for (let d = new Date(d0); d <= end; d = addDays(d, 1)) {
    const k = toKey(d);
    const c = counts[k] || 0;
    const lvl = c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4));
    const future = d > new Date();
    html += `<button class="hm-cell ${selectedDay === k ? "sel" : ""}" data-l="${lvl}" data-day="${k}" role="gridcell" aria-label="${k}: ${c} completions" title="${k}: ${c}" ${future ? "disabled" : ""} style="${future ? "opacity:.3" : ""}"></button>`;
  }
  $("heatmap").innerHTML = html;
  renderDayDetail();
}
function renderDayDetail() {
  const box = $("dayDetail");
  if (!selectedDay) { box.innerHTML = `<p class="muted">Click a day to see its activity.</p>`; return; }
  const items = habits.filter((h) => (h.completions || []).includes(selectedDay));
  box.innerHTML = `<b>${esc(selectedDay)}</b> — ${items.length} completion${items.length === 1 ? "" : "s"}` +
    (items.length ? `<ul class="insights">${items.map((h) => `<li>${esc(h.icon)} ${esc(h.name)} (${esc(h.category)})</li>`).join("")}</ul>`
      : `<p class="muted">No completions. ${calcMissed(selectedDay)} habit(s) were scheduled but missed.</p>`);
}
function calcMissed(key) { return habits.filter((h) => isScheduled(h, key) && !(h.completions || []).includes(key) && key !== todayKey()).length; }
function renderAnalytics() {
  const st = accountStats();
  const cards = [
    { k: "7-day rate", v: `${st.weekRate}%` }, { k: "Today", v: `${st.todayDone}/${st.schedToday}` },
    { k: "Current best", v: st.best ? `${st.best.s.current}d` : "—" }, { k: "Longest ever", v: st.best ? `${st.best.s.longest}d` : "—" },
  ];
  $("analyticsStats").innerHTML = cards.map((c) => `<div class="stat"><div class="k">${c.k}</div><div class="v">${esc(c.v)}</div></div>`).join("");
  // last 7 days bars (absolute completions)
  const wk = [...Array(7)].map((_, i) => { const d = addDays(new Date(), i - 6); return { k: toKey(d), label: d.toLocaleDateString(undefined, { weekday: "short" }), n: habits.reduce((a, h) => a + ((h.completions || []).includes(toKey(d)) ? 1 : 0), 0) }; });
  const wmax = Math.max(1, ...wk.map((x) => x.n));
  $("chartWeek").innerHTML = wk.map((x) => `<div class="bar"><i style="height:${Math.max(4, (x.n / wmax) * 120)}px"></i><span>${x.label}</span><span><b>${x.n}</b></span></div>`).join("");
  // last 30 days in 6 buckets of 5 days
  const buckets = [...Array(6)].map((_, b) => {
    const from = addDays(new Date(), -(29 - b * 5) - 4), to = addDays(new Date(), -(29 - b * 5));
    let n = 0; for (let d = new Date(from); d <= to; d = addDays(d, 1)) n += habits.reduce((a, h) => a + ((h.completions || []).includes(toKey(d)) ? 1 : 0), 0);
    return { label: `${to.getDate()}/${to.getMonth() + 1}`, n };
  });
  const bmax = Math.max(1, ...buckets.map((x) => x.n));
  $("chartMonth").innerHTML = buckets.map((x) => `<div class="bar"><i style="height:${Math.max(4, (x.n / bmax) * 120)}px"></i><span>${x.label}</span><span><b>${x.n}</b></span></div>`).join("");
  const per = [...st.per].sort((a, b) => b.s.rate - a.s.rate).slice(0, 6);
  $("chartHabits").innerHTML = per.length ? per.map((p) => `<div class="hbar"><span>${esc(p.h.name.slice(0, 20))}</span><div class="track"><div class="fill" style="width:${p.s.rate}%"></div></div><b>${p.s.rate}%</b></div>`).join("") : `<p class="muted">No habits yet.</p>`;
  const cats = {};
  for (const p of st.per) { (cats[p.h.category] ||= { d: 0, s: 0 }); cats[p.h.category].d += p.s.completed; cats[p.h.category].s += p.s.scheduledTotal; }
  const rows = Object.entries(cats).map(([c, v]) => ({ c, r: v.s ? Math.round((v.d / v.s) * 100) : 0 })).sort((a, b) => b.r - a.r);
  $("chartCategories").innerHTML = rows.length ? rows.map((x) => `<div class="hbar"><span>${esc(x.c)}</span><div class="track"><div class="fill" style="width:${x.r}%"></div></div><b>${x.r}%</b></div>`).join("") : `<p class="muted">No data yet.</p>`;
}
function renderAchievements() {
  const st = accountStats();
  const xp = xpFor(st), lv = levelFor(xp);
  $("xpLevel").textContent = `Level ${lv.level}`;
  $("xpFill").style.width = `${(lv.into / 200) * 100}%`;
  $("xpText").textContent = `${xp} XP · ${200 - lv.into} XP to Level ${lv.level + 1} · ${st.totalDone} total completions`;
  $("badges").innerHTML = milestones(st).map((m) =>
    `<div class="badge ${m.ok ? "earned" : "locked"}"><div class="t">${m.ok ? "✓" : "○"} ${esc(m.name)}</div><p class="muted small">${esc(m.desc)}</p><span class="pill">${m.ok ? "Earned" : "Locked"}</span></div>`).join("");
}
function renderSettingsMeta() {
  $("settingsEmail").textContent = user?.email || "—";
  $("dataPath").textContent = `users/${user?.uid || "{uid}"}/habits`;
  const r = loadReminders();
  $("reminderTime").value = r.time; $("reminderEnabled").checked = r.enabled;
  updateNotifStatus();
}

/* ================= Detail modal ================= */
function renderDetailBody() {
  const h = habits.find((x) => x.id === detailId);
  if (!h) return;
  const s = calcHabitStats(h);
  const recent = [...(h.completions || [])].sort().reverse().slice(0, 10);
  const last35 = [...Array(35)].map((_, i) => toKey(addDays(new Date(), i - 34)));
  $("detailTitle").textContent = `${h.icon || ""} ${h.name}`;
  $("detailBody").innerHTML = `
    <p class="muted">${esc(h.category || "")} · ${esc(h.frequency?.type || "daily")} · since ${esc(habitCreatedKey(h))}</p>
    ${h.description ? `<p>${esc(h.description)}</p>` : ""}
    <div class="grid stats-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="stat"><div class="k">Streak</div><div class="v">${s.current}</div></div>
      <div class="stat"><div class="k">Longest</div><div class="v">${s.longest}</div></div>
      <div class="stat"><div class="k">Rate</div><div class="v">${s.rate}%</div></div>
      <div class="stat"><div class="k">Total</div><div class="v">${s.total}</div></div>
    </div>
    <h4>Last 35 days</h4>
    <div style="display:flex;gap:5px;flex-wrap:wrap">${last35.map((k) => {
      const done = (h.completions || []).includes(k);
      const sched = isScheduled(h, k);
      const bg = done ? "var(--good)" : sched ? "var(--surface-2)" : "transparent";
      return `<span title="${k}${done ? " ✓" : sched ? " (scheduled)" : " (off-day)"}" style="width:18px;height:18px;border-radius:5px;border:1px solid var(--border);background:${bg};display:inline-block"></span>`;
    }).join("")}</div>
    <h4>Recent completions</h4>
    ${recent.length ? `<ul class="insights">${recent.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : `<p class="muted">No completions yet — mark today done to start your streak.</p>`}`;
  $("detailToggleBtn").textContent = s.doneToday ? "Undo today" : "Mark today done";
}
function openDetail(id) { detailId = id; renderDetailBody(); $("detailModal").hidden = false; }
function closeDetail() { detailId = null; $("detailModal").hidden = true; }

/* ================= Habit modal ================= */
function paintSwatches() {
  $("colorSwatches").innerHTML = COLORS.map((c) =>
    `<button type="button" class="swatch ${c === pickedColor ? "sel" : ""}" data-color="${c}" style="background:${c}" role="radio" aria-checked="${c === pickedColor}" aria-label="Color ${c}"></button>`).join("");
}
function paintDays() {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  $("daysRow").innerHTML = names.map((n, i) => `<label><input type="checkbox" value="${i}" ${[1, 2, 3, 4, 5].includes(i) ? "checked" : ""}>${n}</label>`).join("");
}
function openHabitModal(h = null) {
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
  $("habitModal").hidden = false;
  setTimeout(() => $("fName").focus(), 30);
}
function closeHabitModal() { $("habitModal").hidden = true; }

/* ================= Reminders ================= */
const reminderKey = () => `pht_reminders_${user?.uid || "anon"}`;
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
setInterval(() => {
  if (!user) return;
  const r = loadReminders();
  if (!r.enabled) return;
  const now = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  if (now !== r.time) return;
  if (localStorage.getItem(`pht_fired_${user.uid}_${now}_${todayKey()}`)) return;
  localStorage.setItem(`pht_fired_${user.uid}_${now}_${todayKey()}`, "1");
  const left = habits.filter((h) => isScheduled(h, todayKey()) && !(h.completions || []).includes(todayKey()));
  const msg = left.length ? `You still have ${left.length} habit(s) to complete today.` : "All habits done for today. Nice work!";
  if ("Notification" in window && Notification.permission === "granted") { try { new Notification("Habit reminder", { body: msg }); } catch { toast(msg); } }
  else toast(msg);
}, 20000);

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
  $("menuBtn").setAttribute("aria-expanded", "false");
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
      if (authMode === "login") await signInWithEmailAndPassword(auth, email, pw);
      else await createUserWithEmailAndPassword(auth, email, pw);
    } catch (err) { console.error(err); authErr(friendlyErr(err)); }
    finally { $("authSubmit").disabled = false; }
  });
  $("googleBtn").onclick = async () => {
    authErr(null);
    try { await signInWithPopup(auth, googleProvider); }
    catch (err) { console.error(err); authErr(err?.code === "auth/popup-closed-by-user" ? "Google sign-in was closed before completing." : friendlyErr(err)); }
  };
  $("logoutBtn").onclick = () => signOut(auth);
  document.querySelectorAll(".nav-item").forEach((b) => { b.onclick = () => go(b.dataset.nav); });
  $("menuBtn").onclick = () => {
    const s = document.querySelector(".sidebar");
    const open = s.classList.toggle("open");
    $("menuBtn").setAttribute("aria-expanded", String(open));
  };
  $("addHabitBtn").onclick = () => openHabitModal();
  $("addHabitTopBtn").onclick = () => openHabitModal();
  $("cancelHabitBtn").onclick = closeHabitModal;
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
    const t = e.target.closest("[data-toggle]");
    if (t) { e.stopPropagation(); await toggleDone(t.dataset.toggle); return; }
    const ed = e.target.closest("[data-edit]");
    if (ed) { e.stopPropagation(); const h = habits.find((x) => x.id === ed.dataset.edit); openHabitModal(h); return; }
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); await removeHabit(del.dataset.del); return; }
    const op = e.target.closest("[data-open]");
    if (op) { openDetail(op.dataset.open); return; }
    const ob = e.target.closest("[data-open-btn]");
    if (ob) { e.stopPropagation(); openDetail(ob.dataset.openBtn); return; }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches?.('[data-open]')) openDetail(e.target.dataset.open);
    if (e.key === "Escape") { closeHabitModal(); closeDetail(); $("confirmModal").hidden = true; }
  });
  $("closeDetailBtn").onclick = closeDetail;
  $("detailEditBtn").onclick = () => { const h = habits.find((x) => x.id === detailId); closeDetail(); openHabitModal(h); };
  $("detailDeleteBtn").onclick = () => removeHabit(detailId);
  $("detailToggleBtn").onclick = async () => { await toggleDone(detailId); };
  $("confirmCancel").onclick = () => { $("confirmModal").hidden = true; confirmResolve?.(false); };
  $("confirmOk").onclick = () => { $("confirmModal").hidden = true; confirmResolve?.(true); };
  const setTheme = (m) => { localStorage.setItem("pht_theme", m); applyTheme(m); };
  $("themeSelect").onchange = (e) => setTheme(e.target.value);
  $("themeToggle").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("themeToggleSide").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("reminderTime").onchange = (e) => saveReminders({ time: e.target.value });
  $("reminderEnabled").onchange = async (e) => {
    if (e.target.checked && "Notification" in window && Notification.permission === "default") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
      updateNotifStatus();
    }
    saveReminders({ enabled: e.target.checked });
    toast(e.target.checked ? "Daily reminder enabled." : "Daily reminder disabled.");
  };
  $("testNotifBtn").onclick = async () => {
    if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
    if ("Notification" in window && Notification.permission === "granted") { try { new Notification("Pro Habit Tracker", { body: "Reminders are working." }); } catch { toast("Reminders are working."); } }
    else toast("Notifications blocked — in-app reminders will still appear.", "err");
    updateNotifStatus();
  };
  ["habitModal", "detailModal", "confirmModal"].forEach((id) => {
    $(id).addEventListener("click", (e) => {
      if (e.target.id === id) { $(id).hidden = true; if (id === "confirmModal") confirmResolve?.(false); if (id === "detailModal") detailId = null; }
    });
  });
}

/* ================= Boot ================= */
function subscribe() {
  unsub?.();
  $("loadingBar").hidden = false;
  unsub = onSnapshot(habitsCol(), (snap) => {
    habits = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Backfill safety: old docs used lastDone/streak without completions
    habits = habits.map((h) => ({ completions: [], ...h }));
    $("loadingBar").hidden = true;
    showError(null);
    renderAll();
  }, (err) => {
    console.error(err);
    $("loadingBar").hidden = true;
    showError(friendlyErr(err) + " (Check Firestore rules: users/{uid}/habits must allow your own uid.)");
  });
}
onAuthStateChanged(auth, (u) => {
  user = u;
  const logged = !!u;
  $("authView").hidden = logged;
  $("appShell").hidden = !logged;
  if (logged) {
    $("userEmail").textContent = u.email || "Account";
    subscribe(); go("dashboard");
  } else {
    unsub?.(); habits = []; detailId = null;
  }
});
applyTheme(themeStore);
setAuthMode("login");
bind();
