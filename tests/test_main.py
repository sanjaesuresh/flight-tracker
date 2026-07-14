"""Integration tests for poller.main.run_poll — orchestrates every already-
tested module for one poll cycle and enforces the CI exit-code contract.

A FAKE conn (SQL-dispatching, in-memory tables) stands in for Neon so a full
cycle -- settings read, poller_state read/write, snapshot writes, alert
history reads, alerts_sent upserts -- is exercised without touching a real
database, mirroring tests/test_snapshots.py's fake-conn style. A FAKE source
stubs confirm_candidates with canned (request, offers) pairs and can be told
to "fail" specific requests (returns them with an empty offers list, exactly
like the real GoogleFlightsSource does when search() raises internally). A
stub transport records send_smtp-shaped calls instead of touching SMTP.
"""
import logging
from datetime import date, datetime, time, timezone

import pytest

from poller.config import Config
from poller.models import Offer, Pattern, SearchRequest, Settings
from poller.main import log_settings_warnings, run_poll

UTC = timezone.utc

PATTERN_ROW = {
    "outbound_weekday": 3,
    "outbound_start": "17:00",
    "outbound_end": "23:59",
    "return_weekday": 6,
    "return_start": None,
    "return_end": None,
}


def make_settings_row(**overrides):
    row = {
        "origins": ["JFK"],
        "destinations": ["YYZ"],
        "preferred_origin": "JFK",
        "preferred_destination": "YYZ",
        "patterns": [PATTERN_ROW],
        "window_days": 14,
        "threshold_usd": 250,
        "drop_pct": 20,
        "realert_step_pct": 5,
        "realert_step_dollars": 10,
        "min_history_days": 0,  # 0 disables the baseline-drop path so only threshold matters in these tests
        "alert_email": "secret-recipient@example.com",
        "dry_run": False,
        "updated_at": None,
    }
    row.update(overrides)
    return row


def make_config():
    return Config(
        database_url="postgresql://example",
        gmail_address="sender@gmail.com",
        gmail_app_password="app-password",
    )


def make_offer(price_usd, airline="Delta", stops=0, outbound_dep=time(18, 0)):
    return Offer(
        price_usd=price_usd,
        airline=airline,
        stops=stops,
        outbound_dep=outbound_dep,
        outbound_arr=time(20, 0),
        return_dep=None,
        return_arr=None,
        booking_url="https://example.com/book",
    )


class FakeSource:
    """Stub DataSource.confirm_candidates: returns canned (request, offers)
    pairs for whichever candidates it's given, in the same order, honoring a
    `fail_indices` set of positions that get an empty-offers result AND count
    toward the returned failed_count (which is exactly how the real
    GoogleFlightsSource represents a per-candidate exception -- it never
    omits an entry, it just yields no offers for it and increments
    failed_count).
    """

    def __init__(self, offers_by_index, next_cursor=1, fail_indices=None):
        self.offers_by_index = offers_by_index
        self.next_cursor = next_cursor
        self.fail_indices = fail_indices or set()
        self.calls = []

    def confirm_candidates(self, candidates, cursor):
        self.calls.append((list(candidates), cursor))
        results = []
        for i, request in enumerate(candidates):
            if i in self.fail_indices:
                results.append((request, []))
            else:
                results.append((request, self.offers_by_index.get(i, [])))
        return results, self.next_cursor, len(self.fail_indices)


class StubTransport:
    def __init__(self, raise_error=False):
        self.calls = []
        self.raise_error = raise_error

    def __call__(self, from_addr, to_addr, subject, body):
        self.calls.append((from_addr, to_addr, subject, body))
        if self.raise_error:
            raise RuntimeError("simulated SMTP failure")


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.conn.events.append(("execute", sql, params))
        upper = sql.upper()

        if "SELECT * FROM SETTINGS" in upper:
            self._result = self.conn.settings_row
        elif "SELECT * FROM POLLER_STATE" in upper:
            self._result = dict(self.conn.poller_state)
        elif "INSERT INTO PRICE_SNAPSHOTS" in upper:
            self.conn.snapshots.append(params)
            self._result = None
        elif "FROM PRICE_SNAPSHOTS" in upper and "SCRAPED_AT, PRICE_USD" in upper:
            # both history_for_pair (exact date pair) and history_for_od
            # (O-D only) select the same two columns; distinguish by whether
            # the query filters on outbound_date/return_date.
            if "OUTBOUND_DATE" in upper:
                origin, destination, outbound_date, return_date, _days = params
                self._result = [
                    row for row in self.conn.history
                    if row[:4] == (origin, destination, outbound_date, return_date)
                ]
            else:
                origin, destination, _days = params
                self._result = [
                    row for row in self.conn.history
                    if row[0] == origin and row[1] == destination
                ]
        elif "FROM ALERTS_SENT" in upper and "SELECT" in upper:
            identity = params
            price = self.conn.alerts_sent.get(tuple(identity))
            # dict_row-shaped, matching production's row_factory=dict_row --
            # get_last_alert_price reads row["alerted_price_usd"].
            self._result = {"alerted_price_usd": price} if price is not None else None
        elif "INSERT INTO ALERTS_SENT" in upper:
            identity = tuple(params[:6])
            self.conn.alerts_sent[identity] = params[6]  # alerted_price_usd
            self.conn.alerts_sent_rows.append(params)
            self._result = None
        elif "UPDATE POLLER_STATE" in upper:
            self.conn._apply_poller_state_update(sql, params)
            self._result = None
        else:
            raise AssertionError(f"FakeConn: unrecognized SQL: {sql}")

    def fetchone(self):
        return self._result

    def fetchall(self):
        return self._result or []


