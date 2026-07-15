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

## Google Flights data source strategy (ROTATING branch)

As of Phase 2 (see `docs/planning/rework-plan.md`), the poller's default
source is `FliSource` (`poller/data_source/fli_source.py`), backed by the
`flights` PyPI package (imported as `fli`, pinned to `0.9.0`) — a
reverse-engineered client for Google Flights' protobuf RPC endpoints. Neither
fli nor fast-flights has a cheap calendar/date-grid sweep, so there is no
coarse scan (`coarse_scan` raises `NotImplementedError` on purpose). The
CALENDAR branch is not applicable. Instead, each poll confirms a
budget-limited, round-robin slice of the pattern-expanded candidate
date-pairs via `confirm_candidates`, so consecutive polls eventually cover
the whole matrix within the request budget (default 40 per poll, randomized
2-6s pacing between searches).

fli occasionally returns an empty/None result that succeeds on retry
(observed live during Phase 2 investigation). `FliSource.search()` treats
one empty result as a soft miss and retries once; only a second empty
counts as a legitimate zero-offers result, and only a raised exception
counts toward `failed_count`.

Per itinerary, the poller stores the specific booking deep-link
(`/travel/flights/booking?tfs=...&tfu=...&curr=USD`) rather than the dated
search-page link, and both directions' departure/arrival times are now
populated (fli's round-trip results carry full per-leg data on both
directions — the return-leg data gap under fast-flights doesn't exist here).

### Fallback: reverting to fast-flights if fli breaks

fli is a reverse-engineered API and Google can change its wire format
without notice. `poller/data_source/google_flights.py` (`GoogleFlightsSource`,
fast-flights-backed) is kept fully intact in the tree as the documented
fallback — it is still imported (unused) by `poller/main.py` and its test
suite (`tests/test_google_flights.py`, `tests/test_normalize.py`) stays
green. To fall back:

1. In `poller/main.py`, swap `source = FliSource()` back to
   `source = GoogleFlightsSource()`.
2. `fast-flights==3.0.2` is already pinned in `requirements.txt` (kept
   installed alongside `flights` for exactly this reason) — no dependency
   change needed.
3. Under fast-flights, the best achievable booking link degrades to the
   dated `/travel/flights/search?tfs=...` page (all options for the exact
   airports and dates — strictly better than a generic search), return-leg
   times go back to `null`, and mixed-airline round-trip pairing is not
   represented. The rest of the system (rules, emailer, dashboard, schema)
   is unaffected either way — both libraries are hidden behind the
   `DataSource` seam in `poller/data_source`.

If only the `/booking` deep-link construction breaks (e.g. Google changes
the `tfu`/`tfs` wire shape) while fli's search itself still works, the
degrade path is narrower: `poller/data_source/normalize_fli.py` can fall
back to `poller/data_source/normalize.py`'s `build_search_url`-style dated
search URL instead of `booking_url.build_booking_url`, without reverting the
whole source. `tests/test_booking_url.py` asserts the `tfu` construction
round-trips against a value independently verified against fli's own
`extract_booking_token_from_tfu` — a failure there is the signal that this
narrower degrade is needed.

## What breaks and how you'd know

(To be completed in Task 12.)
