"""Tests for poller.db.parse_settings (pure) and poller.config.load_config.

No live database is exercised here; parse_settings takes a raw dict shaped
like a `settings` row (see docs/decisions/data-source.md's Neon schema) and
returns a validated Settings plus any warnings.
"""
from datetime import date, datetime, time

import pytest

from poller.config import load_config
from poller.models import Pattern, Settings
from poller.db import get_last_alert_price, history_for_od, parse_settings, record_alert

# The two seed patterns from the canonical shapes doc — used to assert the
# empty-patterns fallback matches verbatim.
SEED_PATTERNS = [
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


def make_row(**overrides):
    """Builds a well-formed settings row, letting tests override specific fields."""
    row = {
        "origins": ["JFK", "LGA"],
        "destinations": ["YYZ", "YTZ"],
        "preferred_origin": "LGA",
        "preferred_destination": "YYZ",
        "patterns": [
            {
                "outbound_weekday": 3,
                "outbound_start": "17:00",
                "outbound_end": "23:59",
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
            {
                "outbound_weekday": 4,
                "outbound_start": None,
                "outbound_end": None,
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
        ],
        "window_days": 60,
        "threshold_usd": 250,
        "drop_pct": 20,
        "realert_step_pct": 5,
        "realert_step_dollars": 10,
        "min_history_days": 5,
        "alert_email": "someone@example.com",
        "dry_run": True,
        "updated_at": None,
    }
    row.update(overrides)
    return row


def test_settings_validation_well_formed_row():
    row = make_row()
    settings, warnings = parse_settings(row)

    assert isinstance(settings, Settings)
    assert settings.patterns == SEED_PATTERNS
    for pattern in settings.patterns:
        assert isinstance(pattern.outbound_weekday, int)
        assert isinstance(pattern.return_weekday, int)
        assert pattern.outbound_start is None or isinstance(pattern.outbound_start, time)
        assert pattern.outbound_end is None or isinstance(pattern.outbound_end, time)
        assert pattern.return_start is None or isinstance(pattern.return_start, time)
        assert pattern.return_end is None or isinstance(pattern.return_end, time)
    assert warnings == []


def test_settings_validation_drops_invalid_window_end_before_start():
    row = make_row(
        patterns=[
            {
                # bounded outbound window with end BEFORE start -> must be dropped
                "outbound_weekday": 3,
                "outbound_start": "18:00",
                "outbound_end": "17:00",
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
            {
                "outbound_weekday": 4,
                "outbound_start": None,
                "outbound_end": None,
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
        ]
    )

    settings, warnings = parse_settings(row)

    assert len(settings.patterns) == 1
    assert settings.patterns[0].outbound_weekday == 4
    assert warnings != []


def test_settings_validation_empty_patterns_falls_back_to_seed_patterns():
    row = make_row(patterns=[])

    settings, warnings = parse_settings(row)

    assert settings.patterns == SEED_PATTERNS
    assert warnings != []


def test_settings_validation_non_positive_threshold_falls_back_to_default():
    row = make_row(threshold_usd=-5)

    settings, warnings = parse_settings(row)

    assert settings.threshold_usd == 250
    assert warnings != []


def test_settings_validation_non_list_patterns_falls_back_to_seed_patterns():
    row = make_row(patterns="bad")

    settings, warnings = parse_settings(row)

    assert settings.patterns == SEED_PATTERNS
    assert warnings != []


def test_settings_validation_drops_pattern_missing_required_key():
    row = make_row(
        patterns=[
            {
                # missing "outbound_weekday" entirely -> must be dropped, not raise
                "outbound_start": "17:00",
                "outbound_end": "23:59",
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
            {
                "outbound_weekday": 4,
                "outbound_start": None,
                "outbound_end": None,
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
        ]
    )

    settings, warnings = parse_settings(row)

    assert len(settings.patterns) == 1
    assert settings.patterns[0].outbound_weekday == 4
    assert warnings != []


def test_settings_validation_drops_pattern_with_malformed_time():
    row = make_row(
        patterns=[
            {
                "outbound_weekday": 3,
                "outbound_start": "9pm",
                "outbound_end": "23:59",
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
            {
                "outbound_weekday": 4,
                "outbound_start": None,
                "outbound_end": None,
                "return_weekday": 6,
                "return_start": None,
                "return_end": None,
            },
        ]
    )

    settings, warnings = parse_settings(row)

    assert len(settings.patterns) == 1
    assert settings.patterns[0].outbound_weekday == 4
    assert warnings != []


def test_settings_validation_window_days_zero_is_preserved():
    row = make_row(window_days=0)

    settings, warnings = parse_settings(row)

    assert settings.window_days == 0


def test_settings_validation_min_history_days_zero_is_preserved():
    row = make_row(min_history_days=0)

    settings, warnings = parse_settings(row)

    assert settings.min_history_days == 0


def test_missing_env_named(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@host/db")
    monkeypatch.setenv("GMAIL_ADDRESS", "user@example.com")
    monkeypatch.delenv("GMAIL_APP_PASSWORD", raising=False)

    with pytest.raises(Exception) as exc_info:
        load_config()

    assert "GMAIL_APP_PASSWORD" in str(exc_info.value)


def test_app_password_whitespace_stripped(monkeypatch):
    # Google displays the 16-char app password in space-separated groups and
    # users paste it verbatim -- load_config must strip all spaces so SMTP
    # login doesn't silently fail against the space-containing string.
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pass@host/db")
    monkeypatch.setenv("GMAIL_ADDRESS", "user@example.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "abcd efgh ijkl mnop")

    config = load_config()

    assert config.gmail_app_password == "abcdefghijklmnop"


# ---------------------------------------------------------------------------
# Fake conn for the new run_poll-support helpers below. Mirrors
# tests/test_snapshots.py's _EventsOnlyConn/_ReadCursor style: records the
# single execute() call and returns a canned fetch result, so these thin
# helpers are testable without a live DB.
# ---------------------------------------------------------------------------
class _EventsOnlyConn:
    def __init__(self, events, fetch_result=None):
        self.events = events
        self.fetch_result = fetch_result

    def cursor(self):
        return _ReadCursor(self)

    def commit(self):
        self.events.append(("commit",))


class _ReadCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, sql, params=None):
        self.conn.events.append(("execute", sql, params))

    def fetchall(self):
        return self.conn.fetch_result or []

    def fetchone(self):
        return self.conn.fetch_result


def test_history_for_od_issues_expected_sql_and_params():
    events = []
    conn = _EventsOnlyConn(events, fetch_result=[
        (datetime(2026, 7, 10, 12, 0), 199),
        (datetime(2026, 7, 12, 12, 0), 205),
    ])

    rows = history_for_od(conn, "JFK", "YYZ", days=14)

    assert rows == [
        (datetime(2026, 7, 10, 12, 0), 199),
        (datetime(2026, 7, 12, 12, 0), 205),
    ]
    assert len(events) == 1
    _, sql, params = events[0]
    assert "price_snapshots" in sql
    # pattern-level baseline: origin+destination only, no date-pair filter,
    # unlike history_for_pair's exact-date query.
    assert "outbound_date" not in sql
    assert "return_date" not in sql
    assert params == ("JFK", "YYZ", 14)


def test_get_last_alert_price_returns_price_when_row_exists():
    events = []
    # dict_row-shaped, matching production's row_factory=dict_row (see
    # get_poller_state/fetch_settings fakes) -- not a tuple.
    conn = _EventsOnlyConn(events, fetch_result={"alerted_price_usd": 240})

    identity = ("JFK", "YYZ", date(2026, 8, 6), date(2026, 8, 9), "Delta", "nonstop")
    price = get_last_alert_price(conn, identity)

    assert price == 240
    assert len(events) == 1
    _, sql, params = events[0]
    assert "alerts_sent" in sql
    assert params == identity


def test_get_last_alert_price_returns_none_when_no_row():
    events = []
    conn = _EventsOnlyConn(events, fetch_result=None)

    identity = ("JFK", "YYZ", date(2026, 8, 6), date(2026, 8, 9), "Delta", "nonstop")
    price = get_last_alert_price(conn, identity)

    assert price is None


def test_record_alert_upserts_on_identity_and_commits():
    from poller.models import Offer, Pattern, SearchRequest, Trip
    from poller.rules import Decision

    events = []
    conn = _EventsOnlyConn(events)

    trip = Trip(
        offer=Offer(
            price_usd=218, airline="Delta", stops=0,
            outbound_dep=time(18, 0), outbound_arr=time(19, 0),
            return_dep=None, return_arr=None,
            booking_url="https://example.com/book",
        ),
        request=SearchRequest(
            origin="JFK", destination="YYZ",
            outbound_date=date(2026, 8, 6), return_date=date(2026, 8, 9),
        ),
        pattern=Pattern(
            outbound_weekday=3, outbound_start=None, outbound_end=None,
            return_weekday=6, return_start=None, return_end=None,
        ),
    )
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)
    sent_at = datetime(2026, 7, 14, 12, 0)

    record_alert(conn, trip, decision, sent_at)

    execute_events = [e for e in events if e[0] == "execute"]
    assert len(execute_events) == 1
    _, sql, params = execute_events[0]
    assert "alerts_sent" in sql
    assert "ON CONFLICT" in sql.upper()
    assert params == (
        "JFK", "YYZ", date(2026, 8, 6), date(2026, 8, 9), "Delta", "nonstop",
        218, "threshold", sent_at,
    )
    assert ("commit",) in events
