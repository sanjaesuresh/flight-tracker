"""Tests for poller.data_source.normalize against the REAL Phase-0 fixture.

tests/fixtures/roundtrip_jfk_yyz.json was recorded from the Phase-0 Actions
spike run -- it's the actual fast-flights response shape, not hand-crafted.
`flights` in each raw offer holds only the OUTBOUND itinerary's legs (the
fast-flights library doesn't surface return-leg times for round trips), so
every normalized Offer must have return_dep/return_arr == None.
"""
import json
from datetime import date, time
from pathlib import Path

from poller.data_source.normalize import normalize_offers
from poller.models import SearchRequest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "roundtrip_jfk_yyz.json"


def load_fixture():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def make_request():
    # dates match the fixture's recorded outbound date (2026-08-04) and an
    # arbitrary return date -- return-leg data isn't in the raw response at all.
    return SearchRequest(
        origin="JFK",
        destination="YYZ",
        outbound_date=date(2026, 8, 4),
        return_date=date(2026, 8, 7),
    )


def test_normalizes_real_fixture_offers():
    raw = load_fixture()
    request = make_request()

    offers = normalize_offers(raw, request)

    assert len(offers) >= 1
    for offer in offers:
        assert isinstance(offer.price_usd, int)
        assert offer.price_usd > 0
        assert isinstance(offer.airline, str)
        assert offer.airline != ""
        assert isinstance(offer.stops, int)
        assert offer.stops >= 0
        assert isinstance(offer.outbound_dep, time)
        assert isinstance(offer.outbound_arr, time)
        # return-leg times are never available from this library -- see
        # normalize.py's comment on why these are always None.
        assert offer.return_dep is None
        assert offer.return_arr is None
        assert offer.booking_url.startswith("https://www.google.com/travel/flights")

    # pin fixture offer 0 (JFK->DCA->YYZ, $417, American, 1 stop) to concrete
    # values read straight from the fixture, not just types.
    offer0 = offers[0]
    assert offer0.price_usd == 417
    assert offer0.airline == "American"
    assert offer0.stops == 1
    assert offer0.outbound_dep == time(6, 30)
    assert offer0.outbound_arr == time(16, 45)  # last leg DCA->YYZ arrival


def test_on_the_hour_departure_list_of_length_one_is_kept_as_hh_00():
    # fixture offer 1's outbound leg has dep time [22] (length-1 list) --
    # the library omits the minute for on-the-hour times, so this must
    # normalize to 22:00 and the offer must NOT be dropped.
    raw = load_fixture()
    request = make_request()

    offers = normalize_offers(raw, request)

    on_the_hour_offers = [o for o in offers if o.outbound_dep == time(22, 0)]
    assert len(on_the_hour_offers) == 1
    assert on_the_hour_offers[0].price_usd == 417


def test_offer_with_no_price_is_skipped():
    request = make_request()
    raw = [
        {
            "type": "AA",
            "price": None,
            "airlines": ["American"],
            "flights": [
                {
                    "from_airport": {"name": "JFK", "code": "JFK"},
                    "to_airport": {"name": "YYZ", "code": "YYZ"},
                    "departure": {"date": [2026, 8, 4], "time": [6, 30]},
                    "arrival": {"date": [2026, 8, 4], "time": [7, 59]},
                    "duration": 89,
                    "plane_type": "Embraer 175",
                }
            ],
            "carbon": {},
        }
    ]

    offers = normalize_offers(raw, request)

    assert offers == []


def test_empty_raw_list_returns_empty_list_without_error():
    offers = normalize_offers([], make_request())

    assert offers == []


def test_explicit_booking_url_is_used_for_every_offer():
    raw = load_fixture()
    request = make_request()
    url = "https://www.google.com/travel/flights/search?tfs=abc"

    offers = normalize_offers(raw, request, booking_url=url)

    assert len(offers) >= 1
    for offer in offers:
        assert offer.booking_url == url


