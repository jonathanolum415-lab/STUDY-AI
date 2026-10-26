const toast = document.querySelector("#toast");
const taskList = document.querySelector("#task-list");
const taskStat = document.querySelector("#task-stat");
const taskTotal = document.querySelector("#task-total");
const taskPercent = document.querySelector("#task-percent");
const taskProgress = document.querySelector("#task-progress");
const taskProgressTrack = document.querySelector("#task-progress-track");
const taskProgressLabel = document.querySelector("#task-progress-label");
const taskForm = document.querySelector("#task-form");
const taskInput = document.querySelector("#task-input");
const focusModal = document.querySelector("#focus-modal");
const timerDisplay = document.querySelector("#timer-display");
const timerToggle = document.querySelector("#timer-toggle");
const assistantForm = document.querySelector("#assistant-form");
const assistantInput = document.querySelector("#assistant-input");
const assistantMessages = document.querySelector("#assistant-messages");
const notesInput = document.querySelector("#notes-input");
const noteStatus = document.querySelector("#note-status");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");

const TASKS_STORAGE_KEY = "studyspace-tasks";
const starterTasks = [
  { title: "Review lecture notes", subject: "Biology", duration: 30, time: "9:00 AM", completed: true },
  { title: "Complete problem set 4", subject: "Mathematics", duration: 45, time: "10:00 AM", completed: true },
  { title: "Read chapter 6: Cell structure", subject: "Biology", duration: 25, time: "11:30 AM", completed: false },
  { title: "Practice essay outline", subject: "History", duration: 40, time: "1:00 PM", completed: false },
  { title: "Review vocabulary flashcards", subject: "English", duration: 20, time: "2:30 PM", completed: false },
].map((task, index) => ({ ...task, id: `starter-${index + 1}` }));

let toastTimeout;
let noteSaveTimeout;
let remainingSeconds = 25 * 60;
let timerInterval = null;
let previousFocus = null;
const chatHistory = [];
let studyTasks = loadStudyTasks();

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("show"), 2800);
}

function loadStudyTasks() {
  try {
    const savedTasks = window.localStorage.getItem(TASKS_STORAGE_KEY);
    if (savedTasks === null) return starterTasks;

    const parsedTasks = JSON.parse(savedTasks);
    if (
      !Array.isArray(parsedTasks) ||
      parsedTasks.some((task) =>
        !task ||
        typeof task.id !== "string" ||
        typeof task.title !== "string" ||
        typeof task.completed !== "boolean" ||
        typeof task.duration !== "number" ||
        typeof task.time !== "string",
      )
    ) {
      throw new Error("Saved study tasks have an invalid format.");
    }
    return parsedTasks;
  } catch (error) {
    showToast("Saved study tasks could not be loaded. The starter plan is shown instead.");
    console.error("Unable to load saved study tasks.", error);
    return starterTasks;
  }
}

function saveStudyTasks() {
  try {
    window.localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(studyTasks));
  } catch (error) {
    showToast("Tasks changed, but your browser could not save them.");
    console.error("Unable to save study tasks.", error);
  }
}

function updateTaskProgress() {
  const completed = studyTasks.filter((task) => task.completed).length;
  const total = studyTasks.length;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 100);
  taskStat.textContent = String(completed);
  taskTotal.textContent = String(total);
  taskPercent.textContent = `${percentage}%`;
  taskProgressLabel.textContent = total === 0
    ? "Add a task to start tracking your progress"
    : `${completed} of ${total} ${total === 1 ? "task" : "tasks"} complete`;
  taskProgress.style.width = `${percentage}%`;
  taskProgressTrack.setAttribute("aria-valuenow", String(percentage));
}

