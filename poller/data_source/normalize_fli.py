"""Pure normalizer: raw fli (outbound, return) pair dicts -> list[Offer].

Deliberately PURE -- no import of fli, no network I/O, stdlib + poller.models
only (mirrors the no-library-import discipline in normalize.py so this is
unit-testable against a recorded fixture). fli_source.py's _default_fetch
converts fli's pydantic FlightResult objects into this raw dict shape before
calling normalize_fli_offers; see that module for the exact conversion.

Raw pair shape (one outbound dict, one return dict, each):
    {
        "price": float | None,       # the RETURN dict's "price" is the pair
                                      # TOTAL (Verdict B); the outbound
                                      # dict's "price" is a per-leg echo and
                                      # is NOT what gets stored -- see
                                      # _normalize_one_pair below.
        "currency": str | None,
        "stops": int,
        "booking_token": str,        # deterministic per-itinerary token
        "legs": [
            {
                "airline": str,               # IATA code, e.g. "DL"
                "flight_number": str,
                "departure_airport": str,     # IATA code
                "arrival_airport": str,       # IATA code
                "departure_datetime": str,    # ISO 8601, naive local wall-clock
                "arrival_datetime": str,      # ISO 8601, naive local wall-clock
            },
            ...
        ],
    }
"""
from datetime import datetime, time
from urllib.parse import urlencode

from poller.data_source.booking_url import build_booking_url
from poller.models import Offer, SearchRequest

# separators for itinerary_key (Verdict D): "." between a leg's carrier+
# flight-number and its departure date, "-" joining consecutive legs within
# one direction, "|" joining the outbound side to the return side. Chosen to
# never collide with IATA carrier codes, flight numbers, or ISO dates.
_LEG_FIELD_SEP = "."
_LEG_JOIN_SEP = "-"
_DIRECTION_SEP = "|"


def normalize_fli_offers(
    raw_pairs: list[list[dict]],
    request: SearchRequest,
    tfs_by_pair: dict[tuple[str, str], str],
) -> list[Offer]:
    """Converts raw fli (outbound, return) pair dicts into normalized Offers.

    `tfs_by_pair` maps (origin, destination) -> the dated round-trip search
    token for THAT airport pair (built offline by fli_source.py, one entry
    per origin x destination combination in the request's matrix). A matrix
    query can return offers on ANY actual airport pair, so each offer's
    booking_url must be built from the tfs for its OWN actual airports, not
    a single tfs shared across the whole response -- a mismatched tfs/tfu
    pair is a dead/wrong-route link. See _normalize_one_pair.

    A malformed pairing (missing/bad fields) is skipped rather than raising,
    matching normalize.py's hardening -- one bad entry in a response
    shouldn't lose every other offer in it.
    """
    offers = []
    for raw_pair in raw_pairs:
        offer = _normalize_one_pair(raw_pair, tfs_by_pair, request)
        if offer is not None:
            offers.append(offer)
    return offers


def _build_degraded_search_url(
    origin: str, destination: str, outbound_date, return_date
) -> str:
    """Fallback human-readable Google Flights search URL for an offer whose
    actual airport pair has no entry in tfs_by_pair.

    Mirrors normalize.py's build_search_url shape (a `q=` free-text search,
    not a `tfs=` token) -- deliberately NOT a tfs=<something>, since there's
    nothing route-correct to put there; a missing pair must degrade to a
    working search link, never a mismatched booking deep-link.
    """
    params = {
        "q": (
            f"flights from {origin} to {destination} "
            f"on {outbound_date.isoformat()} "
            f"through {return_date.isoformat()}"
        )
    }
    return f"https://www.google.com/travel/flights?{urlencode(params)}"


def _parse_leg_datetime(raw: str) -> datetime:
    """Parses fli's naive local-wall-clock ISO datetime string.

    fli's leg datetimes arrive already as naive local time (no tz
    conversion needed -- see the module docstring and Phase 2 investigation
    notes); this just calls fromisoformat and lets a malformed string raise
    ValueError so the caller's try/except skips just this pairing.
    """
    return datetime.fromisoformat(raw)


def _leg_key(leg: dict) -> str:
    """One leg's contribution to itinerary_key: carrier+flightnum.departure-date.

    Deliberately excludes price (must be stable across a fare change) and
    excludes arrival/departure TIME (only the date), matching the identity
    rule in Verdict D -- carrier + flight number + leg departure DATE.
    """
    departure_date = _parse_leg_datetime(leg["departure_datetime"]).date().isoformat()
    return f"{leg['airline']}{leg['flight_number']}{_LEG_FIELD_SEP}{departure_date}"


