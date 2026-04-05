import { db } from "./firebase.js";
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc } 
from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

let habits = [];

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addBtn").addEventListener("click", addHabit);
  loadHabits();
});

// ➕ ADD HABIT
async function addHabit() {
  let input = document.getElementById("habitInput");
  let habitName = input.value.trim();

  if (habitName === "") {
    alert("Enter something");
    return;
  }

  await addDoc(collection(db, "habits"), {
    name: habitName,
    streak: 0,
    longest: 0,
    lastDone: null
  });

  input.value = "";
  loadHabits();
}

// 📥 LOAD HABITS
async function loadHabits() {
  const querySnapshot = await getDocs(collection(db, "habits"));

  habits = [];

  querySnapshot.forEach((docSnap) => {
    habits.push({
      id: docSnap.id,
      ...docSnap.data()
    });
  });

  displayHabits();
}

// 📺 DISPLAY
function displayHabits() {
  let list = document.getElementById("habitList");
  list.innerHTML = "";

  if (habits.length === 0) {
    list.innerHTML = "<p>No habits added yet 😴</p>";
    return;
  }

  habits.forEach((habit, index) => {

    let progress = Math.min((habit.streak / 7) * 100, 100);

    list.innerHTML += `
      <div class="card">
        <h3>${habit.name}</h3>

        <p>🔥 Streak: ${habit.streak} days</p>
       <p>🏆 Longest: ${isNaN(habit.longest) ? "None" : habit.longest + " days"}</p>
        <p>📅 Last Done: ${habit.lastDone || "Not yet"}</p>

        <div class="progress-container">
          <div class="progress-bar" style="width:${progress}%"></div>
        </div>

        <button onclick="markDone(${index})">Done</button>
        <button onclick="deleteHabit('${habit.id}')">Delete</button>
      </div>
    `;
  });
}

// ❌ DELETE
async function deleteHabit(id) {
  await deleteDoc(doc(db, "habits", id));
  loadHabits();
}

// ✅ MARK DONE
async function markDone(index) {
  const habit = habits[index];

  const today = new Date().toDateString();

  if (habit.lastDone === today) {
    alert("Already completed today!");
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  let newStreak =
    habit.lastDone === yesterday.toDateString()
      ? habit.streak + 1
      : 1;

  let newLongest = Math.max(habit.longest, newStreak);

  await updateDoc(doc(db, "habits", habit.id), {
    streak: newStreak,
    longest: newLongest,
    lastDone: today
  });

  loadHabits();
}

// 🔥 MAKE BUTTONS WORK WITH MODULES
window.markDone = markDone;
window.deleteHabit = deleteHabit;