"""Tests for poller.data_source.normalize_fli against a REAL fli fixture.

tests/fixtures/roundtrip_fli_jfk_yyz.json was recorded from a live fli
search (JFK->YYZ, scratch env, Phase 2 investigation) -- it's the actual
per-pairing shape fli_source.py's _default_fetch converts fli's pydantic
results into, not hand-crafted. Every pairing carries FULL leg data on BOTH
directions (the return-leg data gap that forced null return times under
fast-flights doesn't exist here -- see Verdict B in the rework plan).
"""
import json
from datetime import date, time
from pathlib import Path

from poller.data_source.normalize_fli import build_itinerary_key, normalize_fli_offers
from poller.models import SearchRequest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "roundtrip_fli_jfk_yyz.json"


def load_fixture():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def make_request():
    fixture = load_fixture()
    return SearchRequest(
        origin="JFK",
        destination="YYZ",
        outbound_date=date.fromisoformat(fixture["outbound_date"]),
        return_date=date.fromisoformat(fixture["return_date"]),
    )


def test_normalizes_real_fixture_pairs():
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)

    # 4 pairs in the fixture; one (pair 2) has an unpriced return leg and
    # must be skipped -- see test_unpriced_pairing_is_skipped below.
    assert len(offers) == 3
    for offer in offers:
        assert isinstance(offer.price_usd, int)
        assert offer.price_usd > 0
        assert isinstance(offer.airline, str)
        assert offer.airline != ""
        assert isinstance(offer.stops, int)
        assert offer.stops >= 0
        # the return-leg win: all four leg times are populated, never None,
        # unlike fast-flights' normalize.py which always stores return
        # times as None.
        assert isinstance(offer.outbound_dep, time)
        assert isinstance(offer.outbound_arr, time)
        assert isinstance(offer.return_dep, time)
        assert isinstance(offer.return_arr, time)
        # durable selected-flights /search link built per offer from its legs.
        assert offer.booking_url.startswith(
            "https://www.google.com/travel/flights/search?tfs="
        )


def test_pair_total_price_and_same_airline_pinned_to_fixture_pair_0():
    # fixture pair 0: DL 5007 out / DL 5066 back, pair total $435 (the return
    # leg's price field carries the pair TOTAL, per Verdict B).
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)
    offer0 = offers[0]

    assert offer0.price_usd == 435
    assert offer0.airline == "DL"
    assert offer0.stops == 0
    assert offer0.outbound_dep == time(9, 29)
    assert offer0.outbound_arr == time(11, 25)
    assert offer0.return_dep == time(6, 0)
    assert offer0.return_arr == time(7, 53)


def test_mixed_airline_pairing_is_slash_joined_and_stops_is_max_of_both_directions():
    # fixture pair 1: DL 5007 out (0 stops) / AA 4632->2404->4357 back (2
    # stops) -- mixed carrier, and stops must be the MAX of the two
    # directions (Phase 2 rule; Phase 4 splits this per-direction).
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)
    mixed = offers[1]

    assert mixed.airline == "DL / AA"
    assert mixed.stops == 2
    assert mixed.return_dep == time(18, 8)
    assert mixed.return_arr == time(7, 26)


def test_unpriced_pairing_is_skipped():
    # fixture pair 2 has price=None on the return leg -- never fabricate a
    # price, mirroring normalize.py's rule.
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)

    # only 3 offers survive out of 4 fixture pairs.
    assert len(offers) == 3
    prices = {o.price_usd for o in offers}
    assert 435 in prices  # pair 0 kept
    assert None not in prices


def test_multi_carrier_direction_keeps_every_distinct_carrier_no_drops_no_dupes():
    # fixture pair 3: DL out (single leg) / B6->UA->AA back (3 legs, 3
    # distinct carriers) -- taking only the first/last leg per direction
    # (the C2 bug) would collapse this to "DL / AA" and silently drop B6
    # and UA. Every distinct carrier across both directions must appear,
    # order-preserving, with no duplicates.
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)
    multi = offers[2]

    assert multi.price_usd == 512
    assert multi.airline == "DL / B6 / UA / AA"


def test_booking_url_is_per_itinerary_not_a_shared_query_level_url():
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)

    # different pairings encode different return legs into their tfs, so each
    # gets its OWN selected-flights link -- not one shared query-level URL like
    # fast-flights emitted.
    assert offers[0].booking_url != offers[1].booking_url


def test_itinerary_key_is_the_concrete_expected_format_for_fixture_pair_0():
    # fixture pair 0: DL 5007 out on 2026-08-15 / DL 5066 back on 2026-08-17,
    # single leg each way -- concrete pin on the "carrier+flightnum.date"
    # format joined "|" between directions (Verdict D's example shape).
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)

    assert offers[0].itinerary_key == "DL5007.2026-08-15|DL5066.2026-08-17"


