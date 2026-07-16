"""Tests for the pure tfu/booking-URL builder in poller.data_source.booking_url.

fli is NOT installed in this test venv, so this can't literally call fli's
extract_booking_token_from_tfu here. Instead, the expected `tfu` values below
were captured in a scratch env by feeding these exact tokens through
build_tfu() and then verifying byte-for-byte against fli's own extractor
round-trip (see the Phase 2 report for the acceptance-gate run). Recording
the expected tfu as a fixture keeps the round-trip PROPERTY under test here
(build then compare to a value independently verified against fli's real
parser) without adding a network/library dependency to CI.
"""
from poller.data_source.booking_url import (
    build_booking_token,
    build_booking_url,
    build_selected_flights_search_url,
    build_selected_flights_tfs,
    build_tfu,
)

# Two live known-good "selected page" oracle URLs (same LGA<->YYZ itinerary
# family, verified in a scratch env to render "Round trip to Toronto" with both
# legs pre-selected). These pin the selected-flights tfs schema AND the tfu
# envelope byte-for-byte, so any drift in either wire shape fails loudly here.
#
# Oracle 1: LGA->YYZ 2026-08-21 AC8451 / YYZ->LGA 2026-08-23 PD603 (MIXED
# airline) -- tfu field 4 is EMPTY.
ORACLE1_TFS = (
    "CBwQAhpAEgoyMDI2LTA4LTIxIiAKA0xHQRIKMjAyNi0wOC0yMRoDWVlaKgJBQzIEODQ1MWoHCAES"
    "A0xHQXIHCAESA1lZWho_EgoyMDI2LTA4LTIzIh8KA1lZWhIKMjAyNi0wOC0yMxoDTEdBKgJQRDID"
    "NjAzagcIARIDWVlacgcIARIDTEdBQAFIAXABggELCP___________wGYAQE"
)
ORACLE1_INNER_TOKEN = (
    "CjRIR0t3ZWYzQWNISmNBQkZHbFFCRy0tLS0tLS0tLW9rYmpkN0FBQUFBR3BZQzhNSmhabGtBEgVQ"
    "RDYwMxoLCOiBAhACGgNVU0Q4HHDogQI="
)
ORACLE1_TFU = (
    "CmxDalJJUjB0M1pXWXpRV05JU21OQlFrWkhiRkZDUnkwdExTMHRMUzB0TFc5clltcGtOMEZCUVVG"
    "QlIzQlpRemhOU21oYWJHdEJFZ1ZRUkRZd014b0xDT2lCQWhBQ0dnTlZVMFE0SEhEb2dRST0SAggA"
    "IgA"
)

# Oracle 2: LGA->YYZ 2026-08-28 AC703 / YYZ->LGA 2026-08-30 AC700 (SAME airline
# both legs) -- tfu field 4 carries ["0","1"].
ORACLE2_TFS = (
    "CBwQAho_EgoyMDI2LTA4LTI4Ih8KA0xHQRIKMjAyNi0wOC0yOBoDWVlaKgJBQzIDNzAzagcIARID"
    "TEdBcgcIARIDWVlaGj8SCjIwMjYtMDgtMzAiHwoDWVlaEgoyMDI2LTA4LTMwGgNMR0EqAkFDMgM3"
    "MDBqBwgBEgNZWVpyBwgBEgNMR0FAAUgBcAGCAQsI____________AZgBAQ"
)
ORACLE2_INNER_TOKEN = (
    "CjRIRlUzTURXYnJxdElBQndWM1FCRy0tLS0tLS0tb2tibGMxNEFBQUFBR3BZSGZvSk9MbTBBEgVB"
    "QzcwMBoLCMySAhACGgNVU0Q4HHDMkgI="
)
ORACLE2_TFU = (
    "CmxDalJJUmxVelRVUlhZbkp4ZEVsQlFuZFdNMUZDUnkwdExTMHRMUzB0YjJ0aWJHTXhORUZCUVVG"
    "QlIzQlpTR1p2U2s5TWJUQkJFZ1ZCUXpjd01Cb0xDTXlTQWhBQ0dnTlZVMFE0SEhETWtnST0SAggA"
    "IgYSATASATE"
)

