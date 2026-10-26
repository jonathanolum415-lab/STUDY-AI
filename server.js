"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const AI_API_KEY = process.env.AI_API_KEY;
const AI_API_URL = process.env.AI_API_URL || "https://api.openai.com/v1/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const FALLBACK_MODE = process.env.AI_FALLBACK_MODE !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const AUTH_COOKIE_NAMES = ["studyspace_access", "studyspace_refresh"];
const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 4000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 20;
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/auth.js", ["auth.js", "text/javascript; charset=utf-8"]],
]);
const rateLimits = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function supabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

function parseCookies(request) {
  const cookieHeader = request.headers.cookie || "";
  return Object.fromEntries(
    cookieHeader.split(";").map((part) => {
      const separator = part.indexOf("=");
      if (separator < 0) return ["", ""];
      return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
    }).filter(([name]) => name),
  );
}

function cookieOptions(request, maxAge) {
  const secure = request.socket.encrypted || process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function setAuthCookies(request, response, session) {
  const maxAge = Math.max(0, Number(session.expires_in) || 3600);
  response.setHeader("Set-Cookie", [
    `studyspace_access=${encodeURIComponent(session.access_token)}; ${cookieOptions(request, maxAge)}`,
    `studyspace_refresh=${encodeURIComponent(session.refresh_token)}; ${cookieOptions(request, 60 * 60 * 24 * 30)}`,
  ]);
}

function clearAuthCookies(request, response) {
  response.setHeader("Set-Cookie", AUTH_COOKIE_NAMES.map(
    (name) => `${name}=; ${cookieOptions(request, 0)}`,
  ));
}

function verifySameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    sendJson(response, 403, { error: "The request origin is not allowed." });
    return false;
  }
  if (parsedOrigin.host !== request.headers.host) {
    sendJson(response, 403, { error: "The request origin is not allowed." });
    return false;
  }
  return true;
}

async function supabaseRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Supabase returned an invalid response.");
    }
  }
  return { response, payload };
}

function getSupabaseError(payload, fallback) {
  const message = payload?.msg || payload?.message || payload?.error_description || payload?.error;
  return typeof message === "string" ? message : fallback;
}

async function requireUser(request, response) {
  if (!supabaseConfigured()) {
    sendJson(response, 503, { error: "Supabase is not configured on the server." });
    return null;
  }

  const cookies = parseCookies(request);
  let accessToken = cookies.studyspace_access;
  const refreshToken = cookies.studyspace_refresh;
  if (!accessToken) {
    sendJson(response, 401, { error: "Sign in to access your tasks and notes." });
    return null;
  }

  let result = await supabaseRequest("/auth/v1/user", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.response.status === 401 && refreshToken) {
    const refreshed = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!refreshed.response.ok || !refreshed.payload?.access_token) {
      clearAuthCookies(request, response);
      sendJson(response, 401, { error: "Your session expired. Please sign in again." });
      return null;
    }
    setAuthCookies(request, response, refreshed.payload);
    accessToken = refreshed.payload.access_token;
    result = await supabaseRequest("/auth/v1/user", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!result.response.ok || !result.payload?.id) {
    clearAuthCookies(request, response);
    sendJson(response, 401, { error: "Your session is invalid. Please sign in again." });
    return null;
  }

  return { user: result.payload, accessToken };
}