def build_itinerary_key(out_legs: list[dict], ret_legs: list[dict]) -> str:
    """Deterministic per-itinerary identity: ordered outbound legs, then
    ordered return legs, each leg rendered as carrier+flightnum.date.

    Example shape (single-leg both ways): "PD2118.2026-08-14|PD2121.2026-08-16".
    Stable across polls for the same itinerary (no price involved); two
    itineraries sharing a route+dates but different flights/carriers get
    different keys, which is the whole point -- see Verdict D.
    """
    outbound_part = _LEG_JOIN_SEP.join(_leg_key(leg) for leg in out_legs)
    return_part = _LEG_JOIN_SEP.join(_leg_key(leg) for leg in ret_legs)
    return f"{outbound_part}{_DIRECTION_SEP}{return_part}"


def _flight_numbers(legs: list[dict]) -> str:
    """Compact joined flight-number string for one direction, e.g. "2118" or
    "4632+2404+4357" for a multi-leg connection."""
    return "+".join(leg["flight_number"] for leg in legs)


def _direction_airline(legs: list[dict]) -> str:
    """Per-direction carrier join -- same order-preserving distinct-carrier
    rule as the combined `airline` field, just scoped to one direction."""
    seen = dict.fromkeys(leg["airline"] for leg in legs)
    return " / ".join(seen)


def _normalize_one_pair(
    raw_pair: list[dict], tfs_by_pair: dict[tuple[str, str], str], request: SearchRequest
) -> Offer | None:
    try:
        if len(raw_pair) != 2:
            raise ValueError(f"expected a 2-element (outbound, return) pair, got {len(raw_pair)}")
        out_raw, ret_raw = raw_pair

        # the RETURN leg's price field carries the pair TOTAL (Verdict B) --
        # the outbound leg's own "price" is a per-leg echo, not what's
        # stored. Never fabricate a price: an unpriced pairing (~1/6 of
        # results per Verdict B) is skipped rather than guessed.
        price = ret_raw.get("price")
        if price is None or price <= 0:
            return None

        out_legs = out_raw["legs"]
        ret_legs = ret_raw["legs"]
        if not out_legs or not ret_legs:
            return None

        # full-list join (mirrors normalize.py's " / ".join(airlines)) --
        # taking only out_legs[0]/ret_legs[-1] silently drops middle-leg
        # carriers on a multi-carrier direction and is asymmetric between
        # directions; airline is part of alert identity so this must be
        # complete and order-stable, not endpoint-only.
        seen = dict.fromkeys(
            leg["airline"] for leg in (*out_legs, *ret_legs)
        )
        airline = " / ".join(seen)

        # combined stops kept for back-compat (existing readers); Phase 4
        # adds the per-direction counts below alongside it.
        outbound_stops = int(out_raw["stops"])
        return_stops = int(ret_raw["stops"])
        stops = max(outbound_stops, return_stops)

        outbound_dep = _parse_leg_datetime(out_legs[0]["departure_datetime"]).time()
        outbound_arr = _parse_leg_datetime(out_legs[-1]["arrival_datetime"]).time()
        return_dep = _parse_leg_datetime(ret_legs[0]["departure_datetime"]).time()
        return_arr = _parse_leg_datetime(ret_legs[-1]["arrival_datetime"]).time()

        # Phase 3: the offer's ACTUAL airports, from the legs themselves --
        # a matrix query can return offers on any origin x destination
        # combination, so this must come from the outbound leg's own
        # departure/arrival, not the (possibly multi-airport) request.
        actual_origin = out_legs[0]["departure_airport"]
        actual_destination = out_legs[-1]["arrival_airport"]

        booking_token = ret_raw["booking_token"]
        # the blocker fix: tfs must come from THIS offer's own actual airport
        # pair, never the request's representative pair -- a matrix response
        # can mix offers across every origin x destination combination, and
        # stamping one shared tfs on all of them produces a booking_url whose
        # tfs and tfu disagree on the route for any non-representative offer.
        tfs = tfs_by_pair.get((actual_origin, actual_destination))
        if tfs is None:
            # degrade to a route-correct search URL rather than ever emit a
            # tfs/tfu pair that disagrees on the airports.
            booking_url = _build_degraded_search_url(
                actual_origin, actual_destination, request.outbound_date, request.return_date
            )
        else:
            booking_url = build_booking_url(tfs=tfs, booking_token=booking_token, currency="USD")

        return Offer(
            price_usd=int(price),
            airline=airline,
            stops=stops,
            outbound_dep=outbound_dep,
            outbound_arr=outbound_arr,
            return_dep=return_dep,
            return_arr=return_arr,
            booking_url=booking_url,
            origin=actual_origin,
            destination=actual_destination,
            itinerary_key=build_itinerary_key(out_legs, ret_legs),
            outbound_airline=_direction_airline(out_legs),
            return_airline=_direction_airline(ret_legs),
            outbound_flight_numbers=_flight_numbers(out_legs),
            return_flight_numbers=_flight_numbers(ret_legs),
            outbound_stops=outbound_stops,
            return_stops=return_stops,
        )
    except (KeyError, IndexError, TypeError, ValueError):
        # defensive: any malformed shape (missing legs, bad datetime string,
        # wrong types, wrong pair length) skips this one pairing, not the
        # whole batch.
        return None