# Real booking_token captured from a live fli search (JFK->YYZ, DL 5007,
# 2026-08-15) -- see docs/planning/rework-plan.md Verdict A.
REAL_TOKEN = (
    "CAISA1VTRBoECOC-AiJyCl0KWwoDSkZLEhkyMDI2LTA4LTE1VDA5OjI5OjAwLTA0OjAwGgNZWVoi"
    "GTIwMjYtMDgtMTVUMTE6MjU6MDAtMDQ6MDAqAkRMMgQ1MDA3OgJETEIENTAwN0gBUgNDUjkSBAgD"
    "EAEYASgAMgcKBURlbHRh"
)
# Expected tfu for REAL_TOKEN. field 1 = base64(REAL_TOKEN); trailed by
# field 2 = {1:0} and an empty field 4 -- the exact envelope shape decoded
# byte-for-byte from a live known-good "selected page" booking URL (the
# AC8451/PD603 oracle; see the Phase-5 booking-link acceptance run). The
# field-1 portion still round-trips through fli's extractor (which reads only
# field 1), so this stays a loud guard if that wire shape ever drifts.
REAL_TOKEN_EXPECTED_TFU = (
    "CqwBQ0FJU0ExVlRSQm9FQ09DLUFpSnlDbDBLV3dvRFNrWkxFaGt5TURJMkxUQTRMVEUxVkRBNU9q"
    "STVPakF3TFRBME9qQXdHZ05aV1ZvaUdUSXdNall0TURndE1UVlVNVEU2TWpVNk1EQXRNRFE2TURB"
    "cUFrUk1NZ1ExTURBM09nSkVURUlFTlRBd04wZ0JVZ05EVWprU0JBZ0RFQUVZQVNnQU1nY0tCVVJs"
    "YkhSaBICCAAiAA"
)

# Real round-trip itinerary token (return leg's booking_token from fli --
# a JSON-array string of [return_token, [outbound_token]]), also verified.
ITINERARY_TOKEN = (
    '["CAISA1VTRBoECKLTAiJyCl0KWwoDWVlaEhkyMDI2LTA4LTE3VDA2OjAwOjAwLTA0OjAwGgNKRks'
    'iGTIwMjYtMDgtMTdUMDc6NTM6MDAtMDQ6MDAqAkRMMgQ1MDY2OgJETEIENTA2NkgBUgNDUjkSBAgD'
    'EAEYASgAMgcKBURlbHRh",["ClsKA0pGSxIZMjAyNi0wOC0xNVQwOToyOTowMC0wNDowMBoDWVlaI'
    'hkyMDI2LTA4LTE1VDExOjI1OjAwLTA0OjAwKgJETDIENTAwNzoCRExCBDUwMDdIAVIDQ1I5"]]'
)


def test_build_tfu_matches_fli_extractor_round_trip_for_simple_token():
    # this is the loud-failure guard: if Google/fli's tfu wire shape ever
    # drifts, this fixture value (independently verified against fli's real
    # extractor) stops matching and this test fails.
    assert build_tfu(REAL_TOKEN) == REAL_TOKEN_EXPECTED_TFU


def test_build_tfu_round_trips_a_full_itinerary_token_via_local_decode():
    # decode our own construction locally (mirrors fli's extractor logic,
    # minus the fli import) to prove field-1 extraction recovers the
    # original token byte-for-byte, including the JSON-array itinerary shape.
    tfu = build_tfu(ITINERARY_TOKEN)
    assert _decode_field_one(tfu) == ITINERARY_TOKEN


def test_build_booking_url_shape():
    url = build_booking_url(tfs="FAKE_TFS_TOKEN", booking_token=REAL_TOKEN, currency="USD")

    assert url.startswith("https://www.google.com/travel/flights/booking?")
    assert "tfs=FAKE_TFS_TOKEN" in url
    assert f"tfu={REAL_TOKEN_EXPECTED_TFU}" in url
    assert url.endswith("&curr=USD")


def test_build_booking_url_defaults_currency_to_usd():
    url = build_booking_url(tfs="X", booking_token=REAL_TOKEN)

    assert url.endswith("&curr=USD")


def test_selected_flights_tfs_matches_oracle1_byte_for_byte():
    # GATE 1: rebuild the mixed-airline selected-flights tfs purely from leg
    # data and assert it equals the live known-good token exactly.
    directions = [
        {"from": "LGA", "to": "YYZ", "date": "2026-08-21", "airline": "AC", "flight_number": "8451"},
        {"from": "YYZ", "to": "LGA", "date": "2026-08-23", "airline": "PD", "flight_number": "603"},
    ]
    assert build_selected_flights_tfs(directions) == ORACLE1_TFS