async function handleAuth(request, response, pathname) {
  if (!supabaseConfigured()) {
    sendJson(response, 503, { error: "Supabase is not configured on the server." });
    return;
  }
  if (request.method !== "POST" && pathname !== "/api/auth/session") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST for authentication actions." });
    return;
  }
  if (request.method !== "GET" && !verifySameOrigin(request, response)) return;

  if (pathname === "/api/auth/session" && request.method === "GET") {
    const session = await requireUser(request, response);
    if (session) sendJson(response, 200, { user: { id: session.user.id, email: session.user.email } });
    return;
  }

  if (pathname === "/api/auth/logout") {
    const cookies = parseCookies(request);
    if (cookies.studyspace_access) {
      const { response: logoutResponse } = await supabaseRequest("/auth/v1/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${cookies.studyspace_access}` },
      });
      if (!logoutResponse.ok) console.error(`Supabase logout returned HTTP ${logoutResponse.status}.`);
    }
    clearAuthCookies(request, response);
    sendJson(response, 200, { ok: true });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request, response);
  } catch {
    return;
  }
  if (
    typeof payload?.email !== "string" ||
    payload.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) ||
    typeof payload.password !== "string" ||
    payload.password.length < 8 ||
    payload.password.length > 128
  ) {
    sendJson(response, 400, { error: "Enter a valid email and a password between 8 and 128 characters." });
    return;
  }

  const isSignup = pathname === "/api/auth/signup";
  if (!isSignup && pathname !== "/api/auth/login") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const authEndpoint = isSignup
    ? "/auth/v1/signup"
    : "/auth/v1/token?grant_type=password";
  const { response: authResponse, payload: authPayload } = await supabaseRequest(authEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: payload.email.trim(), password: payload.password }),
  });
  if (!authResponse.ok) {
    sendJson(response, authResponse.status, {
      error: getSupabaseError(authPayload, "Authentication failed. Please try again."),
    });
    return;
  }
  if (!authPayload?.access_token || !authPayload?.refresh_token) {
    sendJson(response, 200, {
      user: authPayload?.user ? { id: authPayload.user.id, email: authPayload.user.email } : null,
      confirmationRequired: true,
      message: "Check your email to confirm your account, then sign in.",
    });
    return;
  }

  setAuthCookies(request, response, authPayload);
  sendJson(response, 200, {
    user: { id: authPayload.user.id, email: authPayload.user.email },
  });
}

