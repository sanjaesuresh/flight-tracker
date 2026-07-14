"""Formats and sends deal alert emails.

Sending is done through an injected `transport` callable so tests never touch
a real network/SMTP server. `send_alerts` itself never logs or prints the
recipient address -- it only appears inside the returned AlertResult objects,
which callers own and can handle however they like.
"""
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


def _format_date(d) -> str:
    """"<Weekday> <Mon> <D>" e.g. "Thu Oct 15" -- %-d is not portable (Windows
    lacks it), so strip a leading zero from %d by hand instead.
    """
    return d.strftime("%a %b %d").replace(" 0", " ")


def _format_time(t) -> str:
    """"H:MM AM/PM", or "n/a" when a leg's time is unknown (return-leg times
    are nullable per fast-flights' round-trip data gap).
    """
    if t is None:
        return "n/a"
    return t.strftime("%-I:%M %p") if hasattr(t, "strftime") else "n/a"


def _stops_text(stops: int) -> str:
    return "nonstop" if stops == 0 else f"{stops} stops"


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


def format_alert(trip: Trip, decision: Decision) -> tuple[str, str]:
    """Builds (subject, plain-text body) for one Trip/Decision pair."""
    origin = trip.request.origin
    destination = trip.request.destination
    price = trip.offer.price_usd
    outbound_str = _format_date(trip.request.outbound_date)
    return_str = _format_date(trip.request.return_date)

    subject = f"Flight deal: {origin}→{destination} ${price} {outbound_str} – {return_str}"

    reason_text = _trigger_reason_text(decision)
    body_lines = [
        f"Route: {origin} → {destination}",
        f"Outbound: {outbound_str}  dep {_format_time(trip.offer.outbound_dep)} / "
        f"arr {_format_time(trip.offer.outbound_arr)}",
        f"Return: {return_str}  dep {_format_time(trip.offer.return_dep)} / "
        f"arr {_format_time(trip.offer.return_arr)}",
        f"Airline: {trip.offer.airline}",
        f"Stops: {_stops_text(trip.offer.stops)}",
        f"Price: ${price} USD",
        f"Why you're seeing this: {reason_text}",
        "",
        trip.offer.booking_url,
    ]
    body = "\n".join(body_lines)

    return subject, body


def send_smtp(from_addr: str, to_addr: str, subject: str, body: str, config: Config) -> None:
    """Real transport: Gmail over TLS via stdlib smtplib. Not exercised by
    tests -- they always inject a fake transport instead.
    """
    message = EmailMessage()
    message["From"] = from_addr
    message["To"] = to_addr
    message["Subject"] = subject
    message.set_content(body)

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
        subject, body = format_alert(trip, decision)
        recipient = settings.alert_email

        if settings.dry_run:
            results.append(
                AlertResult(subject=subject, body=body, recipient=recipient, sent=False, dry_run=True)
            )
            continue

        try:
            transport(config.gmail_address, recipient, subject, body)
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
                    sent=False, dry_run=False, error=str(exc),
                )
            )
            continue

        results.append(
            AlertResult(subject=subject, body=body, recipient=recipient, sent=True, dry_run=False)
        )

    return results
