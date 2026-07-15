"""Tests for poller.patterns: pattern expansion and time-window matching.

Pure date/time logic — every test passes `today` explicitly (never
datetime.now()) so results are fully deterministic.
"""
from datetime import date, time, timedelta

from poller.models import Offer, Pattern, SearchRequest, Settings
from poller.patterns import expand_patterns, trip_matches_windows

ORIGINS = ["JFK", "LGA"]
DESTINATIONS = ["YYZ", "YTZ"]

# Thu(3) >= 5pm -> Sun(6) any time — one of the two seed patterns.
THU_SUN_PATTERN = Pattern(
    outbound_weekday=3,
    outbound_start=time(17, 0),
    outbound_end=time(23, 59),
    return_weekday=6,
    return_start=None,
    return_end=None,
)

# Fri(4) any -> Sun(6) any — the other seed pattern.
FRI_SUN_PATTERN = Pattern(
    outbound_weekday=4,
    outbound_start=None,
    outbound_end=None,
    return_weekday=6,
    return_start=None,
    return_end=None,
)


def make_settings(patterns, window_days=60):
    return Settings(
        origins=ORIGINS,
        destinations=DESTINATIONS,
        preferred_origin="LGA",
        preferred_destination="YYZ",
        patterns=patterns,
        window_days=window_days,
        threshold_usd=250,
        drop_pct=20,
        realert_step_pct=5,
        realert_step_dollars=10,
        min_history_days=5,
        alert_email=None,
        dry_run=True,
        updated_at=None,
    )


def od_pairs():
    return [(o, d) for o in ORIGINS for d in DESTINATIONS]


def test_expand_patterns_thursdays_paired_with_sunday_three_days_later():
    # today is a Monday; window_days=60 means the last Thursday's Sunday
    # (2026-04-30 + 3d = 2026-05-03) falls outside the window (ends
    # 2026-05-01), so it must be excluded — this fixture also covers the
    # "last Thursday's Sunday is outside the window" exclusion case.
    today = date(2026, 3, 2)
    settings = make_settings([THU_SUN_PATTERN], window_days=60)

    expected_thursdays = [
        date(2026, 3, 5),
        date(2026, 3, 12),
        date(2026, 3, 19),
        date(2026, 3, 26),
        date(2026, 4, 2),
        date(2026, 4, 9),
        date(2026, 4, 16),
        date(2026, 4, 23),
    ]

    results = expand_patterns(settings, today)

    # Phase 3: one matrix candidate per date-pair (not one per O-D pair) --
    # every result carries the full origins/destinations lists rather than
    # being filtered by a single O-D pair.
    pairs = [(r.outbound_date, r.return_date) for r, _p in results]
    expected_pairs = [(d, d + timedelta(days=3)) for d in expected_thursdays]
    assert pairs == expected_pairs

    for r, _p in results:
        assert r.origins == ORIGINS
        assert r.destinations == DESTINATIONS
        assert r.origin == settings.preferred_origin
        assert r.destination == settings.preferred_destination

    # the excluded Thursday (2026-04-30) must not appear at all
    all_outbound_dates = {r.outbound_date for r, _p in results}
    assert date(2026, 4, 30) not in all_outbound_dates


def test_expand_patterns_today_on_thursday_includes_same_day_outbound():
    # today itself is a Thursday; the return (3 days later) is comfortably
    # within the window, so same-day outbound must be included — the
    # "after 5pm" feasibility check belongs to trip_matches_windows, not
    # expansion.
    today = date(2026, 3, 5)
    assert today.weekday() == 3
    settings = make_settings([THU_SUN_PATTERN], window_days=60)

    results = expand_patterns(settings, today)

    same_day = [
        (r.outbound_date, r.return_date)
        for r, _p in results
        if r.origin == "LGA" and r.destination == "YYZ" and r.outbound_date == today
    ]
    assert same_day == [(today, date(2026, 3, 8))]


def test_expand_patterns_month_boundary_and_dst_fallback_window():
    # window spans the Oct/Nov month boundary and the 2026-11-01 US DST
    # fall-back; expected dates are DST-agnostic (plain calendar dates) so
    # this only guards the month/day arithmetic, not any tz handling.
    today = date(2026, 10, 26)
    assert today.weekday() == 0
    settings = make_settings([THU_SUN_PATTERN], window_days=60)

    expected_thursdays = [
        date(2026, 10, 29),
        date(2026, 11, 5),
        date(2026, 11, 12),
        date(2026, 11, 19),
        date(2026, 11, 26),
        date(2026, 12, 3),
        date(2026, 12, 10),
        date(2026, 12, 17),
    ]

    results = expand_patterns(settings, today)

    pairs = [
        (r.outbound_date, r.return_date)
        for r, _p in results
        if r.origin == "LGA" and r.destination == "YYZ"
    ]
    expected_pairs = [(d, d + timedelta(days=3)) for d in expected_thursdays]
    assert pairs == expected_pairs
    # 2026-12-24 + 3d = 2026-12-27 is outside the 60-day window (ends 2026-12-25)
    assert date(2026, 12, 24) not in {r.outbound_date for r, _p in results}


def test_expand_patterns_two_patterns_union_no_duplicate_rows():
    # THU_SUN_PATTERN and FRI_SUN_PATTERN never collide (different outbound
    # weekdays), so the union must simply be the concatenation of both sets
    # with no (outbound, return) date-pair repeated.
    today = date(2026, 3, 2)
    settings = make_settings([THU_SUN_PATTERN, FRI_SUN_PATTERN], window_days=60)

    results = expand_patterns(settings, today)

    keys = [(r.outbound_date, r.return_date) for r, _p in results]
    assert len(keys) == len(set(keys))

    # sanity: both weekdays actually show up in the results
    outbound_weekdays = {r.outbound_date.weekday() for r, _p in results}
    assert outbound_weekdays == {3, 4}


