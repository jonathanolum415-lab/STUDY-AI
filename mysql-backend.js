"use strict";

const { randomBytes, randomUUID, scrypt, createHash, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const mysql = require("mysql2/promise");

const scryptAsync = promisify(scrypt);
const MAX_BODY_BYTES = 128 * 1024;
const SESSION_DAYS = 30;
const authAttempts = new Map();

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function parseCookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator < 0) return ["", ""];
        return [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
      })
      .filter(([name]) => name),
  );
}

function cookieOptions(request, maxAge) {
  const secure = request.socket.encrypted || process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearSessionCookie(request, response) {
  response.setHeader("Set-Cookie", `studyspace_session=; ${cookieOptions(request, 0)}`);
}

function setSessionCookie(request, response, token) {
  response.setHeader(
    "Set-Cookie",
    `studyspace_session=${encodeURIComponent(token)}; ${cookieOptions(request, SESSION_DAYS * 86400)}`,
  );
}

function verifySameOrigin(request, response) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    if (new URL(origin).host === request.headers.host) return true;
  } catch {
    // Reject malformed origins below.
  }
  sendJson(response, 403, { error: "The request origin is not allowed." });
  return false;
}

function readJsonBody(request, response) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers["content-type"] || "";
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      request.resume();
      sendJson(response, 415, { error: "Send the request as application/json." });
      reject(new Error("Invalid request content type."));
      return;
    }
    if (Number(request.headers["content-length"] || 0) > MAX_BODY_BYTES) {
      request.resume();
      sendJson(response, 413, { error: "The request is too large." });
      reject(new Error("Request body too large."));
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_BODY_BYTES) tooLarge = true;
      else if (!tooLarge) chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (tooLarge) {
        sendJson(response, 413, { error: "The request is too large." });
        reject(new Error("Request body too large."));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        sendJson(response, 400, { error: "The request body must be valid JSON." });
        reject(new Error("Invalid JSON request body."));
      }
    });
  });
}

function getDatabaseConfig() {
  const database = process.env.MYSQL_DATABASE || "studyspace";
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("MYSQL_DATABASE must contain only letters, numbers, and underscores.");
  }

  return {
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database,
    charset: "utf8mb4",
    timezone: "Z",
    waitForConnections: true,
    connectionLimit: 8,
    queueLimit: 0,
    dateStrings: true,
  };
}

