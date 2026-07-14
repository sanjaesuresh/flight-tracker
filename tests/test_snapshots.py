"""Tests for poller.snapshots: per-request-commit writes with partial-success
semantics, plus the two read helpers used by the rules layer.

A FAKE psycopg-style connection is built here (no live DB): cursor() returns
a context manager that records (sql, params) on each execute() call, and
commit() records a commit marker in the same list -- so tests can assert the
exact interleaving of inserts vs commits vs the failure, which is the whole
point of the partial-success contract.
"""
from datetime import date, datetime, time, timezone

import pytest

from poller.models import Offer, SearchRequest
from poller.snapshots import WriteResult, history_for_pair, latest_snapshots, write_snapshots


class FakeCursor:
    """Records every execute() call into the shared `events` list."""

    def __init__(self, events, raise_on_sql_containing=None):
        self.events = events
        self._raise_on_sql_containing = raise_on_sql_containing
        self._last_sql = None
        self._fetch_result = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        if self._raise_on_sql_containing and self._raise_on_sql_containing in sql:
            raise RuntimeError("simulated DB failure")
        self.events.append(("execute", sql, params))
        self._last_sql = sql

    def fetchall(self):
        return self._fetch_result or []

    def fetchone(self):
        return self._fetch_result


class FakeConn:
    """Fake psycopg connection.

    `raise_after` lets a test say "raise on the Nth execute() call" so we can
    simulate one request's insert failing mid-stream without coupling the
    test to SQL string contents.
    """

    def __init__(self, raise_after_execute_count=None):
        self.events = []
        self._raise_after_execute_count = raise_after_execute_count
        self._execute_count = 0

    def cursor(self):
        return _CountingCursor(self)

    def commit(self):
        self.events.append(("commit",))


class _CountingCursor:
    """Cursor that raises once a configured execute() call count is reached.

    Separate from FakeCursor because write_snapshots opens a fresh cursor per
    request but the raise threshold is counted across the whole connection.
    """

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.conn._execute_count += 1
        if (
            self.conn._raise_after_execute_count is not None
            and self.conn._execute_count == self.conn._raise_after_execute_count
        ):
            raise RuntimeError("simulated DB failure")
        self.conn.events.append(("execute", sql, params))

    def fetchall(self):
        return []

    def fetchone(self):
        return None


def make_offer(price_usd, airline, stops=0):
    return Offer(
        price_usd=price_usd,
        airline=airline,
        stops=stops,
        outbound_dep=time(17, 0),
        outbound_arr=time(19, 0),
        return_dep=None,
        return_arr=None,
        booking_url="https://example.com/book",
    )


def make_request(origin="JFK", destination="YYZ", outbound_date=None, return_date=None):
    return SearchRequest(
        origin=origin,
        destination=destination,
        outbound_date=outbound_date or date(2026, 8, 6),
        return_date=return_date or date(2026, 8, 9),
    )


def test_two_requests_within_30_dollar_airline_rule_inserts_extra_rows():
    """best=$200 (airline A); B=$220 included (<=230); C=$260 excluded.

    Second request just has a single cheap offer -- one row.
    """
    req1 = make_request(outbound_date=date(2026, 8, 6), return_date=date(2026, 8, 9))
    req2 = make_request(outbound_date=date(2026, 8, 13), return_date=date(2026, 8, 16))

    offers1 = [
        make_offer(200, "Airline A"),
        make_offer(220, "Airline B"),
        make_offer(260, "Airline C"),
    ]
    offers2 = [make_offer(150, "Airline D")]

    conn = FakeConn()
    scraped_at = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)

    result = write_snapshots(conn, scraped_at, [(req1, offers1), (req2, offers2)])

    assert isinstance(result, WriteResult)
    assert result.failed_requests == 0
    # req1: A ($200) + B ($220) inserted, C ($260) excluded -> 2 rows.
    # req2: 1 row.
    assert result.written == 3

    inserted_prices = [
        event[2][5]  # price_usd position in the insert params, see snapshots.py
        for event in conn.events
        if event[0] == "execute"
    ]
    assert sorted(inserted_prices) == [150, 200, 220]

    # one commit per request (2 requests -> 2 commits), issued after that
    # request's inserts.
    commit_count = sum(1 for e in conn.events if e[0] == "commit")
    assert commit_count == 2