function renderStudyTasks() {
  taskList.replaceChildren();

  for (const task of studyTasks) {
    const item = document.createElement("div");
    item.className = `task-item${task.completed ? " completed" : ""}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `task-${task.id}`;
    checkbox.checked = task.completed;
    checkbox.dataset.taskId = task.id;
    checkbox.setAttribute("aria-label", `Mark ${task.title} complete`);

    const checkboxVisual = document.createElement("label");
    checkboxVisual.className = "custom-checkbox";
    checkboxVisual.htmlFor = checkbox.id;
    checkboxVisual.setAttribute("aria-hidden", "true");
    checkboxVisual.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';

    const details = document.createElement("span");
    details.className = "task-details";
    const title = document.createElement("strong");
    title.textContent = task.title;
    details.append(title);

    const metadata = document.createElement("small");
    metadata.textContent = task.subject
      ? `${task.subject} · ${task.duration} min`
      : `Personal study · ${task.duration} min`;
    details.append(metadata);

    const time = document.createElement("span");
    time.className = "task-time";
    time.textContent = task.time || "Anytime";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "task-delete";
    removeButton.dataset.taskDelete = task.id;
    removeButton.setAttribute("aria-label", `Remove ${task.title}`);
    removeButton.textContent = "×";

    item.append(checkbox, checkboxVisual, details, time, removeButton);
    taskList.append(item);
  }

  updateTaskProgress();
}

function setTimerDisplay() {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopTimer() {
  window.clearInterval(timerInterval);
  timerInterval = null;
  timerToggle.textContent = "Start focusing";
}

function openFocusModal() {
  previousFocus = document.activeElement;
  focusModal.classList.add("open");
  focusModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  document.querySelector("#close-focus").focus();
}

function closeFocusModal() {
  focusModal.classList.remove("open");
  focusModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  stopTimer();
  if (previousFocus instanceof HTMLElement) previousFocus.focus();
}

document.querySelector("#today-date").textContent = new Intl.DateTimeFormat("en", {
  weekday: "short",
  month: "short",
  day: "numeric",
}).format(new Date());

try {
  notesInput.value = window.localStorage.getItem("studyspace-notes") || "";
} catch (error) {
  noteStatus.textContent = "Storage unavailable";
  showToast("Notes cannot be loaded because browser storage is unavailable.");
  console.error("Unable to load saved study notes.", error);
}

notesInput.addEventListener("input", () => {
  noteStatus.textContent = "Saving…";
  window.clearTimeout(noteSaveTimeout);
  noteSaveTimeout = window.setTimeout(() => {
    try {
      window.localStorage.setItem("studyspace-notes", notesInput.value);
      noteStatus.textContent = "Saved";
    } catch (error) {
      noteStatus.textContent = "Not saved";
      showToast("Your notes could not be saved in this browser.");
      console.error("Unable to save study notes.", error);
    }
  }, 250);
});

renderStudyTasks();

taskList.addEventListener("change", (event) => {
  if (!(event.target instanceof HTMLInputElement) || event.target.type !== "checkbox") return;

  const task = studyTasks.find((item) => item.id === event.target.dataset.taskId);
  if (!task) return;
  task.completed = event.target.checked;
  saveStudyTasks();
  renderStudyTasks();
});

taskList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const removeButton = event.target.closest("[data-task-delete]");
  if (!removeButton) return;

  studyTasks = studyTasks.filter((task) => task.id !== removeButton.dataset.taskDelete);
  saveStudyTasks();
  renderStudyTasks();
});

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = taskInput.value.trim();
  if (!title) {
    taskInput.focus();
    return;
  }

  studyTasks.push({
    id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    subject: "",
    duration: 25,
    time: "Anytime",
    completed: false,
  });
  saveStudyTasks();
  renderStudyTasks();
  taskForm.reset();
  taskInput.focus();
  showToast("Study task added to your plan.");
});

window.addEventListener("storage", (event) => {
  if (event.key !== TASKS_STORAGE_KEY) return;

  studyTasks = loadStudyTasks();
  renderStudyTasks();
});

document.querySelector("#start-focus").addEventListener("click", openFocusModal);
document.querySelector("#sidebar-focus").addEventListener("click", openFocusModal);
document.querySelector("#close-focus").addEventListener("click", closeFocusModal);
focusModal.addEventListener("click", (event) => {
  if (event.target === focusModal) closeFocusModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && focusModal.classList.contains("open")) closeFocusModal();
});

timerToggle.addEventListener("click", () => {
  if (timerInterval) {
    stopTimer();
    return;
  }

  if (remainingSeconds === 0) remainingSeconds = 25 * 60;
  timerToggle.textContent = "Pause session";
  timerInterval = window.setInterval(() => {
    remainingSeconds -= 1;
    setTimerDisplay();
    if (remainingSeconds <= 0) {
      stopTimer();
      showToast("Focus session complete — time for a short break!");
    }
  }, 1000);
});

document.querySelector("#timer-reset").addEventListener("click", () => {
  stopTimer();
  remainingSeconds = 25 * 60;
  setTimerDisplay();
});

function addChatMessage(content, role, pending = false) {
  const message = document.createElement("div");
  message.className = `assistant-message ${role}${pending ? " pending" : ""}`;
  message.textContent = content;
  assistantMessages.append(message);
  assistantMessages.scrollTop = assistantMessages.scrollHeight;
  return message;
}

assistantForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = assistantInput.value.trim();
  if (!question) {
    assistantInput.focus();
    showToast("Type a question or choose a prompt to get started.");
    return;
  }
  const sendButton = assistantForm.querySelector('button[type="submit"]');
  if (sendButton.disabled) return;

  chatHistory.push({ role: "user", content: question });
  addChatMessage(question, "user");
  assistantInput.value = "";
  assistantInput.disabled = true;
  sendButton.disabled = true;
  sendButton.setAttribute("aria-label", "Sending question");
  const pendingMessage = addChatMessage("Thinking through that with you...", "assistant", true);

  try {
    if (window.location.protocol === "file:") {
      throw new Error("Open Studyspace at http://127.0.0.1:3000 so the study assistant can connect to its local server.");
    }

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory.slice(-12) }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(typeof result.error === "string" ? result.error : "The assistant couldn't answer right now.");
    }
    if (typeof result.reply !== "string" || !result.reply.trim()) {
      throw new Error("The assistant returned an empty response. Please try again.");
    }
    chatHistory.push({ role: "assistant", content: result.reply });
    pendingMessage.classList.remove("pending");
    pendingMessage.textContent = result.reply;
    assistantMessages.scrollTop = assistantMessages.scrollHeight;
  } catch (error) {
    pendingMessage.remove();
    const message = error instanceof Error ? error.message : "The assistant couldn't answer right now.";
    addChatMessage(message, "assistant");
  } finally {
    assistantInput.disabled = false;
    sendButton.disabled = false;
    sendButton.setAttribute("aria-label", "Send question");
    assistantInput.focus();
  }
});

document.querySelectorAll(".prompt-chip").forEach((button) => {
  button.addEventListener("click", () => {
    assistantInput.value = button.dataset.prompt;
    assistantInput.focus();
    const selection = button.dataset.select;
    if (selection) {
      const start = assistantInput.value.indexOf(selection);
      assistantInput.setSelectionRange(start, start + selection.length);
    }
  });
});

document.querySelectorAll(".nav-link[data-view]").forEach((link) => {
  link.addEventListener("click", () => {
    document.querySelectorAll(".nav-link[data-view]").forEach((item) => item.classList.remove("active"));
    link.classList.add("active");
    document.querySelector("#breadcrumb-current").textContent = link.querySelector("span").textContent;
    if (link.dataset.view !== "overview") showToast(`${link.querySelector("span").textContent} is part of your study workspace.`);
    document.body.classList.remove("nav-open");
    document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
  });
});

document.querySelector("#mobile-menu").addEventListener("click", (event) => {
  const isOpen = document.body.classList.toggle("nav-open");
  event.currentTarget.setAttribute("aria-expanded", String(isOpen));
});

function closeMobileNavigation() {
  document.body.classList.remove("nav-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}

sidebarBackdrop.addEventListener("click", closeMobileNavigation);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("nav-open")) {
    closeMobileNavigation();
    document.querySelector("#mobile-menu").focus();
  }
});

document.querySelector("#sidebar-assistant").addEventListener("click", () => {
  assistantInput.focus();
  document.querySelector("#assistant-card").scrollIntoView({ behavior: "smooth", block: "center" });
});

document.querySelector("#clear-completed-tasks").addEventListener("click", () => {
  const incompleteTasks = studyTasks.filter((task) => !task.completed);
  if (incompleteTasks.length === studyTasks.length) {
    showToast("There are no completed tasks to clear.");
    return;
  }

  studyTasks = incompleteTasks;
  saveStudyTasks();
  renderStudyTasks();
  showToast("Completed tasks cleared.");
});
document.querySelector("#week-selector").addEventListener("click", () => showToast("Weekly activity is shown for the current week."));
document.querySelector("#notification-button").addEventListener("click", () => showToast("You're all caught up — no new notifications."));
document.querySelector("#profile-button").addEventListener("click", () => showToast("Profile settings are coming soon."));
