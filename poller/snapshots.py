"""Writes flight-offer snapshots to price_snapshots, plus the two read
helpers the rules layer needs (history for a pair, latest-per-pair list).

All functions take a psycopg-style `conn` and only ever touch it through
`conn.cursor()` / `cur.execute()` / `conn.commit()` -- that minimal surface is
what lets tests substitute a fake connection instead of a live Neon one.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from poller.models import Offer, SearchRequest

NY_TZ = ZoneInfo("America/New_York")

# Phase 4 keep-N: cheapest N distinct itineraries (by itinerary_key) kept per
# request/date-pair each poll, always including the overall cheapest offer.
KEEP_N_ITINERARIES = 10

# Phase 4 retention: rows older than this many days get pruned regardless of
# outbound_date, keeping the table bounded on Neon's free tier.
RETENTION_DAYS = 90

# the 20-positional %s bind is a footgun: the values tuple built in
# _insert_request MUST stay in the exact same order as this column list.
INSERT_SQL = """
    INSERT INTO price_snapshots (
        scraped_at, origin, destination, outbound_date, return_date,
        price_usd, airline, stops,
        outbound_dep_time, outbound_arr_time, return_dep_time, return_arr_time,
        booking_url,
        itinerary_key, outbound_airline, return_airline,
        outbound_flight_numbers, return_flight_numbers,
        outbound_stops, return_stops
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
"""

PRUNE_PAST_OUTBOUND_SQL = """
    DELETE FROM price_snapshots WHERE outbound_date < %s
"""

PRUNE_OLD_SCRAPES_SQL = """
    DELETE FROM price_snapshots WHERE scraped_at < %s
"""

HISTORY_SQL = """
    SELECT scraped_at, price_usd
    FROM price_snapshots
    WHERE origin = %s AND destination = %s
      AND outbound_date = %s AND return_date = %s
      AND scraped_at >= now() - (%s || ' days')::interval
    ORDER BY scraped_at
"""

# DISTINCT ON keeps one row per route+date pair, picking the newest by
# ordering ties on scraped_at DESC -- the standard Postgres idiom for
# "latest row per group" without a window function/subquery.
LATEST_SQL = """
    SELECT DISTINCT ON (origin, destination, outbound_date, return_date) *
    FROM price_snapshots
    ORDER BY origin, destination, outbound_date, return_date, scraped_at DESC
"""


@dataclass
class WriteResult:
    written: int
    failed_requests: int


def _rows_to_insert(offers: list[Offer]) -> list[Offer]:
    """Picks which offers become snapshot rows for one request.

    Phase 4 rule (replaces the old one-per-airline-within-$30 rule): keep the
    cheapest KEEP_N_ITINERARIES DISTINCT itineraries, always including the
    overall cheapest offer. "Distinct" = distinct itinerary_key -- this is
    what makes per-option history possible (Verdict D).

    Offers with a null itinerary_key (the fast-flights fallback path, which
    has no leg data to build a key) can't be deduped by key -- treating every
    null-key offer as one bucket would collapse them all into a single row
    and could silently drop the overall cheapest if it happened to have a
    null key. Instead each null-key offer falls back to the prior per-airline
    dedup (cheapest-per-airline), so distinct airlines still each get a
    chance at a row, same as the old rule.
    """
    if not offers:
        return []

    best = min(offers, key=lambda o: o.price_usd)

    keyed: dict[str, Offer] = {}
    null_key_by_airline: dict[str, Offer] = {}
    for offer in offers:
        if offer.itinerary_key is not None:
            current = keyed.get(offer.itinerary_key)
            if current is None or offer.price_usd < current.price_usd:
                keyed[offer.itinerary_key] = offer
        else:
            current = null_key_by_airline.get(offer.airline)
            if current is None or offer.price_usd < current.price_usd:
                null_key_by_airline[offer.airline] = offer

    # rank all distinct candidates (one per key, one per null-key airline)
    # cheapest-first, then keep the top N.
    candidates = list(keyed.values()) + list(null_key_by_airline.values())
    candidates.sort(key=lambda o: o.price_usd)
    kept = candidates[:KEEP_N_ITINERARIES]

    # the overall cheapest must always be included, even if it fell outside
    # the top-N slice above (can't happen with a correct sort, but a
    # defensive belt-and-suspenders since "always include cheapest" is a
    # hard requirement, not just a side effect of sorting).
    if best not in kept:
        kept.append(best)

    return kept


def _insert_request(conn, scraped_at: datetime, request: SearchRequest, rows: list[Offer]) -> None:
    """Inserts one request's rows and commits.

    Committing per-request (rather than one transaction for the whole batch)
    is the whole point of the partial-success contract: if a later request's
    insert raises, the earlier requests' rows must already be durable, not
    rolled back with it.
    """
    with conn.cursor() as cur:
        for offer in rows:
            cur.execute(
                INSERT_SQL,
                (
                    scraped_at,
                    # Phase 3: store the offer's ACTUAL leg airports when set
                    # (fli always sets these; the fast-flights fallback sets
                    # them per-pair too) -- fall back to the request's
                    # representative pair only for the legacy null case.
                    offer.origin or request.origin,
                    offer.destination or request.destination,
                    request.outbound_date,
                    request.return_date,
                    offer.price_usd,
                    offer.airline,
                    offer.stops,
                    offer.outbound_dep,
                    offer.outbound_arr,
                    offer.return_dep,
                    offer.return_arr,
                    offer.booking_url,
                    offer.itinerary_key,
                    offer.outbound_airline,
                    offer.return_airline,
                    offer.outbound_flight_numbers,
                    offer.return_flight_numbers,
                    offer.outbound_stops,
                    offer.return_stops,
                ),
            )
    conn.commit()


def write_snapshots(
    conn,
    scraped_at: datetime,
    offers_by_request: Iterable[tuple[SearchRequest, list[Offer]]],
) -> WriteResult:
    """Inserts snapshot rows per SearchRequest, one commit per request.

    A request with zero offers inserts nothing and is not a failure (nothing
    to fail at). If a request's insert raises partway through, that request
    is counted as failed and the loop continues to the next request --
    earlier requests already committed are unaffected, and later requests
    still get their chance.
    """
    written = 0
    failed_requests = 0

    for request, offers in offers_by_request:
        rows = _rows_to_insert(list(offers))
        if not rows:
            continue
        try:
            _insert_request(conn, scraped_at, request, rows)
        except Exception:
            failed_requests += 1
            continue
        written += len(rows)

    return WriteResult(written=written, failed_requests=failed_requests)


def history_for_pair(
    conn,
    origin: str,
    destination: str,
    outbound_date: date,
    return_date: date,
    days: int,
) -> list[tuple]:
    """(scraped_at, price_usd) history for one exact route+date pair, trailing `days` days."""
    with conn.cursor() as cur:
        cur.execute(HISTORY_SQL, (origin, destination, outbound_date, return_date, days))
        return list(cur.fetchall())


def latest_snapshots(conn) -> list[dict]:
    """Most-recent snapshot row per (origin, destination, outbound_date, return_date)."""
    with conn.cursor() as cur:
        cur.execute(LATEST_SQL)
        return list(cur.fetchall())


def prune_snapshots(conn, now: datetime) -> None:
    """Retention pass (Phase 4): deletes rows for trips that have already
    departed (outbound_date in the past, America/New_York) and rows older
    than RETENTION_DAYS regardless of outbound_date -- keeps the table
    bounded on Neon's free tier under hourly x keep-N growth. Best-effort:
    callers (run_poll) must not let a prune failure fail the poll itself.

    Same cursor/execute/commit surface as the write path so the existing
    fake-conn test style works unchanged; one commit after both deletes.
    """
    today = now.astimezone(NY_TZ).date()
    cutoff_scraped_at = now - timedelta(days=RETENTION_DAYS)
    with conn.cursor() as cur:
        cur.execute(PRUNE_PAST_OUTBOUND_SQL, (today,))
        cur.execute(PRUNE_OLD_SCRAPES_SQL, (cutoff_scraped_at,))
    conn.commit()
