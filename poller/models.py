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


@dataclass
class Trip:
    offer: Offer
    request: SearchRequest
    pattern: Pattern