def test_malformed_offer_is_skipped_without_raising_others():
    request = make_request()
    good = load_fixture()[0]
    malformed_missing_flights = {
        "type": "DL",
        "price": 300,
        "airlines": ["Delta"],
        # no "flights" key at all
        "carbon": {},
    }
    malformed_bad_time = {
        "type": "UA",
        "price": 350,
        "airlines": ["United"],
        "flights": [
            {
                "from_airport": {"name": "JFK", "code": "JFK"},
                "to_airport": {"name": "YYZ", "code": "YYZ"},
                "departure": {"date": [2026, 8, 4], "time": [26, 30]},  # bad time: hour out of range
                "arrival": {"date": [2026, 8, 4], "time": [7, 59]},
                "duration": 89,
                "plane_type": "Embraer 175",
            }
        ],
        "carbon": {},
    }

    raw = [malformed_missing_flights, malformed_bad_time, good]

    offers = normalize_offers(raw, request)

    # both malformed offers are dropped; the well-formed one still comes through.
    assert len(offers) == 1
    assert offers[0].price_usd == good["price"]


def test_empty_or_overlong_time_list_skips_offer_not_midnight_or_truncated():
    request = make_request()
    good = load_fixture()[0]

    def leg(dep_time):
        return {
            "from_airport": {"name": "JFK", "code": "JFK"},
            "to_airport": {"name": "YYZ", "code": "YYZ"},
            "departure": {"date": [2026, 8, 4], "time": dep_time},
            "arrival": {"date": [2026, 8, 4], "time": [7, 59]},
            "duration": 89,
            "plane_type": "Embraer 175",
        }

    empty_time_list = {
        "type": "AA",
        "price": 300,
        "airlines": ["American"],
        "flights": [leg([])],
        "carbon": {},
    }
    bad_time_list = {
        "type": "AA",
        "price": 310,
        "airlines": ["American"],
        "flights": [leg([10, 20, 99])],
        "carbon": {},
    }

    raw = [empty_time_list, bad_time_list, good]

    offers = normalize_offers(raw, request)

    # both malformed-time offers are skipped entirely -- never coerced to
    # midnight and never silently truncated to the first two elements.
    assert len(offers) == 1
    assert offers[0].price_usd == good["price"]


def test_multiple_airlines_are_joined_with_slash():
    request = make_request()
    raw = [
        {
            "type": "AA",
            "price": 500,
            "airlines": ["American", "Delta"],
            "flights": [
                {
                    "from_airport": {"name": "JFK", "code": "JFK"},
                    "to_airport": {"name": "YYZ", "code": "YYZ"},
                    "departure": {"date": [2026, 8, 4], "time": [6, 30]},
                    "arrival": {"date": [2026, 8, 4], "time": [7, 59]},
                    "duration": 89,
                    "plane_type": "Embraer 175",
                }
            ],
            "carbon": {},
        }
    ]

    offers = normalize_offers(raw, request)

    assert len(offers) == 1
    assert offers[0].airline == "American / Delta"


def test_airline_falls_back_to_type_then_unknown():
    request = make_request()

    def offer_with(airlines, offer_type):
        return {
            "type": offer_type,
            "price": 500,
            "airlines": airlines,
            "flights": [
                {
                    "from_airport": {"name": "JFK", "code": "JFK"},
                    "to_airport": {"name": "YYZ", "code": "YYZ"},
                    "departure": {"date": [2026, 8, 4], "time": [6, 30]},
                    "arrival": {"date": [2026, 8, 4], "time": [7, 59]},
                    "duration": 89,
                    "plane_type": "Embraer 175",
                }
            ],
            "carbon": {},
        }

    # no airlines list, but a "type" code present -> falls back to the type.
    offers = normalize_offers([offer_with([], "AA")], request)
    assert offers[0].airline == "AA"

    # no airlines list and no "type" -> falls back to "Unknown".
    offers = normalize_offers([offer_with([], None)], request)
    assert offers[0].airline == "Unknown"