async function handleUserData(request, response, pathname, url) {
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, PATCH, PUT, DELETE");
    sendJson(response, 405, { error: "This method is not allowed." });
    return;
  }
  if (request.method !== "GET" && !verifySameOrigin(request, response)) return;
  const session = await requireUser(request, response);
  if (!session) return;

  if (pathname === "/api/tasks" && request.method === "GET") {
    const { response: dbResponse, payload } = await supabaseRequest(
      "/rest/v1/studyspace_tasks?select=id,title,subject,duration,due_at,reminder_sent,completed&order=created_at.asc",
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    if (!dbResponse.ok) {
      sendJson(response, 502, { error: getSupabaseError(payload, "Unable to load your tasks.") });
      return;
    }
    sendJson(response, 200, {
      tasks: payload.map((task) => ({
        ...task,
        dueAt: task.due_at,
        reminderSent: task.reminder_sent,
      })),
    });
    return;
  }

  if (pathname === "/api/tasks" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request, response);
    } catch {
      return;
    }
    const task = payload?.task;
    if (
      !task ||
      typeof task.id !== "string" ||
      typeof task.title !== "string" ||
      !task.title.trim() ||
      task.title.length > 120 ||
      typeof task.completed !== "boolean" ||
      !Number.isInteger(task.duration) ||
      task.duration < 1 ||
      task.duration > 1440 ||
      (task.dueAt != null && !Number.isFinite(Date.parse(task.dueAt)))
    ) {
      sendJson(response, 400, { error: "The task details are invalid." });
      return;
    }
    const { response: dbResponse, payload: dbPayload } = await supabaseRequest(
      "/rest/v1/studyspace_tasks",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          user_id: session.user.id,
          id: task.id,
          title: task.title.trim(),
          subject: typeof task.subject === "string" ? task.subject.slice(0, 80) : "",
          duration: task.duration,
          due_at: task.dueAt || null,
          reminder_sent: task.reminderSent === true,
          completed: task.completed,
        }),
      },
    );
    if (!dbResponse.ok) {
      sendJson(response, 502, { error: getSupabaseError(dbPayload, "Unable to save the task.") });
      return;
    }
    sendJson(response, 201, { task: dbPayload[0] });
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    if (!taskId || taskId.length > 100) {
      sendJson(response, 400, { error: "The task ID is invalid." });
      return;
    }
    const query = `?id=eq.${encodeURIComponent(taskId)}&select=id`;
    if (request.method === "DELETE") {
      const { response: dbResponse } = await supabaseRequest(`/rest/v1/studyspace_tasks${query}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          Prefer: "return=representation",
        },
      });
      if (!dbResponse.ok) {
        sendJson(response, 502, { error: "Unable to delete the task." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "PATCH") {
      let payload;
      try {
        payload = await readJsonBody(request, response);
      } catch {
        return;
      }
      const allowedFields = ["title", "subject", "duration", "dueAt", "reminderSent", "completed"];
      const updates = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(payload || {}, field)) {
          const databaseField = field === "dueAt" ? "due_at" : field === "reminderSent" ? "reminder_sent" : field;
          updates[databaseField] = payload[field];
        }
      }
      if (
        Object.keys(updates).length === 0 ||
        (updates.title !== undefined && (typeof updates.title !== "string" || !updates.title.trim() || updates.title.length > 120)) ||
        (updates.completed !== undefined && typeof updates.completed !== "boolean") ||
        (updates.duration !== undefined && (!Number.isInteger(updates.duration) || updates.duration < 1 || updates.duration > 1440)) ||
        (updates.due_at !== undefined && updates.due_at !== null && !Number.isFinite(Date.parse(updates.due_at)))
      ) {
        sendJson(response, 400, { error: "The task update is invalid." });
        return;
      }
      const { response: dbResponse, payload: dbPayload } = await supabaseRequest(
        `/rest/v1/studyspace_tasks${query}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${session.accessToken}`,
            "Content-Type": "application/json",
            Prefer: "return=representation",
          },
          body: JSON.stringify(updates),
        },
      );
      if (!dbResponse.ok) {
        sendJson(response, 502, { error: getSupabaseError(dbPayload, "Unable to update the task.") });
        return;
      }
      if (!dbPayload.length) {
        sendJson(response, 404, { error: "Task not found." });
        return;
      }
      sendJson(response, 200, { ok: true });
      return;
    }
  }

  if (pathname === "/api/notes" && request.method === "GET") {
    const { response: dbResponse, payload } = await supabaseRequest(
      `/rest/v1/studyspace_notes?user_id=eq.${encodeURIComponent(session.user.id)}&select=content`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    if (!dbResponse.ok) {
      sendJson(response, 502, { error: getSupabaseError(payload, "Unable to load your notes.") });
      return;
    }
    sendJson(response, 200, { content: payload[0]?.content || "" });
    return;
  }

  if (pathname === "/api/notes" && request.method === "PUT") {
    let payload;
    try {
      payload = await readJsonBody(request, response);
    } catch {
      return;
    }
    if (typeof payload?.content !== "string" || payload.content.length > 100_000) {
      sendJson(response, 400, { error: "Notes must be text no longer than 100,000 characters." });
      return;
    }
    const { response: dbResponse, payload: dbPayload } = await supabaseRequest(
      "/rest/v1/studyspace_notes?on_conflict=user_id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify({ user_id: session.user.id, content: payload.content }),
      },
    );
    if (!dbResponse.ok) {
      sendJson(response, 502, { error: getSupabaseError(dbPayload, "Unable to save your notes.") });
      return;
    }
    sendJson(response, 200, { content: dbPayload[0]?.content || "" });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function checkRateLimit(request) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recentRequests = (rateLimits.get(address) || []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );

  if (recentRequests.length >= RATE_LIMIT_REQUESTS) {
    rateLimits.set(address, recentRequests);
    return false;
  }

  recentRequests.push(now);
  rateLimits.set(address, recentRequests);
  return true;
}

function readJsonBody(request, response) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      request.resume();
      sendJson(response, 415, { error: "Send the request as application/json." });
      reject(new Error("Request content type must be application/json."));
      return;
    }

    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > MAX_BODY_BYTES) {
      request.resume();
      sendJson(response, 413, { error: "The request is too large." });
      reject(new Error("Request body exceeds the size limit."));
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) {
        tooLarge = true;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      if (tooLarge) {
        sendJson(response, 413, { error: "The request is too large." });
        reject(new Error("Request body exceeds the size limit."));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        sendJson(response, 400, { error: "The request body must be valid JSON." });
        reject(new Error("Request body is invalid JSON."));
      }
    });
  });
}

function validateMessages(payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return "Send at least one message.";
  }
  if (payload.messages.length > MAX_MESSAGES) {
    return `Send no more than ${MAX_MESSAGES} messages at a time.`;
  }

  for (const message of payload.messages) {
    if (
      !message ||
      !["user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_LENGTH
    ) {
      return "Each message must have a valid role and contain 1 to 4000 characters.";
    }
  }

  if (payload.messages[payload.messages.length - 1].role !== "user") {
    return "The last message must be from the user.";
  }

  return null;
}

const fallbackTopics = [
  {
    subject: "Biology",
    name: "photosynthesis",
    keywords: ["photosynthesis", "chlorophyll", "stomata"],
    explanation:
      "Plants use light energy to turn carbon dioxide and water into glucose, releasing oxygen. Chlorophyll in the leaves captures the light.",
    example: "A leaf is like a tiny solar-powered kitchen: light supplies the energy and glucose is the stored food.",
    cards: [
      ["What does photosynthesis make?", "Glucose and oxygen, using carbon dioxide, water, and light."],
      ["What is chlorophyll's role?", "It absorbs light energy."],
      ["Where does the carbon dioxide enter a leaf?", "Through tiny pores called stomata."],
    ],
    quiz: ["Which gas do plants take in for photosynthesis?", "Carbon dioxide"],
  },
  {
    subject: "Biology",
    name: "cellular respiration",
    keywords: ["cellular respiration", "mitochondria", "atp"],
    explanation:
      "Cells break down glucose to release usable energy, usually using oxygen. Much of that energy is stored in ATP.",
    example: "It is like releasing energy from food so a cell can power movement, transport, and growth.",
    cards: [
      ["What is the main purpose of cellular respiration?", "To release energy from glucose for the cell."],
      ["What molecule carries readily usable cellular energy?", "ATP."],
      ["Which organelle is a main site of aerobic respiration?", "The mitochondrion."],
    ],
    quiz: ["What is the main energy-carrying product of respiration?", "ATP"],
  },
  {
    subject: "Biology",
    name: "mitosis",
    keywords: ["mitosis", "chromosome", "daughter cells"],
    explanation:
      "Mitosis is the process in which one cell divides its duplicated chromosomes to form two genetically identical daughter cells.",
    example: "Your body uses mitosis to replace worn-out cells and help tissues grow.",
    cards: [
      ["What does mitosis produce?", "Two genetically identical daughter cells."],
      ["What must happen to chromosomes before mitosis?", "They are copied so each daughter cell can receive a set."],
      ["Why do organisms use mitosis?", "For growth, repair, and cell replacement."],
    ],
    quiz: ["How many daughter cells does mitosis produce?", "Two"],
  },
  {
    subject: "Mathematics",
    name: "fractions",
    keywords: ["fraction", "fractions", "numerator", "denominator"],
    explanation:
      "A fraction represents part of a whole. The numerator counts the parts you have; the denominator tells how many equal parts make the whole.",
    example: "In 3/4, the whole is split into four equal parts and three are being counted.",
    cards: [
      ["What does the denominator tell you?", "The number of equal parts in the whole."],
      ["What does the numerator tell you?", "How many parts are being counted."],
      ["How do you add fractions with the same denominator?", "Add the numerators and keep the denominator."],
    ],
    quiz: ["In 5/8, which number tells how many equal parts make the whole?", "8, the denominator"],
  },
  {
    subject: "Mathematics",
    name: "linear equations",
    keywords: ["linear equation", "linear equations", "algebra", "solve for x", "equation"],
    explanation:
      "A linear equation says two expressions are equal and has a variable to the first power. Solve it by doing the same operation to both sides until the variable is alone.",
    example: "For 2x + 3 = 11, subtract 3 from both sides, then divide by 2: x = 4.",
    cards: [
      ["What is the goal when solving an equation?", "Isolate the variable while keeping both sides balanced."],
      ["What should you do to both sides of an equation?", "The same operation to preserve equality."],
      ["Solve 2x + 3 = 11.", "x = 4."],
    ],
    quiz: ["Solve x + 7 = 12.", "x = 5"],
  },
  {
    subject: "Chemistry",
    name: "atoms",
    keywords: ["atom", "atoms", "proton", "neutron", "electron"],
    explanation:
      "An atom is the basic unit of an element. Its nucleus contains protons and usually neutrons; electrons occupy the space around the nucleus.",
    example: "The number of protons identifies the element: every carbon atom has six protons.",
    cards: [
      ["Where are protons and neutrons found?", "In the atom's nucleus."],
      ["What determines an element's identity?", "Its number of protons."],
      ["What is the charge of an electron?", "Negative."],
    ],
    quiz: ["Which particle determines whether an atom is carbon or oxygen?", "The proton"],
  },
  {
    subject: "Physics",
    name: "Newton's laws of motion",
    keywords: ["newton", "motion", "force", "inertia", "acceleration"],
    explanation:
      "Newton's laws describe how forces affect motion: objects resist changes in motion, net force causes acceleration, and interactions involve equal-and-opposite forces.",
    example: "An empty shopping cart accelerates more than a loaded one under the same push because it has less mass.",
    cards: [
      ["What does Newton's first law describe?", "Inertia: motion stays unchanged unless a net external force acts."],
      ["What is the relationship in F = ma?", "Net force equals mass times acceleration."],
      ["What does Newton's third law say?", "Forces between interacting objects are equal in size and opposite in direction."],
    ],
    quiz: ["What is the equation relating force, mass, and acceleration?", "F = ma"],
  },
  {
    subject: "History",
    name: "the Industrial Revolution",
    keywords: ["industrial revolution", "industrialization", "factory"],
    explanation:
      "The Industrial Revolution was the shift from mostly hand production and farm work toward machine-powered manufacturing, factories, and growing cities.",
    example: "Textile machines let factories produce cloth faster and in larger quantities than hand spinning.",
    cards: [
      ["What major change defines the Industrial Revolution?", "The move toward machine-powered factory production."],
      ["What happened to many towns as factories grew?", "They expanded as people moved there for work."],
      ["Name one industry transformed by early machines.", "Textiles."],
    ],
    quiz: ["Did early industrialization generally increase or decrease factory production?", "It increased production."],
  },
  {
    subject: "History",
    name: "World War II",
    keywords: ["world war ii", "world war 2", "wwii", "ww2"],
    explanation:
      "World War II was a global conflict fought from 1939 to 1945. The main opposing coalitions were the Allies and the Axis powers.",
    example: "The war in Europe ended in May 1945; Japan surrendered in September 1945.",
    cards: [
      ["When did World War II begin and end?", "1939 to 1945."],
      ["Name the two main coalitions.", "The Allies and the Axis powers."],
      ["When did the war end in Europe?", "May 1945."],
    ],
    quiz: ["In what year did World War II end?", "1945"],
  },
  {
    subject: "English",
    name: "metaphors",
    keywords: ["metaphor", "simile", "figurative language"],
    explanation:
      "A metaphor describes one thing as another to suggest a shared quality, without using 'like' or 'as'. A simile makes a comparison using 'like' or 'as'.",
    example: "'Time is a river' is a metaphor; 'time moves like a river' is a simile.",
    cards: [
      ["What is a metaphor?", "A direct comparison that describes one thing as another."],
      ["What word often signals a simile?", "'Like' or 'as'."],
      ["Is 'Her voice was music' a metaphor or simile?", "A metaphor."],
    ],
    quiz: ["Is 'The room was as cold as ice' a metaphor or a simile?", "A simile"],
  },
  {
    subject: "Programming",
    name: "JavaScript variables and constants",
    keywords: ["javascript", "variable", "variables", "constant", "const", "let"],
    explanation:
      "A variable stores a value for later use. In JavaScript, let allows reassignment; const prevents rebinding the name, though an object or array declared with const can still have its contents changed.",
    example: "Use let score = 0 when score will change, and const appName = 'Studyspace' when the binding should stay fixed.",
    cards: [
      ["When should you use let in JavaScript?", "When you need to reassign the variable."],
      ["What does const prevent?", "Reassigning the binding; it does not deeply freeze objects."],
      ["Can an array declared with const be edited?", "Yes, its contents can change, but the variable cannot be reassigned to another array."],
    ],
    quiz: ["Can you reassign a JavaScript const variable?", "No; its binding cannot be reassigned."],
  },
];

function detectFallbackTopic(text) {
  const lower = text.toLowerCase();
  return fallbackTopics.find((topic) => topic.keywords.some((keyword) => lower.includes(keyword))) || null;
}

function buildFallbackReply(messages) {
  const userMessages = messages.filter((message) => message.role === "user");
  const latestPrompt = (userMessages.at(-1)?.content || "study question").trim();
  const context = userMessages.map((message) => message.content).join(" ");
  const lower = latestPrompt.toLowerCase();
  const topic = detectFallbackTopic(context);
  const previousAssistant = [...messages].reverse().find((message) => message.role === "assistant")?.content || "";
  const topicLabel = topic ? `${topic.name} (${topic.subject})` : "your question";
  const isShort = /\b(short|brief|briefly|concise|quick|tl;dr|eli5)\b/i.test(lower);
  const isFlashcards = /\b(flash ?cards?|cards?)\b/i.test(lower);
  const isQuiz = /\b(quiz|test me|practice questions?)\b/i.test(lower);
  const isQuizAnswer = previousAssistant.includes("Quick quiz:") && !isQuiz;

  if (isFlashcards) {
    if (!topic) {
      return "I can make flashcards for you. Tell me the subject or topic, for example: “Make flashcards about photosynthesis.”";
    }
    return `Topic detected: ${topicLabel}\n\n${topic.cards
      .map(([front, back], index) => `Card ${index + 1}\nQ: ${front}\nA: ${back}`)
      .join("\n\n")}`;
  }

  if (isQuiz) {
    if (!topic) {
      return "I can quiz you. Tell me the subject or topic, for example: “Quiz me on fractions.”";
    }
    const [question] = topic.quiz;
    return `Topic detected: ${topicLabel}\n\nQuick quiz:\n${question}\n\nReply with your answer and I'll check it.`;
  }

  if (isQuizAnswer && topic) {
    const expectedAnswer = topic.quiz[1].toLowerCase().replace(/[.!?]/g, "");
    const submittedAnswer = lower.replace(/[.!?]/g, "");
    const isCorrect = submittedAnswer.includes(expectedAnswer);
    return isCorrect
      ? `Correct! ${topic.quiz[1]} is right. Ask for another quiz question on ${topic.name} when you're ready.`
      : `Not quite. The answer is: ${topic.quiz[1]} Ask for another quiz question on ${topic.name} when you're ready.`;
  }

  if (!topic) {
    return `I couldn't confidently identify a specific topic in “${latestPrompt}.” Add the subject or a key term and I can give you a focused explanation, short version, flashcards, or a quiz.`;
  }

  return isShort
    ? `Topic detected: ${topicLabel}\n\n${topic.explanation}`
    : `Topic detected: ${topicLabel}\n\n${topic.explanation}\n\nExample: ${topic.example}\n\nWould you like a short version, flashcards, or a quick quiz?`;
}