def test_selected_flights_tfs_matches_oracle2_byte_for_byte():
    # GATE 1: same-airline itinerary, second independent oracle.
    directions = [
        {"from": "LGA", "to": "YYZ", "date": "2026-08-28", "airline": "AC", "flight_number": "703"},
        {"from": "YYZ", "to": "LGA", "date": "2026-08-30", "airline": "AC", "flight_number": "700"},
    ]
    assert build_selected_flights_tfs(directions) == ORACLE2_TFS


def test_tfu_envelope_matches_oracle1_mixed_airline_empty_field4():
    # mixed-airline round trip -> tfu field 4 is empty. Google stores the
    # inner booking token in field 1 WITH its standard base64 "=" padding
    # preserved, so pass the token verbatim (no rstrip).
    assert build_tfu(ORACLE1_INNER_TOKEN, leg_field4_indices=[]) == ORACLE1_TFU


def test_tfu_envelope_matches_oracle2_same_airline_indexed_field4():
    # same-airline round trip -> tfu field 4 carries leg indices ["0","1"].
    assert build_tfu(ORACLE2_INNER_TOKEN, leg_field4_indices=[0, 1]) == ORACLE2_TFU


def test_build_booking_token_is_session_anchored_and_decodable():
    # build_booking_token appends "#<leg_index>" to the flight number (matching
    # fli's own builder); live-verified to still render the selected page.
    token = build_booking_token(
        session_id="SESSION123",
        airline_code="PD",
        flight_number="603",
        leg_index=1,
        price_cents=33000,
        currency="USD",
    )
    decoded = _decode_field_two(token)
    assert decoded == "PD603#1"


def test_selected_flights_search_url_shape_and_durable_form():
    directions = [
        {"from": "LGA", "to": "YYZ", "date": "2026-08-21", "airline": "AC", "flight_number": "8451"},
        {"from": "YYZ", "to": "LGA", "date": "2026-08-23", "airline": "PD", "flight_number": "603"},
    ]
    url = build_selected_flights_search_url(directions)
    # durable /search form: no tfu, no session, no curr -- just the tfs.
    assert url == f"https://www.google.com/travel/flights/search?tfs={ORACLE1_TFS}"


def _decode_field_one(tfu: str) -> str:
    """Minimal local decoder mirroring fli's extract_booking_token_from_tfu,
    used only to prove build_tfu's own output is self-consistent (field 1
    round-trips) -- the REAL_TOKEN_EXPECTED_TFU fixture above is the actual
    guard against fli's real parser.
    """
    import base64

    padding = "=" * ((4 - len(tfu) % 4) % 4)
    raw = base64.urlsafe_b64decode(tfu + padding)

    off = 0
    while off < len(raw):
        tag, off = _read_varint(raw, off)
        field = tag >> 3
        wire = tag & 0x7
        if wire == 0:
            _, off = _read_varint(raw, off)
        elif wire == 2:
            length, off = _read_varint(raw, off)
            data = raw[off : off + length]
            off += length
            if field == 1:
                return data.decode("ascii")
        else:
            raise ValueError(f"unsupported wire type {wire}")
    raise AssertionError("field 1 not found")


def _decode_field_two(token_b64: str) -> str:
    """Reads field 2 (the "airline+flight#idx" string) out of a booking token
    built by build_booking_token, for a structural assertion in tests."""
    import base64

    raw = base64.b64decode(token_b64 + "=" * ((4 - len(token_b64) % 4) % 4))
    off = 0
    while off < len(raw):
        tag, off = _read_varint(raw, off)
        field = tag >> 3
        wire = tag & 0x7
        if wire == 0:
            _, off = _read_varint(raw, off)
        elif wire == 2:
            length, off = _read_varint(raw, off)
            data = raw[off : off + length]
            off += length
            if field == 2:
                return data.decode("ascii")
        else:
            raise ValueError(f"unsupported wire type {wire}")
    raise AssertionError("field 2 not found")


def _read_varint(buf: bytes, off: int) -> tuple[int, int]:
    value, shift = 0, 0
    while True:
        byte = buf[off]
        off += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, off
        shift += 7
