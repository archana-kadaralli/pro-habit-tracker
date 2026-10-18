import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
  getAuth, setPersistence, browserLocalPersistence, GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD94hiQtNDHlsh5ndNUsqgECBoeJuy_8Uw",
  authDomain: "pro-habit-tracker-bb9c8.firebaseapp.com",
  projectId: "pro-habit-tracker-bb9c8",
  storageBucket: "pro-habit-tracker-bb9c8.firebasestorage.app",
  messagingSenderId: "479337550628",
  appId: "1:479337550628:web:253512b98768a1422959b1"
};

const app = initializeApp(firebaseConfig);

// Firestore offline persistence (web). The modern SDK 10.x API for a durable
// local cache is `initializeFirestore(..., { localCache: persistentLocalCache() })`
// (the old `enablePersistence()` is deprecated). This stores documents in
// IndexedDB so habits + cycle data survive refreshes and temporary offline
// periods, and queues writes to replay when connectivity returns.
// - Single-tab manager: the app is a single-user tracker; avoids the
//   multi-tab `failed-precondition` lock errors.
// - Runs exactly once, at module load, before any Firestore operation.
// - If the browser blocks IndexedDB (private mode, quota, unsupported), the
//   SDK degrades to the in-memory cache; the try/catch also covers a
//   synchronous failure. Firestore stays fully usable — just not persistent.
let _db;
try {
  _db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() }),
  });
} catch {
  _db = getFirestore(app);
}
export const db = _db;
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

// Auth session persistence (web). The SDK default for getAuth() is *local*
// (IndexedDB) persistence, which survives reloads and browser restarts — but we
// set it explicitly so the behavior cannot silently change with SDK defaults,
// and so we can detect when the browser refuses durable storage (private
// windows, blocked or evicted IndexedDB). This call starts at module load —
// before script.js can begin any sign-in flow, which awaits this promise first.
// Resolves to "local" (sessions persist) or "memory" (they will not).
export const authPersistenceReady = setPersistence(auth, browserLocalPersistence)
  .then(() => "local")
  .catch((err) => {
    console.error("Auth persistence unavailable \u2014 sessions may not survive reloads:", err);
    return "memory";
  });