async function initializeDatabase() {
  const config = getDatabaseConfig();
  const { database } = config;
  const serverConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: config.charset,
    timezone: config.timezone,
  };
  const setupConnection = await mysql.createConnection(serverConfig);
  try {
    await setupConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await setupConnection.end();
  }

  const pool = mysql.createPool(config);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) NOT NULL PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_salt CHAR(32) NOT NULL,
      password_hash CHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) NOT NULL PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX sessions_user_id_idx (user_id),
      CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_tasks (
      user_id CHAR(36) NOT NULL,
      id VARCHAR(100) NOT NULL,
      title VARCHAR(120) NOT NULL,
      subject VARCHAR(80) NOT NULL DEFAULT '',
      duration SMALLINT UNSIGNED NOT NULL DEFAULT 25,
      due_at DATETIME(3) NULL,
      reminder_sent BOOLEAN NOT NULL DEFAULT FALSE,
      completed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, id),
      INDEX study_tasks_created_idx (user_id, created_at),
      CONSTRAINT study_tasks_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_notes (
      user_id CHAR(36) NOT NULL PRIMARY KEY,
      content MEDIUMTEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT study_notes_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB
  `);
  return pool;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password, salt) {
  return (await scryptAsync(password, salt, 64)).toString("hex");
}

async function createSession(pool, request, response, user) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  await pool.execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY))",
    [tokenHash, user.id, SESSION_DAYS],
  );
  setSessionCookie(request, response, token);
  sendJson(response, 200, { user: { id: user.id, email: user.email } });
}

function checkAuthRateLimit(request, response) {
  const address = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recentAttempts = (authAttempts.get(address) || []).filter((timestamp) => now - timestamp < 15 * 60_000);
  if (recentAttempts.length >= 15) {
    sendJson(response, 429, { error: "Too many sign-in attempts. Wait 15 minutes and try again." });
    return false;
  }
  recentAttempts.push(now);
  authAttempts.set(address, recentAttempts);
  return true;
}

async function getSessionUser(pool, request) {
  const token = parseCookies(request).studyspace_session;
  if (!token || token.length > 128) return null;
  const [rows] = await pool.execute(
    `SELECT users.id, users.email
     FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > UTC_TIMESTAMP()
     LIMIT 1`,
    [hashToken(token)],
  );
  return rows[0] || null;
}

function toSqlDateTime(value) {
  return new Date(value).toISOString().slice(0, 23).replace("T", " ");
}

function toIsoDateTime(value) {
  if (!value) return null;
  return `${String(value).replace(" ", "T")}Z`;
}

async function handleAuth(pool, request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/auth/session") {
    const user = await getSessionUser(pool, request);
    if (!user) {
      clearSessionCookie(request, response);
      sendJson(response, 401, { error: "Sign in to access your tasks and notes." });
      return;
    }
    sendJson(response, 200, { user });
    return;
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", pathname === "/api/auth/logout" ? "POST" : "GET, POST");
    sendJson(response, 405, { error: "This method is not allowed." });
    return;
  }
  if (!verifySameOrigin(request, response)) return;

  if (pathname === "/api/auth/logout") {
    const token = parseCookies(request).studyspace_session;
    if (token) {
      await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
    }
    clearSessionCookie(request, response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (!checkAuthRateLimit(request, response)) return;
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

  const email = payload.email.trim().toLowerCase();
  if (pathname === "/api/auth/signup") {
    const id = randomUUID();
    const salt = randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(payload.password, salt);
    try {
      await pool.execute(
        "INSERT INTO users (id, email, password_salt, password_hash) VALUES (?, ?, ?, ?)",
        [id, email, salt, passwordHash],
      );
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        sendJson(response, 409, { error: "An account with this email already exists. Sign in instead." });
        return;
      }
      throw error;
    }
    await createSession(pool, request, response, { id, email });
    return;
  }

  if (pathname !== "/api/auth/login") {
    sendJson(response, 404, { error: "Not found." });
    return;
  }

  const [rows] = await pool.execute(
    "SELECT id, email, password_salt, password_hash FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  if (!rows.length) {
    const dummyHash = await hashPassword(payload.password, "00000000000000000000000000000000");
    timingSafeEqual(Buffer.from(dummyHash, "hex"), Buffer.alloc(64));
    sendJson(response, 401, { error: "Email or password is incorrect." });
    return;
  }

  const user = rows[0];
  const candidateHash = Buffer.from(await hashPassword(payload.password, user.password_salt), "hex");
  const storedHash = Buffer.from(user.password_hash, "hex");
  if (candidateHash.length !== storedHash.length || !timingSafeEqual(candidateHash, storedHash)) {
    sendJson(response, 401, { error: "Email or password is incorrect." });
    return;
  }
  await createSession(pool, request, response, user);
}

async function handleTasks(pool, request, response, pathname, user) {
  if (pathname === "/api/tasks" && request.method === "GET") {
    const [tasks] = await pool.execute(
      `SELECT id, title, subject, duration, due_at, reminder_sent, completed
       FROM study_tasks WHERE user_id = ? ORDER BY created_at ASC`,
      [user.id],
    );
    sendJson(response, 200, {
      tasks: tasks.map((task) => ({
        ...task,
        dueAt: toIsoDateTime(task.due_at),
        reminderSent: Boolean(task.reminder_sent),
        completed: Boolean(task.completed),
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
      !/^[A-Za-z0-9_-]{1,100}$/.test(task.id) ||
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
    try {
      await pool.execute(
        `INSERT INTO study_tasks
         (user_id, id, title, subject, duration, due_at, reminder_sent, completed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          task.id,
          task.title.trim(),
          typeof task.subject === "string" ? task.subject.slice(0, 80) : "",
          task.duration,
          task.dueAt ? toSqlDateTime(task.dueAt) : null,
          task.reminderSent === true,
          task.completed,
        ],
      );
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") {
        sendJson(response, 409, { error: "This task is already saved to your account." });
        return;
      }
      throw error;
    }
    sendJson(response, 201, { ok: true });
    return;
  }

  const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!match) {
    sendJson(response, 404, { error: "Not found." });
    return;
  }
  const taskId = decodeURIComponent(match[1]);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) {
    sendJson(response, 400, { error: "The task ID is invalid." });
    return;
  }

  if (request.method === "DELETE") {
    const [result] = await pool.execute("DELETE FROM study_tasks WHERE user_id = ? AND id = ?", [user.id, taskId]);
    sendJson(response, 200, { ok: true, deleted: result.affectedRows > 0 });
    return;
  }
  if (request.method !== "PATCH") {
    response.setHeader("Allow", "PATCH, DELETE");
    sendJson(response, 405, { error: "This method is not allowed." });
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request, response);
  } catch {
    return;
  }
  const columns = {
    title: (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 120,
    subject: (value) => typeof value === "string" && value.length <= 80,
    duration: (value) => Number.isInteger(value) && value >= 1 && value <= 1440,
    dueAt: (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value))),
    reminderSent: (value) => typeof value === "boolean",
    completed: (value) => typeof value === "boolean",
  };
  const names = { dueAt: "due_at", reminderSent: "reminder_sent" };
  const updates = Object.entries(payload || {});
  if (!updates.length || updates.some(([key, value]) => !columns[key] || !columns[key](value))) {
    sendJson(response, 400, { error: "The task update is invalid." });
    return;
  }
  const setSql = updates.map(([key]) => `\`${names[key] || key}\` = ?`).join(", ");
  const values = updates.map(([key, value]) => (key === "dueAt" && value ? toSqlDateTime(value) : value));
  const [result] = await pool.execute(
    `UPDATE study_tasks SET ${setSql} WHERE user_id = ? AND id = ?`,
    [...values, user.id, taskId],
  );
  if (!result.affectedRows) {
    const [rows] = await pool.execute("SELECT id FROM study_tasks WHERE user_id = ? AND id = ?", [user.id, taskId]);
    if (!rows.length) {
      sendJson(response, 404, { error: "Task not found." });
      return;
    }
  }
  sendJson(response, 200, { ok: true });
}

