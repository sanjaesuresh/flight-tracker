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

from poller.data_source.booking_url import build_selected_flights_search_url
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
) -> list[Offer]:
    """Converts raw fli (outbound, return) pair dicts into normalized Offers.

    Each offer's booking_url is the DURABLE selected-flights /search link,
    built PER OFFER from that offer's own legs (airports, dates, airline,
    flight numbers). Because the tfs is encoded from the offer's actual legs,
    it is route-correct by construction -- there is no shared/representative
    tfs to disagree with the itinerary, so the old tfs_by_pair matrix and its
    degrade path are gone. See _normalize_one_pair.

    A malformed pairing (missing/bad fields) is skipped rather than raising,
    matching normalize.py's hardening -- one bad entry in a response
    shouldn't lose every other offer in it.
    """
    offers = []
    for raw_pair in raw_pairs:
        offer = _normalize_one_pair(raw_pair, request)
        if offer is not None:
            offers.append(offer)
    return offers


def _direction_for_tfs(legs: list[dict]) -> dict:
    """One direction's leg data in the shape build_selected_flights_tfs wants.

    Uses the FIRST leg's departure airport + the direction's departure DATE,
    the LAST leg's arrival airport, and the first leg's airline+flight number
    as the selected flight for that direction (matches the single-selected-
    flight-per-direction shape both known-good oracles encode).
    """
    first, last = legs[0], legs[-1]
    return {
        "from": first["departure_airport"],
        "to": last["arrival_airport"],
        "date": _parse_leg_datetime(first["departure_datetime"]).date().isoformat(),
        "airline": first["airline"],
        "flight_number": first["flight_number"],
    }


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
    raw_pair: list[dict], request: SearchRequest
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

        # mixed-route visibility: the RETURN leg's own actual airports,
        # read the same way as the outbound's above -- a matrix query pairs
        # up origins/destinations independently per direction, so these can
        # differ from actual_origin/actual_destination (out LGA->YYZ, back
        # YTZ->JFK). Stored regardless of whether they match the outbound;
        # "mixed" is derived at display time, not decided here.
        return_origin = ret_legs[0]["departure_airport"]
        return_destination = ret_legs[-1]["arrival_airport"]

        # the fix: build the durable selected-flights /search link from THIS
        # offer's own outbound+return legs. Encoding the exact flights into
        # tfs opens Google with both legs pre-selected (not the all-options
        # search page), and because it carries no session state the stored
        # link still renders correctly whenever a user later clicks it from an
        # alert email. Route-correct by construction -- the tfs is built from
        # the offer's real legs, so it can never disagree with the itinerary.
        booking_url = build_selected_flights_search_url(
            [_direction_for_tfs(out_legs), _direction_for_tfs(ret_legs)]
        )

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
            return_origin=return_origin,
            return_destination=return_destination,
        )
    except (KeyError, IndexError, TypeError, ValueError):
        # defensive: any malformed shape (missing legs, bad datetime string,
        # wrong types, wrong pair length) skips this one pairing, not the
        # whole batch.
        return None