class FakeConn:
    """SQL-dispatching fake connection covering every table run_poll touches:
    settings (read-only fixture), poller_state (read/write), price_snapshots
    (write + the two history reads), alerts_sent (read latest + upsert).
    """

    def __init__(self, settings_row, poller_state, history=None):
        self.settings_row = settings_row
        self.poller_state = dict(poller_state)
        # history rows shaped (origin, destination, outbound_date, return_date, scraped_at, price_usd)
        self.history = history or []
        self.snapshots = []
        self.alerts_sent: dict[tuple, int] = {}
        self.alerts_sent_rows = []
        self.events = []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.events.append(("commit",))

    def _apply_poller_state_update(self, sql, params):
        # set_poller_state builds "col = %s" fragments in a fixed order
        # (last_success, consecutive_failures, cursor) -- mirror that order
        # to map params back onto column names.
        cols = []
        if "last_success = %s" in sql:
            cols.append("last_success")
        if "consecutive_failures = %s" in sql:
            cols.append("consecutive_failures")
        if "cursor = %s" in sql:
            cols.append("cursor")
        for col, value in zip(cols, params):
            self.poller_state[col] = value


NOW = datetime(2026, 7, 16, 12, 0, tzinfo=UTC)  # a Thursday in UTC


def test_full_cycle_below_threshold_sends_one_alert_and_records_it(caplog):
    """One matching, below-threshold offer -> snapshot written, exactly one
    alert sent via the stub transport, one alerts_sent row recorded, and the
    run reports success (exit 0).
    """
    settings_row = make_settings_row()
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 0, "cursor": 0})
    source = FakeSource(offers_by_index={0: [make_offer(200)]}, next_cursor=5)
    settings, _ = _fetch(conn)
    transport = StubTransport()

    code = run_poll(conn, source, settings, make_config(), NOW, transport=transport)

    assert code == 0
    assert len(conn.snapshots) == 1
    assert len(transport.calls) == 1
    assert len(conn.alerts_sent_rows) == 1
    assert conn.poller_state["consecutive_failures"] == 0
    assert conn.poller_state["cursor"] == 5
    assert conn.poller_state["last_success"] == NOW


def test_idempotent_rerun_with_unchanged_price_sends_no_second_alert():
    """Re-running the same cycle with the prior alert already recorded at the
    same price must not re-send -- rules.evaluate's re-alert dedup vetoes it.
    """
    settings_row = make_settings_row()
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 0, "cursor": 0})
    settings, _ = _fetch(conn)

    source1 = FakeSource(offers_by_index={0: [make_offer(200)]}, next_cursor=1)
    transport1 = StubTransport()
    code1 = run_poll(conn, source1, settings, make_config(), NOW, transport=transport1)
    assert code1 == 0
    assert len(transport1.calls) == 1

    # second run, unchanged price, cursor rotated back to 0 by the source stub
    source2 = FakeSource(offers_by_index={0: [make_offer(200)]}, next_cursor=1)
    transport2 = StubTransport()
    code2 = run_poll(conn, source2, settings, make_config(), NOW, transport=transport2)

    assert code2 == 0
    assert len(transport2.calls) == 0  # deduped -- no second send