def test_itinerary_key_stable_across_polls_and_unaffected_by_price_change():
    fixture = load_fixture()
    request = make_request()
    pair = fixture["pairs"][0]

    offers_first_poll = normalize_fli_offers([pair], request)

    # simulate a later poll where the fare moved but the flights didn't --
    # deep-copy the pair and bump both directions' price.
    import copy
    pair_price_changed = copy.deepcopy(pair)
    pair_price_changed[0]["price"] = 999.0
    pair_price_changed[1]["price"] = 999.0
    offers_second_poll = normalize_fli_offers([pair_price_changed], request)

    assert offers_first_poll[0].itinerary_key == offers_second_poll[0].itinerary_key
    assert offers_first_poll[0].price_usd != offers_second_poll[0].price_usd


def test_different_itineraries_same_route_and_dates_get_different_keys():
    # fixture pairs 0 and 1 share the same outbound leg (DL 5007) but
    # different return itineraries -- must produce different keys.
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)

    assert offers[0].itinerary_key != offers[1].itinerary_key


def test_per_direction_fields_populated_for_mixed_carrier_pairing():
    # fixture pair 1: DL 5007 out (1 leg, 0 stops) / AA 4632->2404->4357 back
    # (3 legs, 2 stops).
    fixture = load_fixture()
    request = make_request()

    offers = normalize_fli_offers(fixture["pairs"], request)
    mixed = offers[1]

    assert mixed.outbound_airline == "DL"
    assert mixed.return_airline == "AA"
    assert mixed.outbound_flight_numbers == "5007"
    assert mixed.return_flight_numbers == "4632+2404+4357"
    assert mixed.outbound_stops == 0
    assert mixed.return_stops == 2


def test_build_itinerary_key_direct_multi_leg_both_directions():
    out_legs = [
        {"airline": "B6", "flight_number": "1001", "departure_datetime": "2026-08-17T08:00:00"},
    ]
    ret_legs = [
        {"airline": "UA", "flight_number": "2002", "departure_datetime": "2026-08-19T11:00:00"},
        {"airline": "AA", "flight_number": "3003", "departure_datetime": "2026-08-19T14:00:00"},
    ]

    key = build_itinerary_key(out_legs, ret_legs)

    assert key == "B61001.2026-08-17|UA2002.2026-08-19-AA3003.2026-08-19"


def test_empty_pairs_list_returns_empty_list_without_error():
    offers = normalize_fli_offers([], make_request())

    assert offers == []


def test_offer_actual_airports_come_from_the_legs_not_the_request():
    # Phase 3: a matrix request covers JFK+LGA -> YYZ+YTZ, but each offer
    # must be tagged with the ACTUAL airports of its own outbound leg, not
    # the request's representative pair -- here the offer flew LGA->YTZ
    # while the request's representative pair is JFK->YYZ.
    request = SearchRequest(
        origin="JFK",
        destination="YYZ",
        outbound_date=date(2026, 8, 15),
        return_date=date(2026, 8, 17),
        origins=["JFK", "LGA"],
        destinations=["YYZ", "YTZ"],
    )
    raw_pair = [
        {
            "price": 300, "stops": 0, "booking_token": "out-tok",
            "legs": [{
                "airline": "AC", "flight_number": "759",
                "departure_airport": "LGA", "arrival_airport": "YTZ",
                "departure_datetime": "2026-08-15T08:00:00",
                "arrival_datetime": "2026-08-15T09:30:00",
            }],
        },
        {
            "price": 300, "stops": 0, "booking_token": "ret-tok",
            "legs": [{
                "airline": "AC", "flight_number": "760",
                "departure_airport": "YTZ", "arrival_airport": "LGA",
                "departure_datetime": "2026-08-17T18:00:00",
                "arrival_datetime": "2026-08-17T19:30:00",
            }],
        },
    ]

    offers = normalize_fli_offers([raw_pair], request)

    assert len(offers) == 1
    assert offers[0].origin == "LGA"
    assert offers[0].destination == "YTZ"
    # the request's representative pair must NOT leak onto the offer.
    assert offers[0].origin != request.origin
    assert offers[0].destination != request.destination


def test_malformed_pair_missing_legs_is_skipped_without_raising_others():
    request = make_request()
    good = load_fixture()["pairs"][0]
    malformed_missing_legs = [
        {"price": 300, "stops": 0, "booking_token": "x", "legs": []},
        {"price": 300, "stops": 0, "booking_token": "y", "legs": [{
            "airline": "DL", "flight_number": "1", "departure_airport": "JFK",
            "arrival_airport": "YYZ", "departure_datetime": "2026-08-15T06:00:00",
            "arrival_datetime": "2026-08-15T07:30:00",
        }]},
    ]
    malformed_bad_datetime = [
        {"price": 300, "stops": 0, "booking_token": "x", "legs": [{
            "airline": "DL", "flight_number": "1", "departure_airport": "JFK",
            "arrival_airport": "YYZ", "departure_datetime": "not-a-datetime",
            "arrival_datetime": "2026-08-15T07:30:00",
        }]},
        {"price": 300, "stops": 0, "booking_token": "y", "legs": [{
            "airline": "DL", "flight_number": "2", "departure_airport": "YYZ",
            "arrival_airport": "JFK", "departure_datetime": "2026-08-17T06:00:00",
            "arrival_datetime": "2026-08-17T07:53:00",
        }]},
    ]
    malformed_wrong_pair_length = [good[0]]

    offers = normalize_fli_offers(
        [malformed_missing_legs, malformed_bad_datetime, malformed_wrong_pair_length, good],
        request,
    )

    assert len(offers) == 1
    assert offers[0].price_usd == 435


