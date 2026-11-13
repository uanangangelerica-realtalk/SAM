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
- Student profile-photo upload with an instant preview, automatic square WebP resizing, and database-backed storage. JPG, PNG, and WebP files up to 2 MB are accepted; administrators can replace or remove a photo.
- Course management with safeguards for courses linked to students.
- Live enrollment, gender, course, and year-level charts; printable reports and CSV export.
- Responsive layouts, keyboard-friendly controls, and a persisted light/dark theme.
- PostgreSQL-backed student records and sessions. No sample student data or fabricated analytics are inserted.

The database schema is created when the server starts. Student photos are stored in PostgreSQL so they persist across Render restarts and deploys; include them in database backups and apply the same access protections as other student information.

## Render

The included `render.yaml` describes a free Node web service. It does not create a Render PostgreSQL database, because Render's free databases expire after 30 days. The Blueprint asks for `DATABASE_URL`; provide a connection string from a free external PostgreSQL provider such as Neon. The Blueprint generates a random `SESSION_SECRET`, and the application initializes its schema on startup.

For Neon, create a Free project without adding a payment method and use its pooled connection string. Keep the connection string private and enter it directly in Render as the `DATABASE_URL` Blueprint variable; never commit it or share it in chat. `DATABASE_SSL=true` is enabled for the hosted database connection.

Free hosting has limitations: Render may spin down the web service after 15 minutes without traffic, making the next request take about a minute to start. Free-tier services have resource and usage limits and are not intended for production workloads. Review your database provider's limits and arrange regular backups before storing important student records.

## Checks

Run the test suite with:

```powershell
npm test
```
