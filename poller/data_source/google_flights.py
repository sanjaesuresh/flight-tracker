"""ROTATING-branch Google Flights scraper (Phase 0 decision: fast-flights
3.0.2 has no calendar/date-grid sweep, so there's no cheap coarse scan --
see coarse_scan below). Instead, each poll confirms a budget-limited,
round-robin slice of the pattern-expanded candidate date-pairs, using the
real fast-flights library for the exact-date search.

fast_flights is NOT installed in the test venv (only this module may import
it, and only lazily inside _default_fetch) -- importing it at module level
would break every test collection here. GoogleFlightsSource takes an
injected fetch_fn/sleep_fn/rng so tests exercise the rotation, budget, and
pacing logic without the library or network.
"""
import random
import time as time_module
from datetime import date

from poller.data_source.base import DataSource
from poller.data_source.normalize import normalize_offers
from poller.models import Offer, SearchRequest


def _build_query_kwargs(request: SearchRequest) -> dict:
    """Pure helper: builds the fast-flights create_query() kwargs for one request.

    Factored out of _default_fetch so USD-currency and the swapped-leg
    round-trip shape can be unit-tested without importing fast_flights at
    all (create_query itself is only called from the lazy default fetch).
    """
    return {
        "flights": [
            {
                "date": request.outbound_date.isoformat(),
                "from_airport": request.origin,
                "to_airport": request.destination,
            },
            {
                "date": request.return_date.isoformat(),
                "from_airport": request.destination,
                "to_airport": request.origin,
            },
        ],
        "seat": "economy",
        "trip": "round-trip",
        # requested explicitly on every search -- alerts/prices downstream
        # assume USD, and fast-flights' default currency isn't guaranteed.
        "currency": "USD",
    }


def _default_fetch(request: SearchRequest) -> tuple[list[dict], str]:
    """Real scrape path. Imported lazily (not at module top level) because
    fast_flights isn't installed in the test venv -- only reachable when a
    caller doesn't inject its own fetch_fn.
    """
    from fast_flights import FlightQuery, Passengers, create_query, get_flights
    import dataclasses

    kwargs = _build_query_kwargs(request)
    query = create_query(
        flights=[FlightQuery(**leg) for leg in kwargs["flights"]],
        seat=kwargs["seat"],
        trip=kwargs["trip"],
        passengers=Passengers(adults=1),
        currency=kwargs["currency"],
    )
    result = get_flights(query)
    raw = [dataclasses.asdict(o) for o in result]
    return raw, query.url()


class GoogleFlightsSource(DataSource):
    def __init__(
        self,
        budget: int = 40,
        delay_range: tuple[float, float] = (2.0, 6.0),
        sleep_fn=time_module.sleep,
        fetch_fn=None,
        rng: random.Random | None = None,
    ):
        self.budget = budget
        self.delay_range = delay_range
        self.sleep_fn = sleep_fn
        # None means "use the real scrape" -- deferred to call time so the
        # fast_flights import stays lazy.
        self.fetch_fn = fetch_fn if fetch_fn is not None else _default_fetch
        self.rng = rng if rng is not None else random.Random()

    def search(self, request: SearchRequest) -> list[Offer]:
        raw, booking_url = self.fetch_fn(request)
        return normalize_offers(raw, request, booking_url=booking_url)

    def confirm_candidates(
        self, candidates: list[SearchRequest], cursor: int
    ) -> tuple[list[tuple[SearchRequest, list[Offer]]], int, int]:
        """Processes at most `budget` candidates starting at `cursor`, wrapping
        round-robin over the full list so consecutive polls eventually cover
        the whole matrix without ever exceeding the per-poll request budget.

        Returns (results, next_cursor, failed_count). results is a list of
        (request, offers) pairs rather than a dict -- SearchRequest is a plain
        (unhashable) dataclass, and this is exactly the
        Iterable[tuple[SearchRequest, list[Offer]]] shape snapshots.py's
        write_snapshots already consumes downstream. failed_count is the
        number of processed candidates whose search() call raised (0 <=
        failed_count <= len(results)) -- this is what lets a caller tell "the
        source is down" apart from "the source is healthy but found zero
        offers", which an empty offers list alone can't distinguish.
        """
        total = len(candidates)
        if total == 0:
            return [], cursor, 0

        count = min(self.budget, total)
        results: list[tuple[SearchRequest, list[Offer]]] = []
        failed_count = 0

        for i in range(count):
            # pause BETWEEN consecutive real searches only -- not before the
            # first and not after the last -- to keep pacing randomized
            # (2-6s default) without stalling the poll on either edge.
            if i > 0:
                self.sleep_fn(self.rng.uniform(*self.delay_range))

            index = (cursor + i) % total
            request = candidates[index]
            try:
                offers = self.search(request)
            except Exception:
                # best-effort: one bad candidate shouldn't abort the rest of
                # the budgeted slice -- record no offers and keep going, but
                # count the raise so callers can tell it apart from a
                # zero-offer success.
                offers = []
                failed_count += 1
            results.append((request, offers))

        next_cursor = (cursor + count) % total
        return results, next_cursor, failed_count

    def coarse_scan(
        self, origin: str, destination: str, window_start: date, window_end: date
    ) -> list[tuple[date, date, float]]:
        # ROTATING branch (Phase 0): fast-flights 3.0.2 exposes no cheap
        # calendar/date-grid query, so there's nothing to scan here -- the
        # orchestrator instead rotates search() over a budget-limited slice
        # of the pattern-expanded candidates via confirm_candidates.
        raise NotImplementedError(
            "ROTATING branch (Phase 0): no coarse scan; orchestrator rotates "
            "search() over a budget-limited slice"
        )