def _matrix_offer_raw_pair(origin: str, destination: str, out_tok: str, ret_tok: str) -> list[dict]:
    """Builds a minimal valid raw pair for a given actual airport pair --
    used by the route-consistent-tfs guard tests below."""
    return [
        {
            "price": 300, "stops": 0, "booking_token": out_tok,
            "legs": [{
                "airline": "AC", "flight_number": "100",
                "departure_airport": origin, "arrival_airport": destination,
                "departure_datetime": "2026-08-15T08:00:00",
                "arrival_datetime": "2026-08-15T09:30:00",
            }],
        },
        {
            "price": 300, "stops": 0, "booking_token": ret_tok,
            "legs": [{
                "airline": "AC", "flight_number": "101",
                "departure_airport": destination, "arrival_airport": origin,
                "departure_datetime": "2026-08-17T18:00:00",
                "arrival_datetime": "2026-08-17T19:30:00",
            }],
        },
    ]


def _decode_tfs_from_url(url: str) -> bytes:
    """Decodes the raw protobuf bytes of the tfs param in a /search URL, so a
    test can assert the offer's real airport codes are encoded inside it (not
    just present as free text elsewhere in the URL)."""
    import base64
    from urllib.parse import parse_qs, urlparse

    tfs = parse_qs(urlparse(url).query)["tfs"][0]
    return base64.urlsafe_b64decode(tfs + "=" * ((4 - len(tfs) % 4) % 4))


def test_offers_on_different_actual_pairs_get_their_own_route_consistent_tfs():
    # the blocker guard, now by construction: each offer's tfs is built from
    # its OWN legs, so two offers on different actual airport pairs get tfs
    # tokens that each encode THAT offer's real airports -- there is no shared
    # or representative tfs to mismatch the route.
    request = SearchRequest(
        origin="JFK",
        destination="YYZ",
        outbound_date=date(2026, 8, 15),
        return_date=date(2026, 8, 17),
        origins=["JFK", "LGA"],
        destinations=["YYZ", "YTZ"],
    )
    jfk_ytz_pair = _matrix_offer_raw_pair("JFK", "YTZ", "out-1", "ret-1")
    lga_yyz_pair = _matrix_offer_raw_pair("LGA", "YYZ", "out-2", "ret-2")

    offers = normalize_fli_offers([jfk_ytz_pair, lga_yyz_pair], request)

    assert len(offers) == 2
    jfk_ytz_offer = next(o for o in offers if (o.origin, o.destination) == ("JFK", "YTZ"))
    lga_yyz_offer = next(o for o in offers if (o.origin, o.destination) == ("LGA", "YYZ"))

    # each tfs must encode its OWN offer's airports and not the other's.
    jfk_ytz_bytes = _decode_tfs_from_url(jfk_ytz_offer.booking_url)
    lga_yyz_bytes = _decode_tfs_from_url(lga_yyz_offer.booking_url)
    assert b"JFK" in jfk_ytz_bytes and b"YTZ" in jfk_ytz_bytes
    assert b"LGA" in lga_yyz_bytes and b"YYZ" in lga_yyz_bytes
    # the JFK/YTZ offer's tfs must NOT carry the LGA/YYZ route, and vice versa.
    assert b"LGA" not in jfk_ytz_bytes
    assert b"JFK" not in lga_yyz_bytes
    assert jfk_ytz_offer.booking_url != lga_yyz_offer.booking_url


def test_offer_tfs_encodes_its_own_actual_airports_from_the_legs():
    # a non-representative offer (flew LGA->YTZ while the request's rep pair is
    # JFK->YYZ) must still get a route-correct selected-flights /search link,
    # built from its own legs -- no dependence on any tfs map, no degraded
    # free-text fallback.
    request = SearchRequest(
        origin="JFK",
        destination="YYZ",
        outbound_date=date(2026, 8, 15),
        return_date=date(2026, 8, 17),
        origins=["JFK", "LGA"],
        destinations=["YYZ", "YTZ"],
    )
    lga_ytz_pair = _matrix_offer_raw_pair("LGA", "YTZ", "out-3", "ret-3")

    offers = normalize_fli_offers([lga_ytz_pair], request)

    assert len(offers) == 1
    offer = offers[0]
    assert offer.origin == "LGA"
    assert offer.destination == "YTZ"
    assert offer.booking_url.startswith("https://www.google.com/travel/flights/search?tfs=")
    tfs_bytes = _decode_tfs_from_url(offer.booking_url)
    # the offer's real airports are encoded inside the tfs, never the request's.
    assert b"LGA" in tfs_bytes and b"YTZ" in tfs_bytes
    assert b"JFK" not in tfs_bytes and b"YYZ" not in tfs_bytes
