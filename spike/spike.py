"""
Phase-0 feasibility spike for flight-deal-tracker (throwaway script, not production code).

Answers three make-or-break questions using the real fast-flights 3.0.2 API:
  (a) can we get a round-trip JFK<->YYZ USD price from Google Flights,
  (b) does fast-flights expose a calendar/date-grid sweep (it does not, as of 3.0.2 -
      see README/source: no calendar/price-graph export anywhere in the package),
  (c) can we produce a working Google Flights booking URL for the searched itinerary.

Design notes from STEP 0 research (fast-flights 3.0.2, github.com/AWeirdDev/flights):
  - There is no `return_date` param. A round trip is expressed as TWO FlightQuery legs
    in create_query(flights=[...]) - one outbound, one with airports swapped for the
    return - plus trip="round-trip". This is dictated by the underlying protobuf schema
    (repeated FlightData in the Info message), not a library quirk.
  - USD is requested via create_query(currency="USD"); default "" lets Google decide.
  - get_flights() returns a ResultList (a list subclass) of Flights dataclasses, each with
    .price (int), .airlines (list[str]), .flights (per-leg SingleFlight details). All are
    plain @dataclass, so dataclasses.asdict() serializes them without a custom encoder.
  - The library has no calendar/price-graph/date-range call anywhere (confirmed via
    exhaustive source review + GitHub code search) - CHECK (b) is expected to FAIL
    "(unsupported by library)". Per the brief, that is not a go/no-go failure; it just
    selects the ROTATING fallback strategy for a later task instead of a CALENDAR one.
  - The Query object returned by create_query() has a .url() method that reconstructs the
    exact Google Flights search URL (tfs=<base64 protobuf>&hl=<lang>&curr=<currency>) the
    library itself scrapes. The maintainer's docstring calls it a debugging aid, not a
    guaranteed-stable bookable link, so CHECK (c) is explicitly a "verify by hand" step.
"""

import dataclasses
import json
import sys
import traceback
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fast_flights import FlightQuery, Passengers, create_query, get_flights

ORIGIN = "JFK"
DESTINATION = "YYZ"
CALENDAR_SWEEP_DAYS = 60
FIXTURE_PATH = "spike_fixture.json"

# results collected as we go so the final summary can list every check regardless of
# which ones raised - a single failing check must not stop the others from running.
results = {}


def today_in_nyc() -> date:
    # the poller must always reason about dates in the traveler's timezone, never the
    # CI runner's UTC clock, or "today" could silently roll over a day early/late.
    return datetime.now(ZoneInfo("America/New_York")).date()


def build_round_trip_query(outbound: date, return_: date, currency: str = "USD"):
    """Build a fast-flights Query for a JFK<->YYZ round trip on the given dates.

    Round-trip has no dedicated return-date param in this library version; it is
    expressed as two FlightQuery legs (outbound, then return with airports swapped).
    """
    return create_query(
        flights=[
            FlightQuery(date=outbound.isoformat(), from_airport=ORIGIN, to_airport=DESTINATION),
            FlightQuery(date=return_.isoformat(), from_airport=DESTINATION, to_airport=ORIGIN),
        ],
        seat="economy",
        trip="round-trip",
        passengers=Passengers(adults=1),
        currency=currency,
    )


def check_a_round_trip_price(outbound: date, return_: date):
    """CHECK (a): round-trip search JFK->YYZ, assert >=1 offer with a positive USD price."""
    query = build_round_trip_query(outbound, return_)
    result_list = get_flights(query)

    if not result_list:
        raise ValueError("no offers returned")

    cheapest = min(result_list, key=lambda f: f.price)
    if not (isinstance(cheapest.price, (int, float)) and cheapest.price > 0):
        raise ValueError(f"cheapest offer has non-positive price: {cheapest.price!r}")

    airline = cheapest.airlines[0] if cheapest.airlines else "unknown airline"
    print(
        f"CHECK (a) round-trip JFK->YYZ USD price: PASS "
        f"(cheapest=${cheapest.price} USD, airline={airline}, offers={len(result_list)})"
    )
    results["a"] = True
    # query is returned too so check (c) can reuse the exact same itinerary for the URL,
    # and result_list is returned so check (d) can dump the exact same raw response.
    return query, result_list


