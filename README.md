# Studyspace

Studyspace is a static HTML, CSS, and JavaScript study dashboard served by a small Node.js backend. The backend provides `/api/chat` and forwards study questions to an OpenAI-compatible chat completions API. The API key stays on the server.

## Requirements

- Node.js 20.6 or later
- Optional: an API key for an OpenAI-compatible chat completions provider

## Run locally

1. Copy `.env.example` to `.env`.
2. Replace `AI_API_KEY` with your provider's API key if you have one. Update `AI_API_URL` and `AI_MODEL` if your provider uses different settings.
3. From the project directory, run:

   ```powershell
   npm start
   ```

4. Open <http://127.0.0.1:3000>.

The app includes an offline fallback study assistant, so chat remains available when no API key is configured, the provider is unavailable, or the account is rate-limited. The fallback recognizes a selection of common topics in biology, mathematics, chemistry, physics, history, English, and programming. It can give concise explanations, examples, flashcards, and one-question-at-a-time quizzes; its offline topic coverage is limited, so use a configured provider for open-ended questions outside those topics. Study plan tasks and personal notes are saved in the current browser on the current device. Task completion counts and the progress bar update automatically as you add, complete, or remove tasks.

Tasks can have an optional scheduled date and time. Studyspace shows in-app reminders while open, including a completion confirmation and a reminder when a scheduled task is due. Enable browser notifications in the study plan for desktop alerts. The page must remain open for scheduled reminders; alerts are not delivered while the browser is closed.

The server uses Node's built-in modules and does not require an `npm install` step. Keep `.env` private; it is excluded by `.gitignore`. For deployment beyond a personal local demo, add user authentication and provider-appropriate abuse and usage controls before exposing the chat endpoint publicly.

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
