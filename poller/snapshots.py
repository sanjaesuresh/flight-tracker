"""Writes flight-offer snapshots to price_snapshots, plus the two read
helpers the rules layer needs (history for a pair, latest-per-pair list).

All functions take a psycopg-style `conn` and only ever touch it through
`conn.cursor()` / `cur.execute()` / `conn.commit()` -- that minimal surface is
what lets tests substitute a fake connection instead of a live Neon one.
"""
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime

from poller.models import Offer, SearchRequest

INSERT_SQL = """
    INSERT INTO price_snapshots (
        scraped_at, origin, destination, outbound_date, return_date,
        price_usd, airline, stops,
        outbound_dep_time, outbound_arr_time, return_dep_time, return_arr_time,
        booking_url
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
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

    best = cheapest offer overall. Then, per airline, keep only that
    airline's cheapest offer, and include it if it's within $30 of best --
    this yields at most one row per distinct airline (so the dashboard can
    filter by airline) and best's own airline always qualifies (delta 0).
    """
    if not offers:
        return []

    best = min(offers, key=lambda o: o.price_usd)

    cheapest_by_airline: dict[str, Offer] = {}
    for offer in offers:
        current = cheapest_by_airline.get(offer.airline)
        if current is None or offer.price_usd < current.price_usd:
            cheapest_by_airline[offer.airline] = offer

    return [
        offer
        for offer in cheapest_by_airline.values()
        if offer.price_usd <= best.price_usd + 30
    ]


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
                    request.origin,
                    request.destination,
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