def test_request_with_zero_offers_inserts_nothing_and_is_not_a_failure():
    req = make_request()
    conn = FakeConn()
    scraped_at = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)

    result = write_snapshots(conn, scraped_at, [(req, [])])

    assert result.written == 0
    assert result.failed_requests == 0
    assert conn.events == []


def test_partial_success_middle_request_fails_first_and_third_still_written():
    """Three requests, the SECOND raises on its insert.

    First request's rows must be inserted+committed before the failure. The
    third must still be attempted despite the second's exception, and its
    rows written too. WriteResult must report failed_requests == 1 and count
    only the first+third rows as written.
    """
    req1 = make_request(outbound_date=date(2026, 8, 6), return_date=date(2026, 8, 9))
    req2 = make_request(outbound_date=date(2026, 8, 13), return_date=date(2026, 8, 16))
    req3 = make_request(outbound_date=date(2026, 8, 20), return_date=date(2026, 8, 23))

    offers1 = [make_offer(100, "Airline A")]
    offers2 = [make_offer(300, "Airline B")]
    offers3 = [make_offer(400, "Airline C")]

    # req1 has 1 execute (1 row) -> succeeds normally, then commit.
    # req2's single execute call is the 2nd execute overall -> configure the
    # raise to hit exactly that call.
    conn = FakeConn(raise_after_execute_count=2)
    scraped_at = datetime(2026, 7, 14, 12, 0, tzinfo=timezone.utc)

    result = write_snapshots(conn, scraped_at, [(req1, offers1), (req2, offers2), (req3, offers3)])

    assert result.failed_requests == 1
    assert result.written == 2  # req1's row + req3's row

    # req1 must be committed before req2 ever raises -- assert the FIRST
    # event recorded is req1's execute, followed immediately by its commit,
    # proving the commit happened prior to req2's failure.
    assert conn.events[0][0] == "execute"
    assert conn.events[0][2][5] == 100  # req1's price
    assert conn.events[1] == ("commit",)

    # after the failure, req3's insert + commit must still appear.
    remaining_prices = [e[2][5] for e in conn.events if e[0] == "execute"]
    assert 400 in remaining_prices
    assert 300 not in remaining_prices  # req2 never got recorded (raised)

    commit_count = sum(1 for e in conn.events if e[0] == "commit")
    assert commit_count == 2  # req1 and req3 only; req2 never committed


def test_history_for_pair_issues_expected_sql_and_params():
    events = []
    conn = _EventsOnlyConn(events, fetch_result=[
        (datetime(2026, 7, 10, 12, 0), 199),
        (datetime(2026, 7, 12, 12, 0), 205),
    ])

    rows = history_for_pair(conn, "JFK", "YYZ", date(2026, 8, 6), date(2026, 8, 9), days=14)

    assert rows == [
        (datetime(2026, 7, 10, 12, 0), 199),
        (datetime(2026, 7, 12, 12, 0), 205),
    ]
    assert len(events) == 1
    sql, params = events[0]
    assert "price_snapshots" in sql
    assert "%s" in sql
    assert params[:4] == ("JFK", "YYZ", date(2026, 8, 6), date(2026, 8, 9))
    # last param drives the trailing-days window
    assert params[-1] == 14


def test_latest_snapshots_issues_distinct_on_query():
    events = []
    conn = _EventsOnlyConn(
        events,
        fetch_result=[
            {"origin": "JFK", "destination": "YYZ", "price_usd": 199},
        ],
    )

    rows = latest_snapshots(conn)

    assert rows == [{"origin": "JFK", "destination": "YYZ", "price_usd": 199}]
    assert len(events) == 1
    sql, params = events[0]
    assert "DISTINCT ON" in sql
    assert "price_snapshots" in sql


class _EventsOnlyConn:
    """Minimal fake for the two read helpers: records the single execute()
    call and returns a canned fetch result."""

    def __init__(self, events, fetch_result):
        self.events = events
        self.fetch_result = fetch_result

    def cursor(self):
        return _ReadCursor(self)


class _ReadCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.conn.events.append((sql, params))

    def fetchall(self):
        return self.conn.fetch_result
