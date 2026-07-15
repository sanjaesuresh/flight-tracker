-- flight-tracker schema
-- Targets Neon / plain Postgres. No RLS anywhere: the poller connects with a single
-- full-privilege DATABASE_URL and there is no frontend yet — auth/RLS is deferred to Phase 3.
-- Safe to re-run: all DDL is `if not exists` and seed rows use `on conflict ... do nothing`.

-- Single-row app configuration. id is pinned to 1 so the poller can always
-- `select ... from settings where id = 1` without an ORDER BY / LIMIT dance.
create table if not exists settings (
    id                     int primary key check (id = 1),
    origins                text[]      not null default '{JFK,LGA}',
    destinations           text[]      not null default '{YYZ,YTZ}',
    preferred_origin       text        not null default 'LGA',
    preferred_destination  text        not null default 'YYZ',
    patterns               jsonb,
    window_days            int         not null default 60,
    threshold_usd          int         not null default 250,
    drop_pct               numeric     not null default 20,
    realert_step_pct       numeric     not null default 5,
    realert_step_dollars   numeric     not null default 10,
    min_history_days       int         not null default 5,
    alert_email            text,
    dry_run                boolean     not null default true,
    updated_at             timestamptz not null default now()
);

-- One row per scraped fare quote. return_* time columns are nullable because
-- fast-flights 3.0.2 does not return round-trip return-leg dep/arr times (upstream limitation).
create table if not exists price_snapshots (
    id                 bigint generated always as identity primary key,
    scraped_at         timestamptz not null,
    origin             text not null,
    destination        text not null,
    outbound_date      date not null,
    return_date        date not null,
    price_usd          int not null,
    airline            text,
    stops              int,
    outbound_dep_time  time,
    outbound_arr_time  time,
    return_dep_time    time,
    return_arr_time    time,
    booking_url        text
);

-- Supports the history/trend lookups the poller does per route+date-pair, most-recent first.
create index if not exists price_snapshots_route_date_scraped_idx
    on price_snapshots (origin, destination, outbound_date, return_date, scraped_at);

-- Phase 4: per-itinerary identity + per-direction detail, additive so old
-- rows keep working with nulls (fast-flights rows never populate these; the
-- fli normalizer does). itinerary_key is deterministic from both directions'
-- ordered legs (carrier + flight number + leg departure date) and MUST NOT
-- embed price -- see poller/snapshots.py's build_itinerary_key for the exact
-- format. Rows without enough leg data (fast-flights fallback) get a null
-- key and are simply excluded from per-option charts.
alter table price_snapshots add column if not exists itinerary_key text;
alter table price_snapshots add column if not exists outbound_airline text;
alter table price_snapshots add column if not exists return_airline text;
alter table price_snapshots add column if not exists outbound_flight_numbers text;
alter table price_snapshots add column if not exists return_flight_numbers text;
alter table price_snapshots add column if not exists outbound_stops int;
alter table price_snapshots add column if not exists return_stops int;

-- Supports the per-option hourly history lookup (Phase 5): same route+dates,
-- filtered to one itinerary_key, most-recent first.
create index if not exists price_snapshots_itinerary_scraped_idx
    on price_snapshots (origin, destination, outbound_date, return_date, itinerary_key, scraped_at);

-- One row per deal identity (upsert target) so re-alert logic can read the latest
-- alert for a given identity instead of scanning history. stops_bucket collapses
-- exact stop counts to 'nonstop' (0 stops) / 'connecting' (otherwise).
create table if not exists alerts_sent (
    origin             text not null,
    destination        text not null,
    outbound_date      date not null,
    return_date        date not null,
    airline            text not null,
    stops_bucket       text not null,
    alerted_price_usd  int not null,
    trigger_reason     text,
    sent_at            timestamptz not null,
    primary key (origin, destination, outbound_date, return_date, airline, stops_bucket)
);

-- Single-row poller run state. cursor tracks a round-robin slice cursor over the
-- pattern-expanded search matrix for the ROTATING scraper branch.
create table if not exists poller_state (
    id                     int primary key check (id = 1),
    last_success           timestamptz,
    consecutive_failures   int not null default 0,
    cursor                 int not null default 0
);

-- Seed the single settings row: airports {JFK,LGA}x{YYZ,YTZ}, preferred LGA->YYZ,
-- the two default weekend patterns (Thu>=5pm->Sun any; Fri any->Sun any), dry_run
-- on by default so a fresh deploy never sends real emails until reviewed.
insert into settings (
    id, origins, destinations, preferred_origin, preferred_destination,
    patterns, window_days, threshold_usd, drop_pct, realert_step_pct,
    realert_step_dollars, min_history_days, alert_email, dry_run
) values (
    1,
    '{JFK,LGA}',
    '{YYZ,YTZ}',
    'LGA',
    'YYZ',
    '[
        {"outbound_weekday":3,"outbound_start":"17:00","outbound_end":"23:59","return_weekday":6,"return_start":null,"return_end":null},
        {"outbound_weekday":4,"outbound_start":null,"outbound_end":null,"return_weekday":6,"return_start":null,"return_end":null}
    ]'::jsonb,
    60,
    250,
    20,
    5,
    10,
    5,
    null,
    true
)
on conflict (id) do nothing;

-- Seed the single poller_state row: no failures yet, cursor starts at 0.
insert into poller_state (id, last_success, consecutive_failures, cursor)
values (1, null, 0, 0)
on conflict (id) do nothing;
