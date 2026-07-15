"""Formats and sends deal alert emails.

Sending is done through an injected `transport` callable so tests never touch
a real network/SMTP server. `send_alerts` itself never logs or prints the
recipient address -- it only appears inside the returned AlertResult objects,
which callers own and can handle however they like.
"""
import html as html_module
import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

from poller.config import Config
from poller.models import Settings, Trip
from poller.rules import Decision

logger = logging.getLogger(__name__)


@dataclass
class AlertResult:
    subject: str
    body: str
    recipient: str
    sent: bool
    dry_run: bool
    error: str | None = None
    # html alternative of `body`; body stays plain text so dry-run previews
    # remain readable in logs/CLI output.
    html: str | None = None


def _format_date(d) -> str:
    """"<Weekday> <Mon> <D>" e.g. "Thu Oct 15" -- %-d is not portable (Windows
    lacks it), so strip a leading zero from %d by hand instead.
    """
    return d.strftime("%a %b %d").replace(" 0", " ")


def _format_date_long(d) -> str:
    """"Thu, Oct 15" -- the comma'd form the HTML design uses."""
    return d.strftime("%a, %b %d").replace(" 0", " ")


def _format_date_short(d) -> str:
    """"Oct 15" -- compact form for the subject line."""
    return d.strftime("%b %d").replace(" 0", " ")


def _format_time(t) -> str:
    """"H:MM AM/PM", or "n/a" when a leg's time is unknown (return-leg times
    are nullable per fast-flights' round-trip data gap).
    """
    if t is None:
        return "n/a"
    return t.strftime("%-I:%M %p") if hasattr(t, "strftime") else "n/a"


def _stops_text(stops: int) -> str:
    return "nonstop" if stops == 0 else f"{stops} stops"


def _leg_detail(offer, direction: str) -> tuple[str, str, str]:
    """(airline, flight_numbers, stops_text) for one direction.

    Per-direction fields are None on old/fallback rows (the fast-flights
    normalizer never set them), so each degrades to the combined field:
    airline -> offer.airline, flight numbers -> "" (never the string "None"),
    stops -> offer.stops.
    """
    airline = getattr(offer, f"{direction}_airline") or offer.airline
    flights = getattr(offer, f"{direction}_flight_numbers") or ""
    stops = getattr(offer, f"{direction}_stops")
    stops_text = _stops_text(offer.stops if stops is None else stops)
    return airline, flights, stops_text


def _format_html(trip: Trip, decision: Decision) -> str:
    """Owner-approved HTML card. Inline styles only (email clients strip
    <style>/<head>); every interpolated text field is html-escaped.
    """
    esc = html_module.escape
    offer = trip.offer
    origin = esc(trip.request.origin)
    destination = esc(trip.request.destination)
    outbound_long = esc(_format_date_long(trip.request.outbound_date))
    return_long = esc(_format_date_long(trip.request.return_date))
    reason = esc(_trigger_reason_text(decision))

    out_airline, out_flights, out_stops = (esc(x) for x in _leg_detail(offer, "outbound"))
    ret_airline, ret_flights, ret_stops = (esc(x) for x in _leg_detail(offer, "return"))
    out_dep = esc(_format_time(offer.outbound_dep))
    out_arr = esc(_format_time(offer.outbound_arr))
    ret_dep = esc(_format_time(offer.return_dep))
    ret_arr = esc(_format_time(offer.return_arr))

    button_style = (
        "display:block;text-align:center;background:#111827;color:#ffffff;"
        "text-decoration:none;font-size:15px;font-weight:600;padding:14px 20px;border-radius:10px;"
    )
    if offer.booking_url:
        # quote=True (escape default) keeps the URL safe inside the href attribute.
        button = (
            f'<a href="{esc(offer.booking_url)}" style="{button_style}">'
            "View &amp; book on Google Flights &rarr;</a>"
        )
    else:
        # no deep-link (shouldn't normally happen) -- render inert text, not a broken href.
        button = f'<span style="{button_style}opacity:0.5;">Booking link unavailable</span>'

    return f"""<div style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;">
    <tr><td style="background:#ffffff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
      <div style="padding:20px 24px 0 24px;">
        <div style="font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Flight deal</div>
      </div>
      <div style="padding:6px 24px 18px 24px;border-bottom:1px solid #eef0f3;">
        <div style="font-size:44px;line-height:1;font-weight:800;color:#15803d;margin:6px 0 6px;">${offer.price_usd}<span style="font-size:15px;font-weight:600;color:#6b7280;">&nbsp;USD round trip</span></div>
        <div style="font-size:20px;font-weight:700;color:#111827;">{origin} &rarr; {destination}</div>
        <div style="font-size:15px;color:#374151;margin-top:2px;">{outbound_long} &rarr; {return_long}</div>
      </div>
      <div style="padding:14px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;">
          <tr><td style="padding:4px 0;color:#6b7280;width:110px;">Outbound</td><td style="padding:4px 0;color:#111827;">{outbound_long} &middot; {out_airline} {out_flights} &middot; dep {out_dep} &middot; arr {out_arr} &middot; {out_stops}</td></tr>
          <tr><td style="padding:4px 0;color:#6b7280;">Return</td><td style="padding:4px 0;color:#111827;">{return_long} &middot; {ret_airline} {ret_flights} &middot; dep {ret_dep} &middot; arr {ret_arr} &middot; {ret_stops}</td></tr>
        </table>
      </div>
      <div style="padding:2px 24px 22px 24px;">
        {button}
      </div>
      <div style="padding:14px 24px;background:#f9fafb;border-top:1px solid #eef0f3;border-radius:0 0 16px 16px;font-size:12px;color:#6b7280;">
        {reason} &middot; Sent by your flight tracker.
      </div>
    </td></tr>
  </table>
</div>"""


