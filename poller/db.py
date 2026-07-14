"""Neon Postgres access: connection construction, settings parsing, poller state.

`parse_settings` is pure (no DB, no clock) so it's fully unit-testable; the
connection helper and the thin read/write functions around it are not
exercised by tests — they're a straightforward psycopg v3 wrapper.
"""
from datetime import datetime, time

import psycopg
from psycopg.rows import dict_row

from poller.config import Config
from poller.models import Pattern, Settings
from poller.rules import deal_identity

# The two seed patterns from the canonical shapes doc (Thu>=5pm -> Sun any;
# Fri any -> Sun any). Used as the fallback when settings.patterns is empty.
DEFAULT_PATTERNS = [
    Pattern(
        outbound_weekday=3,
        outbound_start=time(17, 0),
        outbound_end=time(23, 59),
        return_weekday=6,
        return_start=None,
        return_end=None,
    ),
    Pattern(
        outbound_weekday=4,
        outbound_start=None,
        outbound_end=None,
        return_weekday=6,
        return_start=None,
        return_end=None,
    ),
]

DEFAULT_THRESHOLD_USD = 250
DEFAULT_PREFERRED_ORIGIN = "LGA"
DEFAULT_PREFERRED_DESTINATION = "YYZ"
DEFAULT_WINDOW_DAYS = 60
DEFAULT_DROP_PCT = 20
DEFAULT_REALERT_STEP_PCT = 5
DEFAULT_REALERT_STEP_DOLLARS = 10
DEFAULT_MIN_HISTORY_DAYS = 5
DEFAULT_DRY_RUN = True


def get_connection(config: Config) -> psycopg.Connection:
    """Builds a psycopg v3 connection from Config.database_url.

    SSL is whatever the URL itself specifies (Neon URLs include sslmode).
    Kept thin and untested by design — it's a single call to the driver.
    """
    return psycopg.connect(config.database_url, row_factory=dict_row)


def _parse_time(value: str | None) -> time | None:
    """"HH:MM" -> time, null stays null (unbounded)."""
    if value is None:
        return None
    hour_str, minute_str = value.split(":")
    return time(int(hour_str), int(minute_str))


def _parse_pattern(raw: dict, warnings: list[str]) -> Pattern | None:
    """Builds one Pattern from a raw jsonb pattern object.

    Drops (returns None) any pattern whose bounded window has end < start —
    the window is meaningless and would otherwise silently match nothing or
    everything depending on how expansion handles it downstream. Also drops
    (rather than raising) any pattern with a missing/wrong-typed required
    field or a malformed "HH:MM" time string — hand-edited config is not
    trusted to be well-formed, so one bad pattern must not crash the poller.
    """
    try:
        outbound_start = _parse_time(raw.get("outbound_start"))
        outbound_end = _parse_time(raw.get("outbound_end"))
        return_start = _parse_time(raw.get("return_start"))
        return_end = _parse_time(raw.get("return_end"))
        outbound_weekday = int(raw["outbound_weekday"])
        return_weekday = int(raw["return_weekday"])
    except (KeyError, TypeError, ValueError, AttributeError) as exc:
        warnings.append(f"Dropping malformed pattern ({exc}): {raw}")
        return None

    if outbound_start is not None and outbound_end is not None and outbound_end < outbound_start:
        warnings.append(
            f"Dropping pattern with outbound window end before start: {raw}"
        )
        return None
    if return_start is not None and return_end is not None and return_end < return_start:
        warnings.append(
            f"Dropping pattern with return window end before start: {raw}"
        )
        return None

    return Pattern(
        outbound_weekday=outbound_weekday,
        outbound_start=outbound_start,
        outbound_end=outbound_end,
        return_weekday=return_weekday,
        return_start=return_start,
        return_end=return_end,
    )


def parse_settings(row: dict) -> tuple[Settings, list[str]]:
    """Maps a raw settings row (columns + patterns jsonb list) into a Settings.

    Pure: no DB, no clock. Returns (settings, warnings) — warnings are
    returned, not printed, so callers (main.py) decide logging and can keep
    the alert email address out of logs.
    """
    warnings: list[str] = []

    raw_patterns = row.get("patterns")
    if not isinstance(raw_patterns, list):
        if raw_patterns:
            # present but not a list (dict/string/etc) — can't iterate pattern
            # objects out of it, so treat as absent rather than raising.
            warnings.append(
                f"settings.patterns was not a list ({raw_patterns!r}); ignoring."
            )
        raw_patterns = []

    patterns = []
    for raw_pattern in raw_patterns:
        pattern = _parse_pattern(raw_pattern, warnings)
        if pattern is not None:
            patterns.append(pattern)

    if not patterns:
        warnings.append("No valid patterns in settings; falling back to default seed patterns.")
        patterns = list(DEFAULT_PATTERNS)

    threshold_usd = row.get("threshold_usd")
    if threshold_usd is None or threshold_usd <= 0:
        warnings.append(
            f"threshold_usd was invalid ({threshold_usd!r}); falling back to {DEFAULT_THRESHOLD_USD}."
        )
        threshold_usd = DEFAULT_THRESHOLD_USD

    # `is not None` (not `or`) so an intentionally-set falsy value (0, "", [])
    # is preserved rather than silently overridden by the default.
    origins = row.get("origins")
    destinations = row.get("destinations")
    preferred_origin = row.get("preferred_origin")
    preferred_destination = row.get("preferred_destination")
    window_days = row.get("window_days")
    min_history_days = row.get("min_history_days")

    settings = Settings(
        origins=list(origins) if origins is not None else ["JFK", "LGA"],
        destinations=list(destinations) if destinations is not None else ["YYZ", "YTZ"],
        preferred_origin=preferred_origin if preferred_origin is not None else DEFAULT_PREFERRED_ORIGIN,
        preferred_destination=(
            preferred_destination if preferred_destination is not None else DEFAULT_PREFERRED_DESTINATION
        ),
        patterns=patterns,
        window_days=window_days if window_days is not None else DEFAULT_WINDOW_DAYS,
        threshold_usd=threshold_usd,
        drop_pct=float(row.get("drop_pct") if row.get("drop_pct") is not None else DEFAULT_DROP_PCT),
        realert_step_pct=float(
            row.get("realert_step_pct") if row.get("realert_step_pct") is not None else DEFAULT_REALERT_STEP_PCT
        ),
        realert_step_dollars=float(
            row.get("realert_step_dollars")
            if row.get("realert_step_dollars") is not None
            else DEFAULT_REALERT_STEP_DOLLARS
        ),
        min_history_days=min_history_days if min_history_days is not None else DEFAULT_MIN_HISTORY_DAYS,
        alert_email=row.get("alert_email"),
        dry_run=row.get("dry_run") if row.get("dry_run") is not None else DEFAULT_DRY_RUN,
        updated_at=row.get("updated_at"),
    )

    return settings, warnings


