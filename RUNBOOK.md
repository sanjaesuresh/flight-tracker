# Runbook

Operational steps for running and maintaining the flight-tracker poller.

## Database setup (Neon)

1. Create a free Neon project at https://neon.tech (sign in with GitHub, no card required).
2. In the project's Connect panel, copy the **direct** connection string. It must include
   `?sslmode=require`. Put it in your local `.env` as `DATABASE_URL`. This value is a secret —
   do not commit it. It also needs to be added to GitHub Actions secrets later (Task 11).
3. Apply the schema, either:
   - paste the contents of `db/schema.sql` into the Neon SQL editor and run it, or
   - run it locally: `psql "$DATABASE_URL" -f db/schema.sql`
4. Verify the seed rows landed:
   - `select count(*) from settings;` should return `1`.
   - `select id, dry_run from settings;` should show `id = 1`, `dry_run = true`.

`db/schema.sql` is idempotent (`create table if not exists`, `on conflict (id) do nothing`), so
re-running it against an already-set-up database is safe.

## Google Flights scraping strategy (ROTATING branch)

fast-flights 3.0.2 has no calendar/date-grid sweep, so there is no cheap
coarse scan (`GoogleFlightsSource.coarse_scan` raises `NotImplementedError`
on purpose). The CALENDAR branch is not applicable for this dependency
version. Instead, each poll confirms a budget-limited, round-robin slice of
the pattern-expanded candidate date-pairs via `confirm_candidates`, so
consecutive polls eventually cover the whole matrix within the request
budget (default 40 per poll, randomized 2-6s pacing between searches).

## What breaks and how you'd know

(To be completed in Task 12.)
