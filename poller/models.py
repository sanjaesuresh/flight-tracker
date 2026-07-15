"""Shared dataclasses used by every later poller module.

Field names/types match the canonical shapes doc verbatim. Times are naive
datetime.time (America/New_York wall-clock, no tz conversion needed here);
dates are datetime.date.
"""
from dataclasses import dataclass
from datetime import date, datetime, time


@dataclass
class Pattern:
    outbound_weekday: int
    outbound_start: time | None
    outbound_end: time | None
    return_weekday: int
    return_start: time | None
    return_end: time | None


@dataclass
class Settings:
    origins: list[str]
    destinations: list[str]
    preferred_origin: str
    preferred_destination: str
    patterns: list[Pattern]
    window_days: int
    threshold_usd: int
    drop_pct: float
    realert_step_pct: float
    realert_step_dollars: float
    min_history_days: int
    alert_email: str | None
    dry_run: bool
    updated_at: datetime | None


@dataclass
class SearchRequest:
    origin: str
    destination: str
    outbound_date: date
    return_date: date
    # Phase 3: optional airport-list fields for one matrix query across all
    # origins x all destinations. origin/destination stay the REPRESENTATIVE
    # pair (logging + the fast-flights fallback's single-pair shape); origins/
    # destinations (when set) are the full lists a matrix-aware source uses to
    # build ONE query instead of one query per O-D pair. None means "legacy
    # single-pair request" -- callers fall back to [origin]/[destination].
    origins: list[str] | None = None
    destinations: list[str] | None = None


@dataclass
class Offer:
    price_usd: int
    airline: str
    stops: int
    outbound_dep: time | None
    outbound_arr: time | None
    return_dep: time | None
    return_arr: time | None
    booking_url: str
    # Phase 3: the ACTUAL leg airports for this specific offer, distinct from
    # the request's representative/matrix airports -- a matrix query can
    # return offers on any origin x destination combination, so each offer
    # must carry its own true airports for downstream storage/alert identity.
    # None means "unknown/not yet set" (defaults to the request's
    # origin/destination by callers, e.g. snapshots.py).
    origin: str | None = None
    destination: str | None = None
    # Phase 4: per-itinerary identity + per-direction detail for the
    # per-option history/detail page. All optional/default-None so the
    # fast-flights normalizer (no return-leg data) can leave them unset --
    # only the fli normalizer populates them.
    itinerary_key: str | None = None
    outbound_airline: str | None = None
    return_airline: str | None = None
    outbound_flight_numbers: str | None = None
    return_flight_numbers: str | None = None
    outbound_stops: int | None = None
    return_stops: int | None = None


@dataclass
class Trip:
    offer: Offer
    request: SearchRequest
    pattern: Pattern
