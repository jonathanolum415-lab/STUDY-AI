const authModal = document.querySelector("#auth-modal");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authTitle = document.querySelector("#auth-title");
const authMessage = document.querySelector("#auth-message");
const authSubmit = document.querySelector("#auth-submit");
const authSwitch = document.querySelector("#auth-switch");
const authLogout = document.querySelector("#auth-logout");
const authProviders = document.querySelector("#auth-providers");
const accountName = document.querySelector("#account-name");
const accountState = document.querySelector("#account-state");
const authPageForm = document.querySelector("#auth-page-form");
const authPageEmail = document.querySelector("#auth-page-email");
const authPagePassword = document.querySelector("#auth-page-password");
const authPageMessage = document.querySelector("#auth-page-message");
const authPageTitle = document.querySelector("#auth-page-title");
const authPageSubmit = document.querySelector("#auth-page-submit");
const authPageLink = document.querySelector("#auth-page-link");
const authProviderButtons = document.querySelectorAll("[data-provider]");

let currentUser = null;
let isSignup = window.location.pathname.includes("/register") || document.body.dataset.authMode === "signup";

function setAuthMessage(message, isError = false, target = authMessage) {
  if (!target) return;
  target.textContent = message;
  target.classList.toggle("error", isError);
}

function updateAccountUi() {
  if (accountName) {
    accountName.textContent = currentUser?.email || "Student";
  }
  if (accountState) {
    accountState.textContent = currentUser ? "Signed in · MySQL synced" : "Sign in";
  }
  const profileButton = document.querySelector("#profile-button");
  if (profileButton) {
    profileButton.setAttribute(
      "aria-label",
      currentUser ? "Open account options" : "Sign in to Studyspace",
    );
  }
  if (authLogout) {
    authLogout.hidden = !currentUser;
  }
  if (authSwitch) {
    authSwitch.hidden = Boolean(currentUser);
  }
  if (authForm) {
    authForm.hidden = Boolean(currentUser);
  }
  if (authTitle) {
    authTitle.textContent = currentUser
      ? "Your account"
      : isSignup
        ? "A little progress starts here."
        : "Good to see you again.";
  }
  const authDescription = document.querySelector("#auth-description");
  if (authDescription) {
    authDescription.textContent = currentUser
      ? "Your account is connected and your study data is syncing."
      : isSignup
        ? "Create an account and make this space your own."
        : "Sign in and pick up right where you left off.";
  }
  if (authProviders) {
    authProviders.hidden = Boolean(currentUser);
  }
  if (authSwitch) {
    authSwitch.textContent = isSignup ? "Already have an account? Sign in" : "New to Studyspace? Create an account";
  }
}

function showAuthModal() {
  if (!authModal || !authMessage) return;
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
  if (!authModal) return;
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

  const text = await response.text();
  let payload = {};

  if (text) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      console.error(`Unexpected non-JSON response from ${path}:`, text.slice(0, 220));
      throw new Error("The server returned an unexpected HTML response. Please reload the page and try again.");
    }

    try {
      payload = JSON.parse(text);
    } catch (error) {
      console.error(`Unable to parse JSON from ${path}:`, text.slice(0, 220));
      throw new Error("The server responded with invalid JSON. Please try again.");
    }
  }

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

