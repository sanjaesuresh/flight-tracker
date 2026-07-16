# flight-tracker

A personal, single-user, $0/month NYC ↔ Toronto cheap-flight tracker.

An hourly GitHub Actions cron runs a Python poller that queries Google Flights
via the [`fli`](https://pypi.org/project/flights/) library (its reverse-engineered
protobuf API), stores fare snapshots in a [Neon](https://neon.tech) Postgres
database, and emails a deal alert over Gmail SMTP — with a Google Flights
`/booking` deep-link — whenever a round trip is cheap. A Vite/React dashboard
(deployed on Vercel, with serverless functions holding the DB credential) shows
the cheapest current fares, per-option price history, and editable settings.

It is built to run entirely on free tiers (GitHub Actions, Neon, Vercel, Gmail)
for one person watching one route pair.

---

## Architecture

The two halves — poller and dashboard — share a single Neon Postgres database
and never talk to each other directly.

```
GitHub Actions cron (hourly, :07)
        │
        ▼
  Python poller  ──(fli / Google Flights protobuf API)──►  Google Flights
        │
        ├──► write fare snapshots ─────►  Neon Postgres
        │                                       ▲
        └──► Gmail SMTP deal alert              │
             (booking deep-link)                │
                                                │
  Vite/React dashboard (Vercel)  ──serverless──┘
   reads snapshots + reads/writes settings
```

- **Poller** (`poller/`) — orchestrates one polling run per invocation, queries
  fares, writes snapshots, evaluates alert rules, and sends email.
- **Neon Postgres** — the single source of truth: fare snapshots, settings,
  sent-alert history, and poller run state.
- **Gmail SMTP** — sends the deal-alert email with a booking deep-link.
- **Dashboard** (`frontend/`) — a Vite + React + TypeScript SPA served on
  Vercel; a catch-all serverless function holds the DB credential and queries
  Neon over its HTTP driver. Reads snapshots, reads and writes the settings row.
- **GitHub Actions** (`.github/workflows/poll.yml`) — the hourly scheduler.

---

## Repository layout

```
poller/            Python poller: run orchestration, data sources, rules, email, DB
frontend/          Vite + React + TS dashboard and its Vercel serverless API
db/                schema.sql — the Postgres schema (idempotent)
tests/             pytest suite for the poller
.github/           GitHub Actions workflows (hourly poll)
```

The dashboard has its own more detailed README at
[`frontend/README.md`](frontend/README.md).

---

## How it works

### Trip patterns and the rolling window

Alerts are scoped to weekend trip patterns rather than arbitrary dates. Each
pattern is a `(outbound weekday, outbound time window)` and
`(return weekday, return time window)` — for example "leave Thursday after 5pm,
return Sunday" or "leave Friday any time, return Sunday". `expand_patterns`
walks a rolling window of the next `window_days` days (default 60), enumerates
every outbound date matching each pattern's weekday, and pairs it with the next
matching return date. Duplicate outbound/return date pairs are de-duplicated.

### The multi-airport matrix

The route is a matrix, not a single airport pair: origins `JFK, LGA` and
destinations `YYZ, YTZ`. For each candidate date pair the poller searches across
that matrix, keeps the cheapest overall round trip, and allows mixed airlines
per leg. The Neon `settings` row (single row, `id = 1`) holds the airport lists
and the preferred pair used for display.

### Data source (and its fallback)

The default data source is `FliSource`, backed by the `fli` package
(PyPI: `flights==0.9.0`), which speaks Google Flights' protobuf API directly and
returns full itinerary details (both legs, airlines, flight numbers, stops, and a
booking token). A second source, `GoogleFlightsSource`, is backed by
`fast-flights==3.0.2` (an HTML scraper) and is kept as a documented degrade path
if `fli` breaks — switching to it is a manual one-line change in the poller, not
an automatic runtime fallback. See `RUNBOOK.md` for the swap procedure.

### Snapshots and pruning

Each run writes fare snapshots to `price_snapshots`, keeping the cheapest
distinct itineraries per search (and always the overall cheapest). Old rows are
pruned: past-departure trips and snapshots older than the retention window are
deleted on a best-effort basis.

### Alert rules

For each candidate trip the poller evaluates two independent triggers, then a
de-duplication gate:

1. **Threshold** — the price is strictly below `threshold_usd`.
2. **Drop vs. median** — the price is at or below a target computed from a
   baseline median of recent daily-low prices (requires at least
   `min_history_days` distinct days of history), discounted by `drop_pct`.
3. **Re-alert de-dup** — if this itinerary identity has already been alerted,
   a new alert only fires if the price fell by at least a configurable step
   (`realert_step_pct` of the last alerted price, or `realert_step_dollars`,
   whichever is larger). Otherwise the alert is suppressed. Sent alerts are
   recorded in `alerts_sent`, keyed by origin, destination, both dates, airline,
   and a nonstop/connecting bucket.

An itinerary must also match its pattern's time windows to qualify.

### Dry run and the booking deep-link

When `dry_run` is true (the seeded default), alerts are formatted but no email
is sent — useful for validating rules against live data before going live. When
an alert does fire, its email includes a Google Flights
`/travel/flights/booking` deep-link built from the itinerary's booking token, so
the recipient lands directly on the bookable fare.

### Exit-code contract

`python -m poller.main` returns:

- **0** — success (at least one search succeeded, or nothing was attempted).
- **1** — transient total failure: every attempted search failed, but fewer
  than 3 consecutive failed runs so far.
- **2** — persistent total failure: every attempted search failed and there
  have been 3+ consecutive failed runs.

Only exit code 2 fails the GitHub Actions job (which surfaces as GitHub's own
job-failure email). The `poller_state` row tracks `last_success`,
`consecutive_failures`, and a rotating `cursor` so each run picks up a fresh
slice of the search budget.

---

## Setup and configuration

> All secret values below are placeholders. Never commit real credentials,
> connection strings, or email addresses.

### 1. Database (Neon)

Create a Neon Postgres project and apply the schema (idempotent):

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

This creates `settings`, `price_snapshots`, `alerts_sent`, and `poller_state`,
and seeds the single `settings` (id=1) and `poller_state` (id=1) rows. Edit the
seeded `settings` row (or use the dashboard) to set your airports, patterns,
threshold, alert email, and `dry_run` flag.

### 2. Poller environment / GitHub secrets

The poller requires all three of these (missing any aborts the run):

| Variable             | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `DATABASE_URL`       | Neon Postgres connection string (include `sslmode=require`) |
| `GMAIL_ADDRESS`      | Gmail address that sends alerts                             |
| `GMAIL_APP_PASSWORD` | Gmail **app password** (requires 2FA on the account)        |

For the hourly cron, set these as GitHub Actions repository secrets
(`Settings → Secrets and variables → Actions`) with the same names.

Gmail note: `GMAIL_APP_PASSWORD` is a Gmail app password, not your account
password. It requires 2-factor authentication to be enabled on the account.

### 3. Frontend / Vercel environment

| Variable         | Purpose                                                                          |
| ---------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`   | Same Neon connection string (used server-side only)                             |
| `APP_PASSWORD`   | The single password required to edit settings (the dashboard itself is public)  |
| `SESSION_SECRET` | Optional; HMAC key for the session cookie (derived from `APP_PASSWORD` if unset) |

Vercel project settings:

- **Framework preset:** Vite
- **Root Directory:** `frontend`
- Build command and output directory are already set by `frontend/vercel.json`
  (`npm run build` → `dist`), so no override is needed.

`DATABASE_URL` and `APP_PASSWORD` live only in the serverless function and are
never bundled into the client.

---

## Running

### Poller — locally

```bash
pip install -r requirements.txt
# export DATABASE_URL, GMAIL_ADDRESS, GMAIL_APP_PASSWORD first
python -m poller.main
```

The run needs the three env vars above and a reachable Neon database. Keep
`dry_run = true` in the settings row while testing so no email is sent.

### Poller — via GitHub Actions

The `Hourly flight poll` workflow (`.github/workflows/poll.yml`) runs on a cron
schedule at **minute :07 every hour**, and can also be triggered manually via
**Run workflow** (`workflow_dispatch`) from the Actions tab. It installs
`requirements.txt`, runs `python -m poller.main`, and only fails the job on
poller exit code 2.

### Frontend — locally

```bash
cd frontend
npm install
npm run dev
```

For local dev the dashboard runs against an in-process WASM Postgres (PGlite)
seeded with sample data — no real database needed. See `frontend/README.md` for
the `SCENARIO` options (`normal`, `empty`, `stale`, `failing`) and how to run
against a real Neon database with `vercel dev`. Requires Node 20+.

---

## Tests

Poller (pytest):

```bash
python -m pytest -q
```

Frontend (Vitest):

```bash
cd frontend
npx vitest run
```

The poller suite covers run orchestration and the exit-code contract, the alert
rules, pattern expansion, snapshot writing/pruning, the email path, and both
data-source normalizers. The frontend suite covers the serverless handlers and
auth (against PGlite), the filtering/history logic, settings validation, and the
React pages and components.

---

## Operational notes

For day-to-day operations — database setup specifics, the data-source strategy
and how to revert to the `fast-flights` fallback, and what breaks and how you'd
notice — see [`RUNBOOK.md`](RUNBOOK.md).
