# Studyspace

Studyspace is an HTML, CSS, and JavaScript study dashboard served by a Node.js backend. The backend provides the chat API and private account, task, and notes APIs backed by MySQL.

## Requirements

- Node.js 20.6 or later
- MySQL Server 8 or compatible
- Optional: an API key for an OpenAI-compatible chat completions provider

## Run locally

1. Install MySQL Server and make sure the `MySQL80` service is running.
2. Copy `.env.example` to `.env`. Set `MYSQL_PASSWORD` to your local MySQL root password. The server creates the `studyspace` database and its tables on startup.
3. Optionally set `AI_API_KEY`, `AI_API_URL`, and `AI_MODEL` for an OpenAI-compatible provider.
4. From the project directory, install dependencies and run:

   ```powershell
   npm install
   npm start
   ```

5. Open <http://127.0.0.1:3000>, select **Sign in**, then create an account. Passwords are stored as scrypt hashes and session tokens are stored hashed in MySQL; the browser receives only an HttpOnly session cookie.

The app includes an offline fallback study assistant, so chat remains available when no API key is configured, the provider is unavailable, or the account is rate-limited. The fallback recognizes a selection of common topics in biology, mathematics, chemistry, physics, history, English, and programming. It can give concise explanations, examples, flashcards, and one-question-at-a-time quizzes; its offline topic coverage is limited, so use a configured provider for open-ended questions outside those topics. Study plan tasks and personal notes are saved in the current browser on the current device. Task completion counts and the progress bar update automatically as you add, complete, or remove tasks.

Tasks can have an optional scheduled date and time. Studyspace shows in-app reminders while open, including a completion confirmation and a reminder when a scheduled task is due. Enable browser notifications in the study plan for desktop alerts. The page must remain open for scheduled reminders; alerts are not delivered while the browser is closed.

Tasks and notes are stored per account in MySQL. If you already have browser-local tasks or notes, signing in imports them to your account. Keep `.env` private; it is excluded by `.gitignore`. The local configuration defaults to the MySQL `root` user for setup convenience; for deployment, use a dedicated least-privilege MySQL account, HTTPS, `COOKIE_SECURE=true`, and provider-appropriate abuse and usage controls.

## Upload to GitHub

The source files and `.env.example` are safe to upload. The real `.env`, dependency folders, editor settings, and local log files are excluded by `.gitignore`. Never replace the placeholder in `.env.example` with a real API key.

From the project directory, initialize and commit the project locally:

```powershell
git init
git add .
git status
```

Before committing, confirm `.env` is not listed under staged files and `.env.example` is included. Then commit and connect the repository created on GitHub:

```powershell
git commit -m "Prepare Studyspace project"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

If this project was already connected to a remote, keep its existing remote instead of running `git remote add origin` again.
