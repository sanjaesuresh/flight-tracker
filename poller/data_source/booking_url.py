"""Pure builders for Google Flights itinerary deep-links.

No import of fli or fast_flights here -- just base64 + the minimal protobuf
wire-format primitives needed to encode the URL tokens. This mirrors fli's own
`fli.search._proto` (build_booking_token / extract_booking_token_from_tfu) so
the round-trip tests in tests/test_booking_url.py can assert byte-for-byte
against fixtures captured from fli's real encoder -- if Google (or fli) ever
changes a wire shape, those tests fail loudly instead of the poller silently
emitting a dead link.

Two link forms are supported:

1. The DURABLE selected-flights SEARCH link (what the poller stores):
       https://www.google.com/travel/flights/search?tfs=<tfs>
   where `tfs` is a per-offer protobuf listing each direction's exact leg
   (airports, date, airline, flight number), so Google opens with BOTH legs
   pre-selected. It carries no session state, so a stored link still renders
   the selected page whenever a user later clicks it from an alert email.
   (Live-verified: this /search?tfs form renders "Round trip to <dest>" with
   both legs selected, and re-renders identically after a 10-minute delay --
   see the Phase-5 booking-link acceptance run.)

2. The SESSION-ANCHORED booking link (built here + tested, but NOT stored):
       https://www.google.com/travel/flights/booking?tfs=<tfs>&tfu=<tfu>&curr=USD
   where `tfu` wraps a booking token derived from a live search session id.
   This form ALSO renders the selected page, but the session id is ephemeral
   server-side state -- durability past ~10 minutes is unproven, and a stored
   link must survive hours/days until an email is clicked. So build_booking_url
   exists for completeness/tests, but normalize_fli stores the /search form.

The selected-flights tfs schema and the tfu envelope were reverse-engineered
from two live known-good "selected page" URLs and reproduced byte-for-byte from
leg data before integration (GATE 1 of the acceptance run).
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


def _varint_field(field: int, value: int) -> bytes:
    return _tag(field, 0) + _varint(value)


def _string_field(field: int, text: str) -> bytes:
    return _length_delim(field, text.encode("ascii"))


# ISO-date length: the selected-flights tfs uses each direction's DEPARTURE
# date (YYYY-MM-DD), taken from the leg's departure_datetime. Slicing the first
# 10 chars is enough since fli hands us naive local-wall-clock ISO strings.
_DATE_LEN = 10

# constant tail fields observed identical across both known-good oracles --
# f8/f9/f14/f19 = 1, and f16 = {f1 = uint64 max}. Their exact meaning is
# Google-internal (seat/trip/passenger markers), but they must be present and
# in this order for the selected page to render; reproduced verbatim from the
# byte-exact oracle decode.
_TFS_MAX_UINT64 = 0xFFFFFFFFFFFFFFFF


def build_selected_flights_tfs(directions: list[dict]) -> str:
    """Builds the SELECTED-FLIGHTS `tfs` token from per-direction leg data.

    `directions` is one dict PER DIRECTION (outbound, then return), each:
        {
            "from": str,        # origin IATA of this direction's first leg
            "to": str,          # destination IATA of this direction's last leg
            "date": str,        # this direction's departure date, YYYY-MM-DD
            "airline": str,     # IATA carrier code
            "flight_number": str,
        }

    Encodes the exact protobuf schema Google's selected-flights page expects
    (verified byte-for-byte against two live known-good URLs): top-level
    f1=28, f2=2, then one f3 submessage per direction, then the constant tail.
    Each direction's f4 carries {from, date, to, airline, flight#}; f13/f14
    are {1:1, 2:airport} endpoint markers.

    Built PER OFFER from that offer's OWN legs, so the token is inherently
    route-correct -- no shared/representative tfs, no possibility of a tfs
    that disagrees with the itinerary it links to.
    """
    direction_msgs = b""
    for d in directions:
        # f4 is the concrete flight identity for this direction; field order
        # (from, date, to, airline, flight#) is load-bearing -- Google reads
        # it positionally, and the byte-exact oracle uses exactly this order.
        f4 = (
            _string_field(1, d["from"])
            + _string_field(2, d["date"])
            + _string_field(3, d["to"])
            + _string_field(5, d["airline"])
            + _string_field(6, d["flight_number"])
        )
        body = (
            _string_field(2, d["date"])
            + _length_delim(4, f4)
            + _length_delim(13, _varint_field(1, 1) + _string_field(2, d["from"]))
            + _length_delim(14, _varint_field(1, 1) + _string_field(2, d["to"]))
        )
        direction_msgs += _length_delim(3, body)

    payload = (
        _varint_field(1, 28)
        + _varint_field(2, 2)
        + direction_msgs
        + _varint_field(8, 1)
        + _varint_field(9, 1)
        + _varint_field(14, 1)
        + _length_delim(16, _varint_field(1, _TFS_MAX_UINT64))
        + _varint_field(19, 1)
    )
    # urlsafe base64, padding stripped -- matches Google's own tfs param shape.
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def build_selected_flights_search_url(directions: list[dict]) -> str:
    """The DURABLE stored link: /search?tfs=<selected-flights tfs>.

    No session, no tfu -- fully offline and route-correct, so a stored link
    still opens with both legs pre-selected whenever a user clicks it later.
    """
    tfs = build_selected_flights_tfs(directions)
    return f"https://www.google.com/travel/flights/search?tfs={tfs}"


def build_booking_token(
    session_id: str,
    airline_code: str,
    flight_number: str,
    leg_index: int,
    price_cents: int,
    currency: str = "USD",
) -> str:
    """Constructs the session-anchored booking token (fli's outer[0][1]).

    Pure reimplementation of fli.search._proto.build_booking_token so this
    module keeps its no-fli-import discipline. field 2 is "{airline}{flight}#
    {leg_index}"; the "#{leg_index}" suffix matches fli's builder and was
    live-verified to still render the selected page.

    Used only by build_tfu below (the /booking form, which is tested but not
    the stored link). Standard base64 (the token uses + and /).
    """
    nested = (
        _varint_field(1, price_cents)
        + _varint_field(2, 2)
        + _length_delim(3, currency.encode("utf-8"))
    )
    payload = (
        _length_delim(1, session_id.encode("utf-8"))
        + _length_delim(2, f"{airline_code}{flight_number}#{leg_index}".encode())
        + _length_delim(3, nested)
        + _varint_field(7, 28)
        + _varint_field(14, price_cents)
    )
    return base64.b64encode(payload).decode("ascii")


def build_tfu(booking_token: str, leg_field4_indices: list[int] | None = None) -> str:
    """Wraps a booking token into the base64 protobuf `tfu` URL parameter.

    field 1 (length-delimited) = the booking token, ASCII-encoded (mirrors
    fli's extract_booking_token_from_tfu, which reads field 1 back out).
    field 2 = {1:0}. field 4 = zero or more {2:"<index>"} entries.

    `leg_field4_indices` drives field 4: the two known-good oracles show it
    empty for a mixed-airline round trip and ["0","1"] when both legs are the
    SAME airline. Defaults to empty (no indices) -- callers that know the
    airlines pass the indices when all legs share one carrier.

    Uses urlsafe base64 with trailing `=` padding stripped, matching Google's
    real `tfu` values.
    """
    indices = leg_field4_indices or []
    field4 = b"".join(_string_field(2, str(i)) for i in indices)
    payload = (
        _length_delim(1, booking_token.encode("ascii"))
        + _length_delim(2, _varint_field(1, 0))
        + _length_delim(4, field4)
    )
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def build_booking_url(
    tfs: str,
    booking_token: str,
    currency: str = "USD",
    leg_field4_indices: list[int] | None = None,
) -> str:
    """Builds the session-anchored /booking deep-link for one itinerary.

    NOT what the poller stores (the session id inside `booking_token` is
    ephemeral) -- kept for completeness and the round-trip tfu tests. The
    stored link is build_selected_flights_search_url's durable /search form.
    """
    tfu = build_tfu(booking_token, leg_field4_indices=leg_field4_indices)
    return f"https://www.google.com/travel/flights/booking?tfs={tfs}&tfu={tfu}&curr={currency}"