def _trigger_reason_text(decision: Decision) -> str:
    """Builds the human-readable trigger explanation.

    Both threshold and drop can fire together (rules.evaluate unions them), so
    join whichever literal substrings fired rather than picking just one --
    tests assert on the literal "threshold" / baseline-number substrings.
    """
    parts = []
    if "threshold" in decision.reasons:
        parts.append("below your price threshold")
    if "drop" in decision.reasons and decision.baseline is not None:
        baseline = round(decision.baseline)
        parts.append(f"below the recent ${baseline} median for this route/pattern")
    if not parts:
        parts.append("matched your alert criteria")
    return "; ".join(parts)


def format_alert(trip: Trip, decision: Decision) -> tuple[str, str, str]:
    """Builds (subject, plain-text body, html body) for one Trip/Decision
    pair. The plain-text body is the multipart fallback for clients that
    don't render HTML.
    """
    origin = trip.request.origin
    destination = trip.request.destination
    price = trip.offer.price_usd
    outbound_str = _format_date(trip.request.outbound_date)
    return_str = _format_date(trip.request.return_date)

    # price-first so the deal is scannable straight from the inbox list.
    subject = (
        f"Flight deal: ${price} {origin}→{destination}, "
        f"{_format_date_short(trip.request.outbound_date)}–{_format_date_short(trip.request.return_date)}"
    )

    out_airline, out_flights, out_stops = _leg_detail(trip.offer, "outbound")
    ret_airline, ret_flights, ret_stops = _leg_detail(trip.offer, "return")
    reason_text = _trigger_reason_text(decision)
    body_lines = [
        f"Route: {origin} → {destination}",
        f"Outbound: {outbound_str}  dep {_format_time(trip.offer.outbound_dep)} / "
        f"arr {_format_time(trip.offer.outbound_arr)}  "
        f"({' '.join(filter(None, [out_airline, out_flights]))}, {out_stops})",
        f"Return: {return_str}  dep {_format_time(trip.offer.return_dep)} / "
        f"arr {_format_time(trip.offer.return_arr)}  "
        f"({' '.join(filter(None, [ret_airline, ret_flights]))}, {ret_stops})",
        f"Airline: {trip.offer.airline}",
        f"Stops: {_stops_text(trip.offer.stops)}",
        f"Price: ${price} USD",
        f"Why you're seeing this: {reason_text}",
        "",
        trip.offer.booking_url,
    ]
    body = "\n".join(body_lines)

    return subject, body, _format_html(trip, decision)


def send_smtp(
    from_addr: str, to_addr: str, subject: str, text_body: str, html_body: str, config: Config
) -> None:
    """Real transport: Gmail over TLS via stdlib smtplib. Not exercised by
    tests -- they always inject a fake transport instead.
    """
    message = EmailMessage()
    message["From"] = from_addr
    message["To"] = to_addr
    message["Subject"] = subject
    # multipart/alternative: clients render the HTML part, text is the fallback.
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")

    with smtplib.SMTP("smtp.gmail.com", 587) as smtp:
        smtp.starttls()
        smtp.login(config.gmail_address, config.gmail_app_password)
        smtp.send_message(message)


def send_alerts(
    alerts: list[tuple[Trip, Decision]],
    settings: Settings,
    config: Config,
    transport,
) -> list[AlertResult]:
    """Formats and (unless dry-run) sends one email per (trip, decision) pair.

    dry_run short-circuits before transport is ever called -- callers rely on
    that to preview alerts risk-free. In live mode, one alert's transport
    failure is caught and recorded but does not stop the remaining alerts:
    a single bad send (rate limit, transient SMTP error) shouldn't silence
    every other deal in the same poll.
    """
    results: list[AlertResult] = []

    for trip, decision in alerts:
        subject, body, html = format_alert(trip, decision)
        recipient = settings.alert_email

        if settings.dry_run:
            results.append(
                AlertResult(
                    subject=subject, body=body, recipient=recipient,
                    sent=False, dry_run=True, html=html,
                )
            )
            continue

        try:
            transport(config.gmail_address, recipient, subject, body, html)
        except Exception as exc:
            # never log `recipient` here -- only the AlertResult carries it.
            # smtplib's SMTPAuthenticationError (and similar) carry Gmail's
            # actual rejection text on `smtp_error` (bytes); it names no
            # recipient/password, just e.g. "5.7.8 Username and Password not
            # accepted", so logging it tells bad-credentials apart from an
            # IP block on the next run instead of just an opaque type name.
            detail = getattr(exc, "smtp_error", b"")
            if isinstance(detail, bytes):
                detail = detail.decode("utf-8", errors="replace")
            logger.warning("alert send failed: %s %s", type(exc).__name__, detail)
            results.append(
                AlertResult(
                    subject=subject, body=body, recipient=recipient,
                    sent=False, dry_run=False, error=str(exc), html=html,
                )
            )
            continue

        results.append(
            AlertResult(
                subject=subject, body=body, recipient=recipient,
                sent=True, dry_run=False, html=html,
            )
        )

    return results
