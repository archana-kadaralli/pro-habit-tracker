import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentSingleTabManager,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

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