async function handleAuthSubmit(event, modeOverride) {
  const mode = modeOverride ?? isSignup;
  const emailInput = authPageEmail || authEmail;
  const passwordInput = authPagePassword || authPassword;
  const messageTarget = authPageMessage || authMessage;
  const submitButton = authPageSubmit || authSubmit;
  event.preventDefault();

  const email = (emailInput.value || "").trim();
  const password = passwordInput.value;
  submitButton.disabled = true;
  submitButton.textContent = mode ? "Creating account..." : "Signing in...";
  setAuthMessage("", false, messageTarget);

  try {
    const payload = await authRequest(`/api/auth/${mode ? "signup" : "login"}`, {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (payload.confirmationRequired) {
      setAuthMessage(payload.message, false, messageTarget);
      return;
    }
    setCurrentUser(payload.user);
    passwordInput.value = "";

    if (authPageForm) {
      window.location.href = "/";
      return;
    }
    closeAuthModal();
  } catch (error) {
    setAuthMessage(error.message, true, messageTarget);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = mode ? "Create account" : "Sign in";
  }
}

function configurePageAuth(mode) {
  if (!authPageForm || !authPageLink || !authPageTitle || !authPageSubmit || !authPageMessage) return;
  const signupMode = mode === "signup";
  authPageTitle.textContent = signupMode ? "Create your account" : "Welcome back";
  authPageSubmit.textContent = signupMode ? "Create account" : "Sign in";
  authPageLink.textContent = signupMode ? "Sign in" : "Create one";
  authPageLink.href = signupMode ? "/login" : "/register";
  authPageMessage.textContent = "";
  authPageMessage.classList.remove("error");
}

function bindProviderButtons() {
  authProviderButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const provider = button.dataset.provider;
      const target = button.closest("form")?.querySelector(".auth-message") || authPageMessage || authMessage;
      try {
        const payload = await authRequest("/api/auth/social", {
          method: "POST",
          body: JSON.stringify({ provider }),
        });
        if (payload.redirectUrl) {
          window.location.href = payload.redirectUrl;
          return;
        }
        setAuthMessage(payload.message || `Continue with ${provider}.`, false, target);
      } catch (error) {
        setAuthMessage(error.message, true, target);
      }
    });
  });
}

document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.passwordToggle);
    if (!input) return;
    const shouldShow = input.type === "password";
    input.type = shouldShow ? "text" : "password";
    button.textContent = shouldShow ? "Hide" : "Show";
    button.setAttribute("aria-label", `${shouldShow ? "Hide" : "Show"} password`);
  });
});

if (authForm) {
  authForm.addEventListener("submit", (event) => handleAuthSubmit(event, isSignup));
}

if (authPageForm) {
  configurePageAuth(isSignup ? "signup" : "login");
  authPageForm.addEventListener("submit", (event) => handleAuthSubmit(event, isSignup));
  authPageLink.addEventListener("click", (event) => {
    event.preventDefault();
    isSignup = !isSignup;
    configurePageAuth(isSignup ? "signup" : "login");
    const passwordInput = authPagePassword;
    if (passwordInput) {
      passwordInput.autocomplete = isSignup ? "new-password" : "current-password";
    }
    window.location.href = isSignup ? "/register" : "/login";
  });
}

if (authSwitch) {
  authSwitch.addEventListener("click", () => {
    isSignup = !isSignup;
    authPassword.autocomplete = isSignup ? "new-password" : "current-password";
    const passwordLabel = document.querySelector("#auth-password-label");
    if (passwordLabel) {
      passwordLabel.textContent = isSignup ? "Create a password" : "Password";
    }
    authSwitch.textContent = isSignup ? "Already have an account? Sign in" : "New to Studyspace? Create an account";
    authSubmit.textContent = isSignup ? "Create account" : "Sign in";
    updateAccountUi();
    setAuthMessage("");
  });
}

if (authLogout) {
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
}

const profileButton = document.querySelector("#profile-button");
if (profileButton) {
  profileButton.addEventListener("click", showAuthModal);
}

const closeAuthButton = document.querySelector("#close-auth");
if (closeAuthButton) {
  closeAuthButton.addEventListener("click", closeAuthModal);
}

if (authModal) {
  authModal.addEventListener("click", (event) => {
    if (event.target === authModal) closeAuthModal();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && authModal && authModal.classList.contains("open")) closeAuthModal();
});

bindProviderButtons();
window.studyspaceAuth = {
  get user() {
    return currentUser;
  },
  ready: loadCurrentUser(),
  request: authRequest,
};