def fetch_settings(conn) -> tuple[Settings, list[str]]:
    """Reads the single settings row (id = 1) and delegates to parse_settings."""
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM settings WHERE id = 1")
        row = cur.fetchone()
    return parse_settings(row)


def get_poller_state(conn) -> dict:
    """Reads the single poller_state row (id = 1)."""
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM poller_state WHERE id = 1")
        return cur.fetchone()


def set_poller_state(
    conn,
    *,
    last_success: datetime | None = None,
    consecutive_failures: int | None = None,
    cursor: int | None = None,
) -> None:
    """Updates the single poller_state row (id = 1). Only provided fields are set."""
    updates = []
    params: list = []

    if last_success is not None:
        updates.append("last_success = %s")
        params.append(last_success)
    if consecutive_failures is not None:
        updates.append("consecutive_failures = %s")
        params.append(consecutive_failures)
    if cursor is not None:
        updates.append("cursor = %s")
        params.append(cursor)

    if not updates:
        return

    query = f"UPDATE poller_state SET {', '.join(updates)} WHERE id = 1"
    with conn.cursor() as cur:
        cur.execute(query, params)
    conn.commit()


HISTORY_FOR_OD_SQL = """
    SELECT scraped_at, price_usd
    FROM price_snapshots
    WHERE origin = %s AND destination = %s
      AND scraped_at >= now() - (%s || ' days')::interval
    ORDER BY scraped_at
"""


def history_for_od(conn, origin: str, destination: str, days: int) -> list[tuple]:
    """(scraped_at, price_usd) history across ALL date-pairs for one O-D,
    trailing `days` days -- the pattern-level baseline rules.evaluate falls
    back to when a specific date-pair doesn't have enough history yet.
    """
    with conn.cursor() as cur:
        cur.execute(HISTORY_FOR_OD_SQL, (origin, destination, days))
        return list(cur.fetchall())


GET_LAST_ALERT_PRICE_SQL = """
    SELECT alerted_price_usd
    FROM alerts_sent
    WHERE origin = %s AND destination = %s
      AND outbound_date = %s AND return_date = %s
      AND airline = %s AND stops_bucket = %s
"""


def get_last_alert_price(conn, identity: tuple) -> int | None:
    """Latest alerted price for a deal_identity 6-tuple (origin, destination,
    outbound_date, return_date, airline, stops_bucket), or None if never
    alerted. alerts_sent holds one row per identity (upsert target), so there
    is at most one match -- no ORDER BY/LIMIT needed.
    """
    with conn.cursor() as cur:
        cur.execute(GET_LAST_ALERT_PRICE_SQL, identity)
        row = cur.fetchone()
    if row is None:
        return None
    # production connections always use dict_row (see get_connection).
    return row["alerted_price_usd"]


RECORD_ALERT_SQL = """
    INSERT INTO alerts_sent (
        origin, destination, outbound_date, return_date, airline, stops_bucket,
        alerted_price_usd, trigger_reason, sent_at
    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (origin, destination, outbound_date, return_date, airline, stops_bucket)
    DO UPDATE SET
        alerted_price_usd = EXCLUDED.alerted_price_usd,
        trigger_reason = EXCLUDED.trigger_reason,
        sent_at = EXCLUDED.sent_at
"""


def record_alert(conn, trip, decision, sent_at: datetime) -> None:
    """Upserts the one alerts_sent row for trip's deal_identity so future
    polls can read back the latest alerted price for the re-alert dedup gate.
    """
    identity = deal_identity(trip)
    # reasons is an unordered set; sort so the stored trigger_reason string is
    # deterministic across runs (matters for tests and for anyone eyeballing the row).
    trigger_reason = ",".join(sorted(decision.reasons))
    params = identity + (trip.offer.price_usd, trigger_reason, sent_at)

    with conn.cursor() as cur:
        cur.execute(RECORD_ALERT_SQL, params)
    conn.commit()
