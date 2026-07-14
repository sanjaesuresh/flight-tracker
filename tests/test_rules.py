"""Tests for poller.rules — alert threshold/drop/dedup logic (pure, no DB, no clock).

pair_history and pattern_history are passed in already trimmed to the trailing
14 days by the caller; these tests just hand in small fixed lists.
"""
from datetime import date, time

from poller.models import Offer, Pattern, SearchRequest, Settings, Trip
from poller.rules import Decision, best_per_identity, deal_identity, evaluate

PATTERN = Pattern(
    outbound_weekday=3,
    outbound_start=time(17, 0),
    outbound_end=time(23, 59),
    return_weekday=6,
    return_start=None,
    return_end=None,
)


def make_settings(**overrides):
    """Builds well-formed Settings, letting tests override specific fields."""
    fields = {
        "origins": ["JFK", "LGA"],
        "destinations": ["YYZ", "YTZ"],
        "preferred_origin": "LGA",
        "preferred_destination": "YYZ",
        "patterns": [PATTERN],
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
    fields.update(overrides)
    return Settings(**fields)


def make_trip(price_usd=240, stops=0, airline="AC", origin="LGA", destination="YYZ",
              outbound_date=date(2026, 7, 16), return_date=date(2026, 7, 19)):
    """Builds a Trip with sane defaults, letting tests override specific fields."""
    offer = Offer(
        price_usd=price_usd,
        airline=airline,
        stops=stops,
        outbound_dep=time(17, 30),
        outbound_arr=time(19, 0),
        return_dep=None,
        return_arr=None,
        booking_url="https://example.com/book",
    )
    request = SearchRequest(
        origin=origin,
        destination=destination,
        outbound_date=outbound_date,
        return_date=return_date,
    )
    return Trip(offer=offer, request=request, pattern=PATTERN)


def test_deal_identity_stops_bucketing():
    # 0 stops -> "nonstop"; any other stop count -> "connecting" (shared bucket)
    nonstop = deal_identity(make_trip(stops=0))
    one_stop = deal_identity(make_trip(stops=1))
    two_stop = deal_identity(make_trip(stops=2))

    assert nonstop[-1] == "nonstop"
    assert one_stop[-1] == "connecting"
    assert two_stop[-1] == "connecting"


def test_deal_identity_full_tuple_shape():
    trip = make_trip()
    identity = deal_identity(trip)

    assert identity == ("LGA", "YYZ", date(2026, 7, 16), date(2026, 7, 19), "AC", "nonstop")


def test_best_per_identity_keeps_cheaper_trip():
    expensive = make_trip(price_usd=250)
    cheap = make_trip(price_usd=230)

    result = best_per_identity([expensive, cheap])

    assert len(result) == 1
    assert result[0].offer.price_usd == 230


def test_best_per_identity_ties_keep_first_seen():
    first = make_trip(price_usd=230)
    second = make_trip(price_usd=230)

    result = best_per_identity([first, second])

    assert len(result) == 1
    assert result[0] is first


def test_best_per_identity_keeps_distinct_identities():
    a = make_trip(price_usd=230, destination="YYZ")
    b = make_trip(price_usd=230, destination="YTZ")

    result = best_per_identity([a, b])

    assert len(result) == 2


def test_threshold_fires_strictly_below():
    settings = make_settings(threshold_usd=250)
    trip = make_trip(price_usd=249)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=None)

    assert decision.fires is True
    assert "threshold" in decision.reasons


def test_threshold_does_not_fire_at_boundary():
    settings = make_settings(threshold_usd=250)
    trip = make_trip(price_usd=250)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=None)

    assert decision.fires is False
    assert decision.reasons == set()


def _daily_low_history(prices_by_day):
    """Builds a (date, price) history list from {date: [prices seen that day]}."""
    history = []
    for day, prices in prices_by_day.items():
        for price in prices:
            history.append((day, price))
    return history


def test_drop_fires_at_boundary_with_sufficient_history():
    # 5 distinct days, daily lows all 300 -> median baseline 300; drop_pct 20 -> 240 fires (<=)
    history = _daily_low_history({
        date(2026, 7, 1): [300, 320],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300, 310],
        date(2026, 7, 4): [300],
        date(2026, 7, 5): [300],
    })
    settings = make_settings(threshold_usd=1, drop_pct=20, min_history_days=5)
    trip = make_trip(price_usd=240)

    decision = evaluate(trip, settings, pair_history=history, pattern_history=[], last_alert_price=None)

    assert decision.fires is True
    assert "drop" in decision.reasons
    assert decision.baseline == 300


def test_drop_does_not_fire_just_above_boundary():
    history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
        date(2026, 7, 4): [300],
        date(2026, 7, 5): [300],
    })
    settings = make_settings(threshold_usd=1, drop_pct=20, min_history_days=5)
    trip = make_trip(price_usd=241)

    decision = evaluate(trip, settings, pair_history=history, pattern_history=[], last_alert_price=None)

    assert decision.fires is False
    assert "drop" not in decision.reasons


