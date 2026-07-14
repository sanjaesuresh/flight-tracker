"""Pure normalizer: raw fast-flights offer dicts -> list[Offer].

Deliberately PURE -- no import of the fast-flights library, no network I/O,
stdlib + poller.models only. That's what lets this module be unit-tested
directly against a recorded fixture instead of a live scrape, and lets Task 6
reuse it from the actual scraper without adding a second copy of this logic.
"""
from datetime import time
from urllib.parse import urlencode

from poller.models import Offer, SearchRequest


def normalize_offers(
    raw: list[dict], request: SearchRequest, booking_url: str | None = None
) -> list[Offer]:
    """Converts raw fast-flights offer dicts into normalized Offer objects.

    A malformed offer (missing/bad fields) is skipped rather than raising, so
    one bad entry in a scrape response doesn't lose every other offer in it.
    """
    offers = []
    url = booking_url if booking_url is not None else build_search_url(request)

    for raw_offer in raw:
        offer = _normalize_one(raw_offer, url)
        if offer is not None:
            offers.append(offer)

    return offers


def _parse_leg_time(raw_time: list | tuple) -> time:
    """Explicitly parses a fast-flights [hour] or [hour, minute] time list.

    fast-flights omits the minute element when it's :00 -- a length-1 list
    like [22] means 22:00, not a truncated/corrupt value, so it's parsed as
    time(hour, 0) rather than dropped. Any other shape (empty, >2 elements,
    non-list, or an out-of-range hour/minute) raises ValueError so the caller's
    try/except skips just this malformed offer instead of guessing midnight
    or silently truncating extra elements.
    """
    if not isinstance(raw_time, (list, tuple)):
        raise ValueError(f"time must be a list/tuple, got {raw_time!r}")

    if len(raw_time) == 2:
        return time(int(raw_time[0]), int(raw_time[1]))
    if len(raw_time) == 1:
        return time(int(raw_time[0]), 0)
    raise ValueError(f"unsupported time list length: {raw_time!r}")


def _normalize_one(raw_offer: dict, booking_url: str) -> Offer | None:
    try:
        price = raw_offer.get("price")
        # never fabricate a price -- an offer with no positive numeric price
        # isn't useful to store or alert on, so drop it rather than guess.
        if price is None or price <= 0:
            return None
        price_usd = int(price)

        airlines = raw_offer.get("airlines") or []
        airline = " / ".join(airlines) if airlines else (raw_offer.get("type") or "Unknown")

        flights = raw_offer["flights"]
        if not flights:
            return None
        stops = len(flights) - 1

        outbound_dep = _parse_leg_time(flights[0]["departure"]["time"])
        outbound_arr = _parse_leg_time(flights[-1]["arrival"]["time"])

        return Offer(
            price_usd=price_usd,
            airline=airline,
            stops=stops,
            outbound_dep=outbound_dep,
            outbound_arr=outbound_arr,
            # fast-flights 3.0.2 doesn't return return-leg flight data for
            # round trips -- `flights` here only ever holds the outbound
            # itinerary's legs, so there's nothing to derive these from.
            return_dep=None,
            return_arr=None,
            booking_url=booking_url,
        )
    except (KeyError, IndexError, TypeError, ValueError):
        # defensive: any malformed shape (missing flights, bad time list,
        # wrong types) skips this one offer, not the whole batch.
        return None


def build_search_url(request: SearchRequest) -> str:
    """Fallback Google Flights URL when the caller has no exact query URL.

    Human-readable query params, not the library's opaque `tfs` token --
    Task 6's scraper overrides this with the real URL from fast-flights'
    query.url() when it has one.
    """
    params = {
        "q": (
            f"flights from {request.origin} to {request.destination} "
            f"on {request.outbound_date.isoformat()} "
            f"through {request.return_date.isoformat()}"
        )
    }
    return f"https://www.google.com/travel/flights?{urlencode(params)}"