async function handleNotes(pool, request, response, user) {
  if (request.method === "GET") {
    const [rows] = await pool.execute("SELECT content FROM study_notes WHERE user_id = ? LIMIT 1", [user.id]);
    sendJson(response, 200, { content: rows[0]?.content || "" });
    return;
  }
  if (request.method !== "PUT") {
    response.setHeader("Allow", "GET, PUT");
    sendJson(response, 405, { error: "This method is not allowed." });
    return;
  }
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
  await pool.execute(
    `INSERT INTO study_notes (user_id, content) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE content = VALUES(content)`,
    [user.id, payload.content],
  );
  sendJson(response, 200, { content: payload.content });
}

function createMySqlBackend(pool) {
  return async function handleMySqlApi(request, response, pathname) {
    try {
      if (pathname.startsWith("/api/auth/")) {
        await handleAuth(pool, request, response, pathname);
        return;
      }
      if (!verifySameOrigin(request, response)) return;
      const user = await getSessionUser(pool, request);
      if (!user) {
        sendJson(response, 401, { error: "Sign in to access your tasks and notes." });
        return;
      }
      if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/")) {
        await handleTasks(pool, request, response, pathname, user);
        return;
      }
      if (pathname === "/api/notes") {
        await handleNotes(pool, request, response, user);
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      console.error("MySQL backend request failed.", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "The database request failed. Check the server log for details." });
      }
    }
  };
}

module.exports = { initializeDatabase, createMySqlBackend };
