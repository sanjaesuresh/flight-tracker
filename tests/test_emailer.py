"""Tests for poller.emailer — alert formatting + dry-run/live sending via an
injected transport. Tests never touch real SMTP: a fake transport records
calls (and can be told to raise) so dry-run vs. live and continue-on-failure
semantics are all verifiable without a network.
"""
from datetime import date, time

from poller.config import Config
from poller.emailer import format_alert, send_alerts
from poller.models import Offer, Pattern, SearchRequest, Settings, Trip
from poller.rules import Decision

PATTERN = Pattern(
    outbound_weekday=3,
    outbound_start=time(17, 0),
    outbound_end=time(23, 59),
    return_weekday=6,
    return_start=None,
    return_end=None,
)


def make_settings(**overrides):
    fields = {
        "origins": ["JFK", "LGA"],
        "destinations": ["YYZ", "YTZ"],
        "preferred_origin": "LGA",
        "preferred_destination": "YYZ",
        "patterns": [PATTERN],
        "window_days": 60,
        "threshold_usd": 250,
        "drop_pct": 20,
        "realert_step_pct": 5,
        "realert_step_dollars": 10,
        "min_history_days": 5,
        "alert_email": "someone@example.com",
        "dry_run": True,
        "updated_at": None,
    }
    fields.update(overrides)
    return Settings(**fields)


def make_config(**overrides):
    fields = {
        "database_url": "postgresql://example",
        "gmail_address": "sender@gmail.com",
        "gmail_app_password": "app-password",
    }
    fields.update(overrides)
    return Config(**fields)


def make_trip(price_usd=218, stops=0, airline="Delta", origin="LGA", destination="YYZ",
              outbound_date=date(2026, 10, 15), return_date=date(2026, 10, 18),
              **offer_overrides):
    """Builds a Trip matching the brief's LGA->YYZ $218 Delta example.
    Extra kwargs land on the Offer (per-direction fields, return times, ...).
    """
    offer_fields = {
        "price_usd": price_usd,
        "airline": airline,
        "stops": stops,
        "outbound_dep": time(17, 30),
        "outbound_arr": time(19, 0),
        "return_dep": None,
        "return_arr": None,
        "booking_url": "https://www.google.com/travel/flights/booking-123",
    }
    offer_fields.update(offer_overrides)
    offer = Offer(**offer_fields)
    request = SearchRequest(
        origin=origin,
        destination=destination,
        outbound_date=outbound_date,
        return_date=return_date,
    )
    return Trip(offer=offer, request=request, pattern=PATTERN)


class FakeTransport:
    """Records every call it receives; can be told to raise on specific recipients."""

    def __init__(self, raise_on_call_index=None):
        self.calls = []
        self.raise_on_call_index = raise_on_call_index

    def __call__(self, from_addr, to_addr, subject, text_body, html_body):
        index = len(self.calls)
        self.calls.append((from_addr, to_addr, subject, text_body, html_body))
        if self.raise_on_call_index is not None and index == self.raise_on_call_index:
            raise RuntimeError("simulated transport failure")


def test_format_alert_subject_is_price_first_with_route_and_compact_dates():
    trip = make_trip()
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    subject, _, _ = format_alert(trip, decision)

    # price-first, scannable form: "Flight deal: $218 LGA→YYZ, Oct 15–Oct 18"
    assert subject == "Flight deal: $218 LGA→YYZ, Oct 15–Oct 18"


def test_format_alert_returns_three_parts():
    trip = make_trip()
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    result = format_alert(trip, decision)

    assert len(result) == 3
    subject, text_body, html_body = result
    assert subject and text_body and html_body


def test_format_alert_body_contains_route_price_booking_url_and_airline_stops():
    trip = make_trip()
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, body, _ = format_alert(trip, decision)

    assert "LGA" in body and "YYZ" in body
    assert "218" in body
    assert "Delta" in body
    assert "nonstop" in body
    assert "https://www.google.com/travel/flights/booking-123" in body
    # booking URL must be alone on its own line, not embedded in other text
    lines = body.splitlines()
    assert "https://www.google.com/travel/flights/booking-123" in lines


def test_format_alert_body_reports_connecting_stops():
    trip = make_trip(stops=2)
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, body, _ = format_alert(trip, decision)

    assert "2 stops" in body
    assert "nonstop" not in body


def test_format_alert_body_handles_missing_return_times():
    trip = make_trip()  # return_dep/return_arr are None in make_trip
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, body, _ = format_alert(trip, decision)

    assert "n/a" in body


def test_format_alert_threshold_reason_wording():
    trip = make_trip()
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, body, _ = format_alert(trip, decision)

    assert "threshold" in body


def test_format_alert_drop_reason_wording_includes_baseline():
    trip = make_trip(price_usd=232)
    decision = Decision(fires=True, reasons={"drop"}, baseline=290)

    _, body, _ = format_alert(trip, decision)

    assert "290" in body


def test_format_alert_body_includes_per_direction_detail():
    trip = make_trip(
        outbound_airline="Delta", return_airline="Porter",
        outbound_flight_numbers="DL 5007", return_flight_numbers="PD 2121",
        outbound_stops=0, return_stops=1,
    )
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, body, _ = format_alert(trip, decision)

    assert "DL 5007" in body
    assert "PD 2121" in body
    assert "Porter" in body


