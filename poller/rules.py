"""Alert rules: threshold, per-pair/pattern drop baseline, and re-alert dedup.

Pure functions — no DB, no clock. Price history is passed in as lists of
(day_or_datetime, price) tuples, already limited to the trailing 14 days by
the caller (poller/db.py reads the window; this module just consumes it).
"""
import statistics
from dataclasses import dataclass

from poller.models import Settings, Trip


@dataclass
class Decision:
    fires: bool
    reasons: set[str]
    baseline: float | None


def deal_identity(trip: Trip) -> tuple:
    """Identity a re-alert/dedup check groups on.

    stops_bucket collapses 1-stop and 2-stop into "connecting" so a single
    poll only ever alerts the cheaper of two connecting itineraries for the
    same route/dates/airline, matching alerts_sent's unique key.
    """
    stops_bucket = "nonstop" if trip.offer.stops == 0 else "connecting"
    return (
        trip.request.origin,
        trip.request.destination,
        trip.request.outbound_date,
        trip.request.return_date,
        trip.offer.airline,
        stops_bucket,
    )


def best_per_identity(trips: list[Trip]) -> list[Trip]:
    """Keeps only the cheapest Trip per deal_identity.

    Ties keep the first seen (stable dict-insertion order), so one poll never
    alerts twice for what alerts_sent treats as the same identity.
    """
    best: dict[tuple, Trip] = {}
    for trip in trips:
        identity = deal_identity(trip)
        current = best.get(identity)
        if current is None or trip.offer.price_usd < current.offer.price_usd:
            best[identity] = trip
    return list(best.values())


def _daily_low_median(history: list[tuple], min_history_days: int) -> float | None:
    """Median of the daily-low price, or None if history is too thin.

    Group by calendar date (tuple[0] may be a date or a datetime — normalize
    via .date() when present) and take the min price per date; only trust the
    result once it spans >= min_history_days DISTINCT calendar days, otherwise
    a couple of noisy snapshots could masquerade as a stable baseline.
    """
    daily_lows: dict = {}
    for day_or_datetime, price in history:
        day = day_or_datetime.date() if hasattr(day_or_datetime, "date") else day_or_datetime
        if day not in daily_lows or price < daily_lows[day]:
            daily_lows[day] = price

    # non-positive min_history_days means no baseline is trustworthy (and
    # would otherwise let an empty daily_lows reach statistics.median([]),
    # which raises StatisticsError) -> treat as baseline-unavailable, not a crash.
    if min_history_days <= 0 or len(daily_lows) < min_history_days:
        return None

    return statistics.median(daily_lows.values())


def evaluate(
    trip: Trip,
    settings: Settings,
    pair_history: list[tuple],
    pattern_history: list[tuple],
    last_alert_price: float | None,
) -> Decision:
    """Decides whether `trip` should trigger an alert.

    Order of operations matters: threshold/drop are evaluated independently
    and unioned into `reasons`, then the re-alert dedup gate is applied last
    and can veto both — a trip that re-crosses the threshold without dropping
    far enough past the last alerted price must stay silent.
    """
    price = trip.offer.price_usd
    reasons: set[str] = set()

    # strict < : landing exactly on the threshold is "at" the target price,
    # not "below" it, so it should not spam an alert.
    if price < settings.threshold_usd:
        reasons.add("threshold")

    # prefer the pair-specific baseline; only fall back to the broader pattern
    # baseline if the pair itself doesn't have enough distinct days yet.
    baseline = _daily_low_median(pair_history, settings.min_history_days)
    if baseline is None:
        baseline = _daily_low_median(pattern_history, settings.min_history_days)

    if baseline is not None:
        # <= : hitting the drop target exactly should fire, unlike threshold's
        # strict boundary — this is a discount off a computed baseline, not a
        # user-set target, so landing on it is still a legitimate deal.
        drop_target = baseline * (1 - settings.drop_pct / 100)
        if price <= drop_target:
            reasons.add("drop")

    if last_alert_price is not None:
        # re-alert only once the price has moved meaningfully past the last
        # alerted price, so a price flapping by a few dollars around the
        # threshold (or returning to a previously-alerted price) doesn't spam.
        step = max(settings.realert_step_pct / 100 * last_alert_price, settings.realert_step_dollars)
        if price > last_alert_price - step:
            reasons = set()

    return Decision(fires=bool(reasons), reasons=reasons, baseline=baseline)
