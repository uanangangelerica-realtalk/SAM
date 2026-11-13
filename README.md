# Campus Student Services

A responsive student-record management application built with Express, server-rendered EJS, and PostgreSQL.

## Run locally

Requirements: Node.js 20+ and Docker Desktop (or a PostgreSQL 14+ server).

1. Install packages:

   ```powershell
   npm ci
   ```

2. Start the local PostgreSQL database:

   ```powershell
   docker compose up -d db
   ```

3. Configure the application:

   ```powershell
   Copy-Item .env.example .env
   $secret = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   (Get-Content .env) -replace '^SESSION_SECRET=.*$', "SESSION_SECRET=$secret" | Set-Content .env
   ```

   If you already have PostgreSQL, set `DATABASE_URL` in `.env` to your database connection string instead.

4. Start the server and open http://localhost:3000:

   ```powershell
   npm start
   ```

   On the first visit, create the administrator account. Setup closes after that first account is saved.

## Features

- One-time administrator setup, password hashing, authenticated sessions, CSRF protection, and password updates.
- Student create, view, edit, delete, search, filters, and pagination.
- Course management with safeguards for courses linked to students.
- Live enrollment, gender, course, and year-level charts; printable reports and CSV export.
- Responsive layouts, keyboard-friendly controls, and a persisted light/dark theme.
- PostgreSQL-backed student records and sessions. No sample student data or fabricated analytics are inserted.

The database schema is created when the server starts. Back up the PostgreSQL database before upgrades or operational changes.

## Render

The included `render.yaml` describes a Node web service and PostgreSQL database. Connect the repository to Render and deploy the blueprint; Render will create `DATABASE_URL` and a random `SESSION_SECRET`. The application initializes its schema on startup.

Set `DATABASE_SSL=true` only when your PostgreSQL provider requires TLS. Keep `SESSION_SECRET` private and use a strong unique value in every production environment.

## Checks

Run the test suite with:

```powershell
npm test
```