async function handleChat(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    sendJson(response, 405, { error: "Use POST to send a chat message." });
    return;
  }

  if (!checkRateLimit(request)) {
    sendJson(response, 429, { error: "Too many messages. Wait a minute and try again." });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(request, response);
  } catch {
    return;
  }

  const validationError = validateMessages(payload);
  if (validationError) {
    sendJson(response, 400, { error: validationError });
    return;
  }

  if (!AI_API_KEY && FALLBACK_MODE) {
    const reply = buildFallbackReply(payload.messages);
    response.setHeader("X-Studyspace-Mode", "fallback");
    sendJson(response, 200, { reply });
    return;
  }

  if (!AI_API_KEY) {
    sendJson(response, 503, {
      error: "The AI service is not configured yet. Add AI_API_KEY to your server environment.",
    });
    return;
  }

  let providerUrl;
  try {
    providerUrl = new URL(AI_API_URL);
  } catch {
    sendJson(response, 500, { error: "AI_API_URL must be a valid URL." });
    return;
  }

  const isLocalHttp =
    providerUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(providerUrl.hostname);
  if (providerUrl.protocol !== "https:" && !isLocalHttp) {
    sendJson(response, 500, { error: "AI_API_URL must use HTTPS." });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const providerResponse = await fetch(providerUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a supportive study assistant. Infer the subject and topic from the conversation, explain concepts clearly with a useful example, and follow requests for brief explanations, flashcards, or quizzes. For quizzes, ask a question and let the student attempt it before revealing the answer. Be accurate and encouraging; guide learning rather than merely giving answers when appropriate.",
          },
          ...payload.messages,
        ],
      }),
      signal: controller.signal,
    });

    if (!providerResponse.ok) {
      console.error(`AI provider returned HTTP ${providerResponse.status}.`);
      if (FALLBACK_MODE) {
        response.setHeader("X-Studyspace-Mode", "fallback");
        sendJson(response, 200, { reply: buildFallbackReply(payload.messages) });
        return;
      }
      sendJson(response, 502, {
        error: "The AI provider could not answer. Check your provider settings and try again.",
      });
      return;
    }

    const providerPayload = await providerResponse.json();
    const reply = providerPayload.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) {
      console.error("AI provider returned an unexpected response format.");
      if (FALLBACK_MODE) {
        response.setHeader("X-Studyspace-Mode", "fallback");
        sendJson(response, 200, { reply: buildFallbackReply(payload.messages) });
        return;
      }
      sendJson(response, 502, { error: "The AI provider returned an unexpected response." });
      return;
    }

    sendJson(response, 200, { reply });
  } catch (error) {
    if (error.name === "AbortError") {
      if (FALLBACK_MODE) {
        response.setHeader("X-Studyspace-Mode", "fallback");
        sendJson(response, 200, { reply: buildFallbackReply(payload.messages) });
        return;
      }
      sendJson(response, 504, { error: "The AI response took too long. Please try again." });
    } else {
      console.error("Unable to reach the AI provider.", error);
      if (FALLBACK_MODE) {
        response.setHeader("X-Studyspace-Mode", "fallback");
        sendJson(response, 200, { reply: buildFallbackReply(payload.messages) });
        return;
      }
      sendJson(response, 502, { error: "Unable to reach the AI provider. Please try again." });
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleStatic(request, response, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed.");
    return;
  }

  const file = PUBLIC_FILES.get(pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found.");
    return;
  }

  try {
    const filePath = path.join(__dirname, file[0]);
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": pathname === "/" || pathname === "/index.html" ? "no-store" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : contents);
  } catch (error) {
    console.error("Unable to serve a static file.", error);
    sendJson(response, 500, { error: "Unable to serve this page." });
  }
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const url = new URL(request.url, "http://localhost");
  if (pathname.startsWith("/api/auth/")) {
    await handleAuth(request, response, pathname);
    return;
  }
  if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/") || pathname === "/api/notes") {
    await handleUserData(request, response, pathname, url);
    return;
  }
  if (pathname === "/api/chat") {
    await handleChat(request, response);
    return;
  }
  await handleStatic(request, response, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`Studyspace server listening at http://${HOST}:${PORT}`);
});
