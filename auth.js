const authModal = document.querySelector("#auth-modal");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authTitle = document.querySelector("#auth-title");
const authMessage = document.querySelector("#auth-message");
const authSubmit = document.querySelector("#auth-submit");
const authSwitch = document.querySelector("#auth-switch");
const authLogout = document.querySelector("#auth-logout");
const accountName = document.querySelector("#account-name");
const accountState = document.querySelector("#account-state");

let currentUser = null;
let isSignup = false;

function setAuthMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle("error", isError);
}

function updateAccountUi() {
  accountName.textContent = currentUser?.email || "Student";
  accountState.textContent = currentUser ? "Signed in · MySQL synced" : "Sign in";
  document.querySelector("#profile-button").setAttribute(
    "aria-label",
    currentUser ? "Open account options" : "Sign in to Studyspace",
  );
  authLogout.hidden = !currentUser;
  authSwitch.hidden = Boolean(currentUser);
  authForm.hidden = Boolean(currentUser);
  authTitle.textContent = currentUser ? "Account" : isSignup ? "Create account" : "Sign in";
}

function showAuthModal() {
  authMessage.textContent = "";
  authModal.classList.add("open");
  authModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  if (currentUser) {
    authLogout.focus();
  } else {
    authEmail.focus();
  }
}

function closeAuthModal() {
  authModal.classList.remove("open");
  authModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

async function authRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}

function setCurrentUser(user) {
  currentUser = user;
  updateAccountUi();
  window.dispatchEvent(new CustomEvent("studyspace:authchange", { detail: { user } }));
}

async function loadCurrentUser() {
  try {
    const payload = await authRequest("/api/auth/session");
    currentUser = payload.user;
  } catch (error) {
    if (!error.message.includes("Sign in to access")) {
      console.error("Unable to check the Studyspace sign-in session.", error);
    }
    currentUser = null;
  }
  updateAccountUi();
  return currentUser;
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authSubmit.disabled = true;
  authSubmit.textContent = isSignup ? "Creating account..." : "Signing in...";
  setAuthMessage("");
  try {
    const payload = await authRequest(`/api/auth/${isSignup ? "signup" : "login"}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (payload.confirmationRequired) {
      setAuthMessage(payload.message);
      return;
    }
    setCurrentUser(payload.user);
    authPassword.value = "";
    closeAuthModal();
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = isSignup ? "Create account" : "Sign in";
  }
});

authSwitch.addEventListener("click", () => {
  isSignup = !isSignup;
  authPassword.autocomplete = isSignup ? "new-password" : "current-password";
  authSwitch.textContent = isSignup ? "Already have an account? Sign in" : "Create an account";
  authSubmit.textContent = isSignup ? "Create account" : "Sign in";
  updateAccountUi();
  setAuthMessage("");
});

authLogout.addEventListener("click", async () => {
  authLogout.disabled = true;
  try {
    await authRequest("/api/auth/logout", { method: "POST", body: "{}" });
    setCurrentUser(null);
    closeAuthModal();
  } catch (error) {
    setAuthMessage(error.message, true);
  } finally {
    authLogout.disabled = false;
  }
});

document.querySelector("#profile-button").addEventListener("click", showAuthModal);
document.querySelector("#close-auth").addEventListener("click", closeAuthModal);
authModal.addEventListener("click", (event) => {
  if (event.target === authModal) closeAuthModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && authModal.classList.contains("open")) closeAuthModal();
});

window.studyspaceAuth = {
  get user() {
    return currentUser;
  },
  ready: loadCurrentUser(),
  request: authRequest,
};
