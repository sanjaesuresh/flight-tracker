"""Pure builder for the Google Flights itinerary-specific booking deep-link.

No import of fli or fast_flights here -- just base64 + the minimal protobuf
wire-format primitives needed to wrap a booking token into the `tfu` URL
parameter. This is the inverse of fli's own `extract_booking_token_from_tfu`
(fli.search._proto), and the round-trip test in
tests/test_booking_url.py asserts byte-for-byte against a fixture captured
from fli's real extractor output -- so if Google (or fli) ever changes this
wire shape, that test fails loudly instead of the poller silently emitting a
dead link.

Recipe (Verdict A in docs/planning/rework-plan.md): the final booking page is
    https://www.google.com/travel/flights/booking?tfs=<tfs>&tfu=<tfu>&curr=USD
where `tfu` is base64( protobuf { field 1 (str) = <booking_token> } ) and
`tfs` is the dated round-trip search token (built elsewhere, offline, by
fast-flights' create_query(...).url() -- see fli_source.py).
"""
from __future__ import annotations

import base64


def _varint(value: int) -> bytes:
    """Encodes an unsigned integer as a protobuf varint."""
    if value < 0:
        raise ValueError("varint encoder takes non-negative ints only")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _tag(field: int, wire: int) -> bytes:
    return _varint((field << 3) | wire)


def _length_delim(field: int, payload: bytes) -> bytes:
    return _tag(field, 2) + _varint(len(payload)) + payload


def build_tfu(booking_token: str) -> str:
    """Wraps a booking token into the base64 protobuf `tfu` URL parameter.

    field 1 (length-delimited) = the booking token, ASCII-encoded. This
    mirrors fli's own extractor (extract_booking_token_from_tfu), which reads
    field 1 back out -- see the round-trip test for the proof.

    Uses urlsafe base64 (matching fli's decoder, which accepts both
    alphabets) with the trailing `=` padding stripped, matching what Google's
    real `tfu` parameter values look like (no padding in the URL).
    """
    payload = _length_delim(1, booking_token.encode("ascii"))
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def build_booking_url(tfs: str, booking_token: str, currency: str = "USD") -> str:
    """Builds the final /travel/flights/booking deep-link for one itinerary."""
    tfu = build_tfu(booking_token)
    return f"https://www.google.com/travel/flights/booking?tfs={tfs}&tfu={tfu}&curr={currency}"
