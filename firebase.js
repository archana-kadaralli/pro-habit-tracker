import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD94hiQtNDHlsh5ndNUsqgECBoeJuy_8Uw",
  authDomain: "pro-habit-tracker-bb9c8.firebaseapp.com",
  projectId: "pro-habit-tracker-bb9c8",
  storageBucket: "pro-habit-tracker-bb9c8.firebasestorage.app",
  messagingSenderId: "479337550628",
  appId: "1:479337550628:web:253512b98768a1422959b1"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);