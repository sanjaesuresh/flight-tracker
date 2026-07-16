# Flight watch — dashboard (Phase 3)

A single-user web dashboard for the NYC ↔ Toronto cheap-flight tracker. It shows
the cheapest current options, a date → price graph, filters, and a validated
settings editor, and treats empty / stale / scraper-failing as first-class states.

The poller (Phases 0–2) owns scraping, snapshots, alerts, and email. This app is a
read-mostly window onto `price_snapshots` plus a validated writer of the single
`settings` row.

## Architecture

- **SPA** — Vite + React 18 + TypeScript. The browser talks **only** to same-origin
  `/api/*` and never holds a database credential.
- **Serverless API** — one catch-all function (`api/[...path].ts`) that holds
  `DATABASE_URL` + `APP_PASSWORD` server-side and queries Neon over the
  `@neondatabase/serverless` HTTP driver. There is no RLS; the API is the
  authorization boundary.
- **Auth** — one password (`APP_PASSWORD`), checked constant-time, exchanged for a
  signed **httpOnly** session cookie. Every data route rejects unauthenticated
  requests.
- **One codebase, three runtimes** — the core handlers are framework-free
  (`src/server/*`). They run under Vercel (Neon), under `vite dev` (an in-process
  PGlite seeded from `../db/schema.sql`), and under Vitest — with no duplication.

Canonical timezone is **America/New_York** everywhere; prices are **USD**.

## Requirements

- Node 20+ (developed on Node 26). Nothing else — local dev needs no database.

## Run locally

```bash
npm install
APP_PASSWORD=devpass npm run dev
```

Open the printed URL and sign in with the password you set. Local dev serves the
`/api/*` routes from an in-process PGlite database seeded with synthetic data, so
you can see every screen without touching Neon.

### Seeing each state

Set `SCENARIO` when starting dev to seed a different situation:

```bash
APP_PASSWORD=devpass SCENARIO=normal  npm run dev   # cheapest list + graph (default)
APP_PASSWORD=devpass SCENARIO=empty   npm run dev   # no snapshots yet → empty state
APP_PASSWORD=devpass SCENARIO=stale   npm run dev   # last success ~30h ago → stale banner
APP_PASSWORD=devpass SCENARIO=failing npm run dev   # consecutive failures → failing banner
```

Staleness threshold and failure threshold live in `src/lib/health.ts`
(`STALE_HOURS = 6`, `FAIL_THRESHOLD = 3`).

### Point local dev at a real database (optional)

Put a real `DATABASE_URL` in `.env.local` and run `vercel dev` instead (needs the
Vercel CLI). Plain `npm run dev` always uses PGlite.

## Test / typecheck / lint / build

```bash
npm test          # Vitest: pure logic, components, and a full server path on PGlite
npm run typecheck # tsc, strict
npm run lint      # ESLint
npm run build     # tsc + vite build → dist/
```

## Deploy (Vercel, free tier)

1. Import this `frontend/` directory as a Vercel project (framework preset: Vite).
2. Set two environment variables in **Project Settings → Environment Variables**:
   - `DATABASE_URL` — your Neon connection string.
   - `APP_PASSWORD` — the dashboard password.
   - (optional) `SESSION_SECRET` — random string; otherwise derived from `APP_PASSWORD`.
3. Deploy. `vercel.json` builds the static SPA to `dist/` and routes `/api/*` to the
   serverless function; all other paths fall back to the SPA.

Cloudflare Pages works too (static `dist/` + a Pages Function equivalent of the
catch-all), but the included config targets Vercel.

## Security invariants

- `DATABASE_URL` / `APP_PASSWORD` are **server-side only**. The client bundle is
  grep-checked in CI-style verification to contain no connection string, secret env
  name, or server module. The repo is public — never commit real secret values.
- All settings writes go through the same validator the poller uses
  (`src/lib/settingsSchema.ts`, mirroring `poller/db.py:parse_settings`), on both the
  form and the server, so the form can never persist a value the poller would reject.

## Responsive behavior

Breakpoints in use (`src/styles.css`):

- `860px` — dashboard grid + sidebar collapse to one column.
- `680px` — topbar goes compact, the board table stacks to cards, and a
  spacing/min-text pass tightens the mobile blocks.
- `640px` — settings form grid collapses.
- `560px` — pattern editor legs stack.
- `420px` — paired time inputs stack.
- `(pointer: coarse)` — a 44px touch-target block enlarges tappable controls
  (also applies at small widths regardless of pointer type).

Convention: rules are written desktop-first; each `max-width` media query
override lives directly next to the rule(s) it overrides in `src/styles.css`,
rather than being grouped in a separate mobile section.

## Layout

```
api/[...path].ts        Vercel serverless entry (Neon HTTP driver)
src/server/             framework-free handlers, router, auth, http, pglite (dev/test)
src/lib/                types, timezone, settings contract, filter, api client, health
src/auth/               AuthProvider + login screen
src/components/         CheapestList, PriceGraph, Filters, SettingsForm, PatternEditor, state/
src/pages/              Dashboard, Settings
```
