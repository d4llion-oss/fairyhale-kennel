# FairyHale Kennel Management

A small, server-rendered web app for kennel staff to record the time and activities they spend with each animal, keep animal profiles, track recurring kennel chores, and leave an immutable audit trail of every action.

**Stack:** Node 22 · Express · EJS · PostgreSQL 16 · Docker · GitHub Actions · DigitalOcean App Platform + Managed Postgres.

## Features

| Area | What it does |
|---|---|
| **Animal profiles** | Name, type, breed, age (from DOB or an estimate), dietary requirements, medications, notes. Archive instead of delete so history is preserved. |
| **Activity log** | Staff log activity type + minutes per animal (with optional backdating and notes). Per-animal history and 7-day breakdown. |
| **Kennel tasks** | General chores with a frequency (daily, twice daily, weekly, …). Status flips to *due soon* / *overdue* automatically; anyone can mark done. |
| **Roles** | `admin` manages tasks, users, reports and the audit log; `user` logs activity and completes tasks. Admins cannot demote or deactivate themselves. |
| **Immutable audit log** | Every create/update/archive/login/logout/export is appended with a **database-assigned timestamp**. `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log` are blocked by triggers; client-supplied timestamps are overwritten. Before/after JSON snapshots are stored. CSV export. |
| **Reports** | Time by animal, by staff member, by activity type over 7/30/90 days. |

Security basics: bcrypt (cost 12), server-side sessions in Postgres, CSRF double-submit tokens, Helmet headers, login throttling, `HttpOnly`/`Secure`/`SameSite` cookies, TLS to the database with CA verification in production.

## Run locally

**With Docker Compose (easiest):**

```bash
docker compose up --build -d
docker compose exec app npm run migrate
docker compose exec app npm run seed      # creates admin + demo data (SEED_DEMO_DATA=true in compose)
open http://localhost:8080                # admin / ChangeMe-Now-1234
```

**Without Docker:** you need Postgres running, then

```bash
cp .env.example .env     # edit DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD
npm install
npm run migrate && npm run seed
npm run dev
```

`npm test` runs the audit-log immutability tests against `DATABASE_URL`.

## Deploy to DigitalOcean

Code lives on **GitHub** (`d4llion-oss/fairyhale-kennel`). **GitHub Actions** (`.github/workflows/ci.yml`) runs the test suite and a Docker build on every push/PR. **DigitalOcean App Platform** watches `main` and rebuilds the Dockerfile on every push; a `PRE_DEPLOY` job runs the migration + admin seed before the new release goes live. The managed Postgres database is defined in the same spec.

### One-time setup

1. In the DO console, authorize the DigitalOcean GitHub app for the `d4llion-oss` org/repo (App Platform → Create → GitHub) if you haven't already.
2. `doctl apps create --spec .do/app.yaml`
3. Set the two secrets in the app's settings (or pass them through the spec at create time): `SESSION_SECRET` (`openssl rand -hex 32`) and `ADMIN_PASSWORD`.

After that, every push to `main` that passes CI is deployed automatically.

### Notes for production

- Set `production: true` on the database for a real managed cluster with backups; `false` gives the cheap dev database.
- The migration job is idempotent and re-runs on every deploy; schema changes go in `src/db/schema.sql` using `IF NOT EXISTS` / `CREATE OR REPLACE` patterns (or add a migrations tool when the schema starts changing often).
- The audit log is the system of record — never grant the app user `TRUNCATE`/`DROP` on it, and consider a periodic export to object storage (Spaces) for off-system retention.
- Login throttling is in-process; if you scale to more than one instance, move it to Redis or rely on App Platform's rate limiting.

## Project layout

```
src/
  server.js          Express app, sessions, CSRF, routing
  db/schema.sql      Tables, enums, audit-log immutability triggers
  db/migrate.js      Applies schema.sql
  db/seed.js         Admin account + optional demo data
  lib/               auth guards, audit helper, formatting helpers
  routes/            auth, dashboard, animals, activities, tasks, admin
  views/             EJS templates
  public/app.css     Styles
test/                Audit immutability tests
.do/app.yaml         DigitalOcean App Platform spec
.github/workflows/   CI: tests + docker build
Dockerfile, docker-compose.yml
```