def test_format_alert_html_contains_price_route_booking_link_airline_and_reason():
    trip = make_trip(
        outbound_airline="Delta", return_airline="Porter",
        outbound_flight_numbers="DL 5007", return_flight_numbers="PD 2121",
        outbound_stops=0, return_stops=1,
        return_dep=time(10, 15), return_arr=time(11, 45),
    )
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, _, html_body = format_alert(trip, decision)

    assert "$218" in html_body
    assert "LGA" in html_body and "YYZ" in html_body
    assert 'href="https://www.google.com/travel/flights/booking-123"' in html_body
    assert "Delta" in html_body and "Porter" in html_body
    assert "DL 5007" in html_body and "PD 2121" in html_body
    assert "nonstop" in html_body and "1 stops" in html_body
    assert "below your price threshold" in html_body
    # real return times render, not "n/a"
    assert "10:15 AM" in html_body and "11:45 AM" in html_body


def test_format_alert_html_renders_na_for_missing_return_times_not_none():
    trip = make_trip()  # return_dep/return_arr are None
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, _, html_body = format_alert(trip, decision)

    assert "dep n/a" in html_body and "arr n/a" in html_body
    assert "None" not in html_body


def test_format_alert_html_falls_back_to_combined_fields_when_per_direction_none():
    # old/fallback rows: all per-direction fields None -> combined airline/stops
    trip = make_trip(airline="Delta/Porter", stops=1)
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, _, html_body = format_alert(trip, decision)

    assert "Delta/Porter" in html_body
    assert "1 stops" in html_body
    assert "None" not in html_body


def test_format_alert_html_escapes_interpolated_text():
    trip = make_trip(
        outbound_airline="Cheap & Nasty <Air>",
        return_airline="Porter",
    )
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, _, html_body = format_alert(trip, decision)

    assert "Cheap &amp; Nasty &lt;Air&gt;" in html_body
    assert "Cheap & Nasty <Air>" not in html_body


def test_format_alert_html_without_booking_url_has_no_broken_link():
    trip = make_trip(booking_url="")
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    _, _, html_body = format_alert(trip, decision)

    assert "href" not in html_body
    assert "Booking link unavailable" in html_body


def test_send_alerts_dry_run_never_calls_transport_and_marks_results():
    settings = make_settings(dry_run=True)
    config = make_config()
    trip = make_trip()
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)
    transport = FakeTransport()

    results = send_alerts([(trip, decision)], settings, config, transport)

    assert transport.calls == []
    assert len(results) == 1
    assert results[0].sent is False
    assert results[0].dry_run is True
    assert results[0].subject
    assert results[0].body


def test_send_alerts_live_calls_transport_once_per_alert_with_recipient():
    settings = make_settings(dry_run=False, alert_email="recipient@example.com")
    config = make_config(gmail_address="sender@gmail.com")
    trip1 = make_trip(price_usd=218)
    trip2 = make_trip(price_usd=200, outbound_date=date(2026, 10, 22), return_date=date(2026, 10, 25))
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)
    transport = FakeTransport()

    results = send_alerts([(trip1, decision), (trip2, decision)], settings, config, transport)

    assert len(transport.calls) == 2
    for from_addr, to_addr, subject, text_body, html_body in transport.calls:
        assert from_addr == "sender@gmail.com"
        assert to_addr == "recipient@example.com"
        assert subject
        assert text_body
        assert html_body

    assert len(results) == 2
    assert all(result.sent for result in results)
    assert all(result.dry_run is False for result in results)


def test_send_alerts_one_failure_does_not_stop_the_others():
    settings = make_settings(dry_run=False, alert_email="recipient@example.com")
    config = make_config()
    trip1 = make_trip(price_usd=218)
    trip2 = make_trip(price_usd=200, outbound_date=date(2026, 10, 22), return_date=date(2026, 10, 25))
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)
    # first call raises, second succeeds
    transport = FakeTransport(raise_on_call_index=0)

    results = send_alerts([(trip1, decision), (trip2, decision)], settings, config, transport)

    # transport was still called for both alerts
    assert len(transport.calls) == 2

    assert results[0].sent is False
    assert results[0].error is not None

    assert results[1].sent is True
    assert results[1].error is None


def test_send_alerts_logs_failure_without_leaking_recipient(caplog):
    settings = make_settings(dry_run=False, alert_email="recipient@example.com")
    config = make_config()
    trip = make_trip(price_usd=218)
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)
    transport = FakeTransport(raise_on_call_index=0)

    with caplog.at_level("WARNING"):
        send_alerts([(trip, decision)], settings, config, transport)

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "RuntimeError" in warnings[0].getMessage()
    # never leak the recipient address into logs, even on a send failure
    assert not any("recipient@example.com" in r.getMessage() for r in caplog.records)


class _FakeSMTPAuthError(Exception):
    """Stands in for smtplib.SMTPAuthenticationError, which carries Gmail's
    actual rejection reason on `smtp_error` (bytes) -- no PII, just useful
    for telling bad-credentials apart from an IP block."""

    def __init__(self, smtp_error: bytes):
        super().__init__("auth failed")
        self.smtp_error = smtp_error


def test_send_alerts_logs_smtp_error_detail_without_leaking_recipient(caplog):
    settings = make_settings(dry_run=False, alert_email="recipient@example.com")
    config = make_config()
    trip = make_trip(price_usd=218)
    decision = Decision(fires=True, reasons={"threshold"}, baseline=None)

    def transport(from_addr, to_addr, subject, text_body, html_body):
        raise _FakeSMTPAuthError(smtp_error=b"5.7.8 Username and Password not accepted")

    with caplog.at_level("WARNING"):
        send_alerts([(trip, decision)], settings, config, transport)

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    message = warnings[0].getMessage()
    assert "Username and Password not accepted" in message
    assert "recipient@example.com" not in message
