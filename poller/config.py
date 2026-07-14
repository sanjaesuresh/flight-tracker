"""Environment/secret loading for the poller.

Neon Postgres is reached via a single DATABASE_URL (SSL as the URL specifies).
Gmail SMTP creds are read the same way. Any missing var raises immediately with
its exact name so misconfiguration fails loud in CI logs instead of surfacing
as a confusing downstream error.
"""
import os
from dataclasses import dataclass

REQUIRED_VARS = ("DATABASE_URL", "GMAIL_ADDRESS", "GMAIL_APP_PASSWORD")


class MissingConfigError(Exception):
    """Raised when a required environment variable is not set."""


@dataclass
class Config:
    database_url: str
    gmail_address: str
    gmail_app_password: str


def load_config() -> Config:
    values = {}
    missing = []
    for var in REQUIRED_VARS:
        value = os.environ.get(var)
        if not value:
            missing.append(var)
        else:
            values[var] = value

    if missing:
        # name every missing var explicitly — tests and operators both need the exact name
        raise MissingConfigError(
            f"Missing required environment variable(s): {', '.join(missing)}"
        )

    return Config(
        database_url=values["DATABASE_URL"],
        gmail_address=values["GMAIL_ADDRESS"],
        # Google displays the app password space-grouped and users paste it
        # verbatim; strip spaces here so SMTP auth doesn't silently fail.
        gmail_app_password=values["GMAIL_APP_PASSWORD"].replace(" ", ""),
    )