def test_partial_success_three_of_four_requests_succeed():
    """1 of N requests fails (raises, empty offers, failed_count=1); the
    others still get snapshots written, and the run counts as (partial)
    success: returns 0, resets cf.
    """
    settings_row = make_settings_row(
        origins=["JFK"], destinations=["YYZ"],
        patterns=[PATTERN_ROW, {**PATTERN_ROW, "outbound_weekday": 4}],
        window_days=21,
    )
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 2, "cursor": 0})
    settings, _ = _fetch(conn)

    # give every candidate a nonstop offer so at least 3 snapshot-worthy
    # results land regardless of exact expand_patterns output; fail index 1.
    offers_by_index = {i: [make_offer(300 + i)] for i in range(10)}
    source = FakeSource(offers_by_index=offers_by_index, next_cursor=4, fail_indices={1})

    code = run_poll(conn, source, settings, make_config(), NOW, transport=StubTransport())

    assert code == 0
    assert conn.poller_state["consecutive_failures"] == 0
    assert conn.poller_state["cursor"] == 4
    assert conn.poller_state["last_success"] == NOW
    # at least one request's offers were written to snapshots (excluding the failed one)
    assert len(conn.snapshots) >= 1
    # a succeeding request's outbound_date shows up in a written row, and the
    # failed request's does not (it had zero offers, so nothing to insert).
    failed_request = source.calls[0][0][1]
    succeeding_request = source.calls[0][0][0]
    written_outbound_dates = {row[3] for row in conn.snapshots}
    assert succeeding_request.outbound_date in written_outbound_dates
    assert failed_request.outbound_date not in written_outbound_dates


def test_healthy_poll_with_zero_offers_everywhere_is_success_not_total_failure():
    """A healthy source (raises for NOTHING) that legitimately finds zero
    offers for every candidate this cycle -- e.g. nothing matched right now --
    must NOT be treated as a total failure. Only failed_count == attempted
    (every search actually raised) signals total failure; zero offers with
    zero raises is a normal successful poll: last_success updates, cf resets.
    """
    settings_row = make_settings_row()
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 2, "cursor": 0})
    settings, _ = _fetch(conn)

    # offers_by_index empty and fail_indices empty -> every candidate comes
    # back with offers=[] but failed_count is 0 (nothing raised).
    source = FakeSource(offers_by_index={}, next_cursor=2, fail_indices=set())

    code = run_poll(conn, source, settings, make_config(), NOW, transport=StubTransport())

    assert code == 0
    assert conn.poller_state["consecutive_failures"] == 0
    assert conn.poller_state["cursor"] == 2
    assert conn.poller_state["last_success"] == NOW
    assert conn.snapshots == []  # zero offers -> nothing to write, but that's fine


def test_total_failure_all_requests_fail_returns_1_and_increments_cf():
    """make_settings_row's default settings expand to 2 candidates for NOW --
    failing BOTH (failed_count == attempted) is what signals total failure
    now, not merely returning empty offers.
    """
    settings_row = make_settings_row()
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 0, "cursor": 0})
    settings, _ = _fetch(conn)

    source = FakeSource(offers_by_index={}, next_cursor=2, fail_indices={0, 1})

    code = run_poll(conn, source, settings, make_config(), NOW, transport=StubTransport())

    assert code == 1
    assert conn.poller_state["consecutive_failures"] == 1
    assert conn.poller_state["cursor"] == 2
    assert conn.poller_state["last_success"] is None  # must NOT be updated on total failure
    assert conn.snapshots == []


def test_third_consecutive_total_failure_returns_2():
    settings_row = make_settings_row()
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 2, "cursor": 0})
    settings, _ = _fetch(conn)

    source = FakeSource(offers_by_index={}, next_cursor=3, fail_indices={0, 1})

    code = run_poll(conn, source, settings, make_config(), NOW, transport=StubTransport())

    assert code == 2
    assert conn.poller_state["consecutive_failures"] == 3


def test_privacy_alert_email_never_logged_but_warnings_are(caplog):
    """A malformed pattern produces a parse_settings warning that must reach
    the logs (via the same log_settings_warnings helper main() calls after
    fetch_settings), but settings.alert_email must never appear anywhere in
    the logs produced by either that call or a full run_poll cycle.
    """
    settings_row = make_settings_row(
        alert_email="do-not-leak@example.com",
        patterns=[{**PATTERN_ROW, "outbound_weekday": "not-an-int"}],  # malformed -> warning + seed fallback
    )
    conn = FakeConn(settings_row, {"last_success": None, "consecutive_failures": 0, "cursor": 0})

    with caplog.at_level(logging.INFO):
        settings, warnings = _fetch(conn)
        assert warnings  # sanity: this row really does produce a warning
        log_settings_warnings(warnings)
        source = FakeSource(offers_by_index={0: [make_offer(200)]}, next_cursor=1)
        run_poll(conn, source, settings, make_config(), NOW, transport=StubTransport())

    log_text = "\n".join(record.getMessage() for record in caplog.records)
    assert "do-not-leak@example.com" not in log_text
    assert "not-an-int" in log_text or "Dropping malformed pattern" in log_text


def _fetch(conn):
    from poller.db import parse_settings
    return parse_settings(conn.settings_row)