def check_b_calendar_sweep(outbound: date):
    """CHECK (b): attempt a calendar/date-grid sweep. Expected to be unsupported as of
    fast-flights 3.0.2 - the package exports no calendar/price-graph call anywhere
    (verified against __init__.py and a full source read). Failing here is NOT fatal;
    it only selects a fallback (rotating single-date polls) for a later task.
    """
    # look for the kind of symbol a calendar/date-grid feature would need to expose,
    # rather than hardcoding "it doesn't exist" - if a future version adds one, this
    # check should start passing without editing the spike.
    import fast_flights as ff

    candidate_names = [
        name
        for name in dir(ff)
        if any(kw in name.lower() for kw in ("calendar", "grid", "price_graph", "pricegraph", "sweep"))
    ]

    if not candidate_names:
        raise NotImplementedError("unsupported by library")

    # if such a call ever appears, this branch would need real sweep logic; left
    # unimplemented on purpose since none exists to test against today.
    raise NotImplementedError(f"unsupported by library (found candidates: {candidate_names}, not wired up)")


def check_c_booking_url(query) -> str:
    """CHECK (c): produce a Google Flights URL for the searched itinerary.

    Uses the library's own Query.url() (it reconstructs the same tfs= URL fast-flights
    scrapes), since that is the real mechanism this version of the library exposes -
    there is no separate "booking link" builder.
    """
    url = query.url()
    print(f"CHECK (c) booking URL (verify by hand): {url}")
    results["c"] = True
    return url


def check_d_dump_fixture(result_list) -> None:
    """CHECK (d): dump the raw response from check (a) to spike_fixture.json.

    Flights/SingleFlight/Airport/etc. are all plain @dataclass instances (no .dict() or
    custom to-JSON method exists in this library version), so dataclasses.asdict()
    is the correct - and only documented-to-work - way to capture the real fields.
    """
    offers = [dataclasses.asdict(offer) for offer in result_list]
    with open(FIXTURE_PATH, "w") as f:
        json.dump(offers, f, indent=2, default=str)
    print(f"CHECK (d) fixture written: {FIXTURE_PATH} ({len(offers)} offers)")
    results["d"] = True


def main() -> int:
    today = today_in_nyc()
    outbound = today + timedelta(days=21)
    return_ = today + timedelta(days=24)

    query = None
    result_list = None

    # each check is isolated so one failure (e.g. the well-anticipated CHECK (b)) can
    # never prevent the others from running and being reported.
    try:
        query, result_list = check_a_round_trip_price(outbound, return_)
    except Exception as exc:  # noqa: BLE001 - spike script, intentionally broad
        results["a"] = False
        print(f"CHECK (a) round-trip JFK->YYZ USD price: FAIL ({exc})")

    try:
        check_b_calendar_sweep(outbound)
        results["b"] = True
    except Exception as exc:  # noqa: BLE001
        results["b"] = False
        print(f"CHECK (b) calendar sweep: FAIL ({exc})")

    try:
        if query is None:
            # check (c) needs a built query; if check (a) failed before building one,
            # build a fresh one here so (c) can still be exercised independently.
            query = build_round_trip_query(outbound, return_)
        check_c_booking_url(query)
    except Exception as exc:  # noqa: BLE001
        results["c"] = False
        print(f"CHECK (c) booking URL (verify by hand): FAIL ({exc})")

    try:
        if result_list is None:
            raise RuntimeError("no result object available from CHECK (a) to dump")
        check_d_dump_fixture(result_list)
    except Exception as exc:  # noqa: BLE001
        results["d"] = False
        print(f"CHECK (d) fixture written: FAIL ({exc})")

    print("\n--- SUMMARY ---")
    for key, label in (
        ("a", "round-trip JFK->YYZ USD price"),
        ("b", "calendar sweep"),
        ("c", "booking URL"),
        ("d", "fixture dump"),
    ):
        status = "PASS" if results.get(key) else "FAIL"
        print(f"CHECK ({key}) {label}: {status}")

    # exit 0 regardless of check outcomes: a human reads the printed PASS/FAIL lines and
    # the uploaded artifact; a nonzero exit would just make the workflow run "red" for an
    # expected, non-fatal result like (b).
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # last-resort guard so an unexpected top-level error still exits 0 per the
        # brief, after printing the traceback for debugging (no personal data in it).
        traceback.print_exc()
        sys.exit(0)