def test_expand_patterns_dedupes_identical_pairs_from_different_patterns():
    # two patterns that happen to generate the same (outbound, return)
    # date-pair must collapse to a single entry, keeping the first pattern's
    # attribution -- Phase 3: dedup key is the date-pair alone, airports are
    # no longer part of candidate identity.
    today = date(2026, 3, 2)
    duplicate_pattern = Pattern(
        outbound_weekday=3,
        outbound_start=None,
        outbound_end=None,
        return_weekday=6,
        return_start=None,
        return_end=None,
    )
    settings = make_settings([THU_SUN_PATTERN, duplicate_pattern], window_days=60)

    results = expand_patterns(settings, today)

    keys = [(r.outbound_date, r.return_date) for r, _p in results]
    assert len(keys) == len(set(keys))

    # the first pattern (THU_SUN_PATTERN) must be the one attributed to the
    # dedupe-surviving row
    for r, p in results:
        if r.outbound_date == date(2026, 3, 5):
            assert p is THU_SUN_PATTERN


def test_expand_patterns_one_date_pair_yields_one_matrix_candidate_not_four():
    # Phase 3: a single date-pair must expand to exactly ONE candidate
    # carrying both airport lists -- not one per O-D pair (the old 2x2 = 4
    # rows per date-pair behavior).
    today = date(2026, 3, 5)  # a Thursday
    settings = make_settings([THU_SUN_PATTERN], window_days=3)

    results = expand_patterns(settings, today)

    assert len(results) == 1
    request, pattern = results[0]
    assert request.outbound_date == today
    assert request.return_date == date(2026, 3, 8)
    assert request.origins == ORIGINS
    assert request.destinations == DESTINATIONS
    # representative pair used for logging/the fast-flights fallback
    assert request.origin == settings.preferred_origin
    assert request.destination == settings.preferred_destination
    assert pattern is THU_SUN_PATTERN


def test_expand_patterns_same_weekday_return_is_seven_days_later_never_same_day():
    # outbound_weekday == return_weekday (mod-7 gap of 0) must be corrected
    # to 7 days later, never a same-day return.
    today = date(2026, 3, 2)
    thu_thu_pattern = Pattern(
        outbound_weekday=3,
        outbound_start=None,
        outbound_end=None,
        return_weekday=3,
        return_start=None,
        return_end=None,
    )
    settings = make_settings([thu_thu_pattern], window_days=60)

    expected_thursdays = [
        date(2026, 3, 5),
        date(2026, 3, 12),
        date(2026, 3, 19),
        date(2026, 3, 26),
        date(2026, 4, 2),
        date(2026, 4, 9),
        date(2026, 4, 16),
        date(2026, 4, 23),
    ]

    results = expand_patterns(settings, today)

    pairs = [
        (r.outbound_date, r.return_date)
        for r, _p in results
        if r.origin == "LGA" and r.destination == "YYZ"
    ]
    expected_pairs = [(d, d + timedelta(days=7)) for d in expected_thursdays]
    assert pairs == expected_pairs

    assert all(outbound != ret for outbound, ret in pairs)


def make_offer(**overrides):
    offer = dict(
        price_usd=200,
        airline="AC",
        stops=0,
        outbound_dep=time(17, 30),
        outbound_arr=time(19, 0),
        return_dep=None,
        return_arr=None,
        booking_url="https://example.com",
    )
    offer.update(overrides)
    return Offer(**offer)


def test_trip_matches_windows_outbound_within_bounded_window():
    pattern = Pattern(
        outbound_weekday=3,
        outbound_start=time(17, 0),
        outbound_end=time(23, 59),
        return_weekday=6,
        return_start=None,
        return_end=None,
    )
    offer = make_offer(outbound_dep=time(17, 30))

    assert trip_matches_windows(offer, pattern) is True


def test_trip_matches_windows_outbound_just_before_bounded_window():
    pattern = Pattern(
        outbound_weekday=3,
        outbound_start=time(17, 0),
        outbound_end=time(23, 59),
        return_weekday=6,
        return_start=None,
        return_end=None,
    )
    offer = make_offer(outbound_dep=time(16, 59))

    assert trip_matches_windows(offer, pattern) is False


def test_trip_matches_windows_any_outbound_vs_unbounded_window():
    pattern = Pattern(
        outbound_weekday=4,
        outbound_start=None,
        outbound_end=None,
        return_weekday=6,
        return_start=None,
        return_end=None,
    )
    offer = make_offer(outbound_dep=time(3, 0))

    assert trip_matches_windows(offer, pattern) is True


def test_trip_matches_windows_return_dep_outside_bounded_window_fails():
    # outbound passes, but an explicitly-set return_dep outside a bounded
    # return window must fail the whole trip.
    pattern = Pattern(
        outbound_weekday=3,
        outbound_start=time(17, 0),
        outbound_end=time(23, 59),
        return_weekday=6,
        return_start=time(6, 0),
        return_end=time(12, 0),
    )
    offer = make_offer(outbound_dep=time(17, 30), return_dep=time(18, 0))

    assert trip_matches_windows(offer, pattern) is False


def test_trip_matches_windows_return_dep_none_is_best_effort_match():
    # round-trip RETURN-leg times are frequently None (fast-flights 3.0.2
    # limitation) — treat unknown as a match rather than failing every trip.
    pattern = Pattern(
        outbound_weekday=3,
        outbound_start=time(17, 0),
        outbound_end=time(23, 59),
        return_weekday=6,
        return_start=time(6, 0),
        return_end=time(12, 0),
    )
    offer = make_offer(outbound_dep=time(17, 30), return_dep=None)

    assert trip_matches_windows(offer, pattern) is True
