"""Pattern expansion and time-window matching for the poller.

Pure date/time logic: no DB, no network, no datetime.now() reads. `today`
is always an explicit parameter (America/New_York date) so results are
fully deterministic and testable.
"""
from datetime import date, time, timedelta

from poller.models import Offer, Pattern, SearchRequest, Settings


def expand_patterns(
    settings: Settings, today: date
) -> list[tuple[SearchRequest, Pattern]]:
    """Expands settings.patterns over the rolling window into concrete search requests.

    Window is the inclusive range [today, today + window_days]. For each
    pattern, every date in the window matching outbound_weekday becomes a
    candidate outbound; the paired return is the next occurrence of
    return_weekday (at least 1 day later, never same-day) that still falls
    inside the window. Emits ONE row per (pattern, date-pair) -- Phase 3
    collapses the old per-O-D-pair expansion into a single matrix candidate
    per date-pair, carrying settings.origins/settings.destinations as the
    full airport lists (one fli query covers the whole matrix; see
    docs/planning/rework-plan.md's Verdict C). Rows sharing the same
    (outbound_date, return_date) across different patterns are deduped,
    keeping the first pattern seen -- airports are no longer part of the
    candidate identity since every candidate now covers the same matrix.
    """
    window_end = today + timedelta(days=settings.window_days)
    seen: dict[tuple[date, date], None] = {}
    results: list[tuple[SearchRequest, Pattern]] = []

    for pattern in settings.patterns:
        # mod-7 gap to the next return weekday; a same-day match (mod 0)
        # means "7 days later", never a same-day return.
        gap = (pattern.return_weekday - pattern.outbound_weekday) % 7
        if gap == 0:
            gap = 7

        d = today
        while d <= window_end:
            if d.weekday() == pattern.outbound_weekday:
                return_date = d + timedelta(days=gap)
                if return_date <= window_end:
                    key = (d, return_date)
                    if key not in seen:
                        seen[key] = None
                        results.append(
                            (
                                SearchRequest(
                                    # representative pair for logging/the
                                    # fast-flights fallback; the matrix lists
                                    # below are what a matrix-aware source
                                    # actually queries.
                                    origin=settings.preferred_origin,
                                    destination=settings.preferred_destination,
                                    outbound_date=d,
                                    return_date=return_date,
                                    origins=settings.origins,
                                    destinations=settings.destinations,
                                ),
                                pattern,
                            )
                        )
            d += timedelta(days=1)

    return results


def _leg_matches(dep_time: time | None, start: time | None, end: time | None) -> bool:
    if start is None and end is None:
        return True  # unbounded window matches any departure time

    if dep_time is None:
        # best-effort: time data unavailable — real for round-trip RETURN
        # legs, which fast-flights 3.0.2 does not return; don't fail a
        # trip just because we lack data to check it against.
        return True

    lo = start or time.min
    hi = end or time.max
    return lo <= dep_time <= hi


def trip_matches_windows(offer: Offer, pattern: Pattern) -> bool:
    """True if both legs' departure times fall within the pattern's windows."""
    return _leg_matches(
        offer.outbound_dep, pattern.outbound_start, pattern.outbound_end
    ) and _leg_matches(offer.return_dep, pattern.return_start, pattern.return_end)