def test_thin_pair_history_falls_back_to_pattern_history():
    # pair spans only 3 distinct days (< min_history_days 5) -> use pattern_history instead
    thin_pair_history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
    })
    pattern_history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
        date(2026, 7, 4): [300],
        date(2026, 7, 5): [300],
    })
    settings = make_settings(threshold_usd=1, drop_pct=20, min_history_days=5)
    trip = make_trip(price_usd=240)

    decision = evaluate(
        trip, settings, pair_history=thin_pair_history, pattern_history=pattern_history, last_alert_price=None
    )

    assert decision.fires is True
    assert "drop" in decision.reasons
    assert decision.baseline == 300


def test_both_histories_thin_only_threshold_can_fire():
    thin_pair_history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
    })
    thin_pattern_history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
    })
    settings = make_settings(threshold_usd=1, drop_pct=20, min_history_days=5)
    # price is very low, but with no usable baseline, drop must stay silent
    trip = make_trip(price_usd=50)

    decision = evaluate(
        trip, settings, pair_history=thin_pair_history, pattern_history=thin_pattern_history, last_alert_price=None
    )

    assert decision.fires is False
    assert decision.reasons == set()
    assert decision.baseline is None


def test_both_threshold_and_drop_fire_together():
    history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
        date(2026, 7, 4): [300],
        date(2026, 7, 5): [300],
    })
    settings = make_settings(threshold_usd=250, drop_pct=20, min_history_days=5)
    trip = make_trip(price_usd=240)

    decision = evaluate(trip, settings, pair_history=history, pattern_history=[], last_alert_price=None)

    assert decision.fires is True
    assert decision.reasons == {"threshold", "drop"}


def test_dedup_step_blocks_small_price_drop():
    # last_alert_price 240, step = max(5% of 240 = 12, $10) = 12 -> re-alert floor is 228
    settings = make_settings(threshold_usd=1000, realert_step_pct=5, realert_step_dollars=10)
    trip = make_trip(price_usd=229)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=240)

    assert decision.fires is False
    assert decision.reasons == set()


def test_dedup_step_allows_sufficient_price_drop():
    settings = make_settings(threshold_usd=1000, realert_step_pct=5, realert_step_dollars=10)
    trip = make_trip(price_usd=228)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=240)

    assert decision.fires is True
    assert "threshold" in decision.reasons


def test_dedup_silences_oscillation_back_to_same_price():
    # alerted once at 235; price rose to 300, then fell back to 235 -> must stay silent
    settings = make_settings(threshold_usd=1000, realert_step_pct=5, realert_step_dollars=10)
    trip = make_trip(price_usd=235)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=235)

    assert decision.fires is False
    assert decision.reasons == set()


def test_dedup_does_not_apply_when_no_prior_alert():
    settings = make_settings(threshold_usd=250)
    trip = make_trip(price_usd=249)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=None)

    assert decision.fires is True


def test_dedup_vetoes_drop_only_decision():
    # baseline 300 makes drop_target 240, price 240 fires "drop"; threshold is
    # set unreachable so drop is the only reason -> dedup step must still veto it.
    history = _daily_low_history({
        date(2026, 7, 1): [300],
        date(2026, 7, 2): [300],
        date(2026, 7, 3): [300],
        date(2026, 7, 4): [300],
        date(2026, 7, 5): [300],
    })
    settings = make_settings(threshold_usd=1, drop_pct=20, min_history_days=5)
    trip = make_trip(price_usd=240)

    decision = evaluate(trip, settings, pair_history=history, pattern_history=[], last_alert_price=240)

    assert decision.fires is False
    assert decision.reasons == set()

    # companion: same input without a prior alert price -> nothing to veto,
    # so "drop" fires, proving the dedup gate above is what silenced it.
    decision_without_veto = evaluate(trip, settings, pair_history=history, pattern_history=[], last_alert_price=None)

    assert decision_without_veto.fires is True
    assert decision_without_veto.reasons == {"drop"}


def test_min_history_days_zero_with_empty_history_returns_no_baseline():
    # min_history_days <= 0 must short-circuit before statistics.median([]) -> no crash;
    # threshold is set unreachable so only the baseline/no-crash behavior is under test.
    settings = make_settings(threshold_usd=1, min_history_days=0)
    trip = make_trip(price_usd=100)

    decision = evaluate(trip, settings, pair_history=[], pattern_history=[], last_alert_price=None)

    assert decision.baseline is None
    assert decision.fires is False


def test_decision_is_a_dataclass_with_expected_fields():
    decision = Decision(fires=False, reasons=set(), baseline=None)

    assert decision.fires is False
    assert decision.reasons == set()
    assert decision.baseline is None
