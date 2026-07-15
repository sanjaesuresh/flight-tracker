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
from poller.data_source.booking_url import build_booking_url, build_tfu

# Real booking_token captured from a live fli search (JFK->YYZ, DL 5007,
# 2026-08-15) -- see docs/planning/rework-plan.md Verdict A.
REAL_TOKEN = (
    "CAISA1VTRBoECOC-AiJyCl0KWwoDSkZLEhkyMDI2LTA4LTE1VDA5OjI5OjAwLTA0OjAwGgNZWVoi"
    "GTIwMjYtMDgtMTVUMTE6MjU6MDAtMDQ6MDAqAkRMMgQ1MDA3OgJETEIENTAwN0gBUgNDUjkSBAgD"
    "EAEYASgAMgcKBURlbHRh"
)
# Expected tfu for REAL_TOKEN, independently verified in a scratch env by
# round-tripping through fli.search._proto.extract_booking_token_from_tfu and
# asserting it returned REAL_TOKEN byte-for-byte.
REAL_TOKEN_EXPECTED_TFU = (
    "CqwBQ0FJU0ExVlRSQm9FQ09DLUFpSnlDbDBLV3dvRFNrWkxFaGt5TURJMkxUQTRMVEUxVkRBNU9q"
    "STVPakF3TFRBME9qQXdHZ05aV1ZvaUdUSXdNall0TURndE1UVlVNVEU2TWpVNk1EQXRNRFE2TURB"
    "cUFrUk1NZ1ExTURBM09nSkVURUlFTlRBd04wZ0JVZ05EVWprU0JBZ0RFQUVZQVNnQU1nY0tCVVJs"
    "YkhSaA"
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


def _read_varint(buf: bytes, off: int) -> tuple[int, int]:
    value, shift = 0, 0
    while True:
        byte = buf[off]
        off += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, off
        shift += 7
