"""fli-backed data source: talks to Google Flights' protobuf RPC endpoints
(reverse-engineered by the `flights` PyPI package, imported as `fli`) instead
of scraping HTML like fast-flights/google_flights.py. See
docs/planning/rework-plan.md's Foundation decision and Phase 2 section for
why: return-leg times, mixed-airline round-trip pairing, and a constructible
itinerary-specific booking deep-link all fall out of this swap for free.

fli is NOT installed in the test venv (same discipline as google_flights.py
-- only this module may import it, and only lazily inside _default_fetch).
FliSource takes an injected fetch_fn/sleep_fn/rng so tests exercise the
retry/budget/pacing logic without the library or network.

google_flights.py (fast-flights) is UNTOUCHED and stays as the documented
fallback -- see RUNBOOK.md's degrade path if fli's reverse-engineered API
breaks.
"""
import logging
import random
import time as time_module
from datetime import date

from poller.data_source.base import DataSource
from poller.data_source.normalize_fli import normalize_fli_offers
from poller.models import Offer, SearchRequest

logger = logging.getLogger(__name__)

# sentinel exception name checked by class NAME (never imported) so a fake in
# tests can simulate "fli raised its own typed client error" without this
# module importing fli.search.exceptions -- mirrors google_flights.py's
# FlightsNotFound-by-name convention, though for FliSource every fli
# exception counts as a real failure (there's no legitimate-empty-result
# exception type in fli; empty results come back as None/[], not a raise).


def _leg_to_raw(leg) -> dict:
    """Converts one fli FlightLeg into the plain-dict shape normalize_fli.py
    expects -- IATA codes (not enum members) and ISO datetime strings (not
    fli's own datetime objects), so normalize_fli.py never needs to import
    fli's models.
    """
    return {
        "airline": leg.airline.name.removeprefix("_"),
        "flight_number": leg.flight_number,
        "departure_airport": leg.departure_airport.name.removeprefix("_"),
        "arrival_airport": leg.arrival_airport.name.removeprefix("_"),
        "departure_datetime": leg.departure_datetime.isoformat(),
        "arrival_datetime": leg.arrival_datetime.isoformat(),
    }


def _result_to_raw(result) -> dict:
    return {
        "price": result.price,
        "currency": result.currency,
        "stops": result.stops,
        "booking_token": result.booking_token,
        "legs": [_leg_to_raw(leg) for leg in result.legs],
    }


def _default_fetch(request: SearchRequest) -> list[list[dict]]:
    """Real fli search path. Imported lazily -- fli isn't installed in the
    test venv, only reachable when a caller doesn't inject its own fetch_fn.

    Returns just raw_pairs (a list of [outbound, return] dict pairs). Unlike
    the old contract it no longer returns a tfs map: normalize_fli builds each
    offer's booking_url PER OFFER from that offer's own legs (the durable
    selected-flights /search link), so there's nothing route-level to thread
    out here -- the tfs is inherently correct because it's encoded from the
    offer's real flights.

    Builds ONE query across request.origins x request.destinations (falling
    back to [request.origin]/[request.destination] for a legacy single-pair
    request) -- build_flight_segments accepts a list[Airport] per side
    natively, so this is a single fli search covering the whole airport matrix
    rather than one search per O-D pair.
    """
    from fli.core import build_flight_segments, resolve_airport
    from fli.models import FlightSearchFilters, PassengerInfo
    from fli.search import SearchFlights

    origins = [resolve_airport(code) for code in (request.origins or [request.origin])]
    destinations = [resolve_airport(code) for code in (request.destinations or [request.destination])]
    segments, trip_type = build_flight_segments(
        origin=origins,
        destination=destinations,
        departure_date=request.outbound_date.isoformat(),
        return_date=request.return_date.isoformat(),
    )
    filters = FlightSearchFilters(
        trip_type=trip_type,
        passenger_info=PassengerInfo(adults=1),
        flight_segments=segments,
    )

    client = SearchFlights()
    # currency explicit on every request -- alerts/prices downstream assume
    # USD, and Google's default is locale-dependent.
    results = client.search(filters, currency="USD")

    return (
        [[_result_to_raw(out), _result_to_raw(ret)] for out, ret in results] if results else []
    )


class FliSource(DataSource):
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
        # None means "use the real fli search" -- deferred to call time so
        # the fli import stays lazy.
        self.fetch_fn = fetch_fn if fetch_fn is not None else _default_fetch
        self.rng = rng if rng is not None else random.Random()

    def search(self, request: SearchRequest) -> list[Offer]:
        """Full search for one request, WITH the retry-on-empty soft-miss
        handling (see confirm_candidates docstring for why this lives here
        rather than only in the rotation loop -- callers that use search()
        directly, e.g. tests, get the same reliability behavior).

        fli occasionally returns an empty/None result that succeeds on one
        retry (observed live during Phase 2 investigation: two consecutive
        empties, then 133 results). One retry only -- a second empty is
        treated as a genuine zero-offers result, not endlessly retried.
        """
        raw_pairs = self.fetch_fn(request)
        if not raw_pairs:
            raw_pairs = self.fetch_fn(request)
        return normalize_fli_offers(raw_pairs, request)

    def confirm_candidates(
        self, candidates: list[SearchRequest], cursor: int
    ) -> tuple[list[tuple[SearchRequest, list[Offer]]], int, int]:
        """Processes at most `budget` candidates starting at `cursor`, wrapping
        round-robin over the full list -- same contract as
        GoogleFlightsSource.confirm_candidates (budget cap, pacing between
        searches only, failed_count counts exceptions not empties). See that
        method's docstring for the full contract rationale; this mirrors it
        rather than sharing a base class, since the two sources differ in
        what counts as an empty vs. failed search (fli's retry-on-empty vs.
        fast-flights' FlightsNotFound-by-name).

        note: `budget` caps CANDIDATES, not network calls -- search()'s
        retry-on-empty means a candidate can trigger up to 2 real fetches, so
        one poll can issue up to 2x budget requests, not budget requests.
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
            except Exception as exc:
                # best-effort: one bad candidate shouldn't abort the rest of
                # the budgeted slice -- record no offers and keep going.
                # Unlike google_flights.py's FlightsNotFound-by-name
                # carve-out, every raised exception here counts as a real
                # failure: fli's empty-result soft-miss is already absorbed
                # inside search()'s retry, so anything that still raises is
                # a genuine error (network, parse, etc.), never a
                # legitimate "no flights for this route" signal.
                offers = []
                failed_count += 1
                # O-D codes + exception type only -- never the dates, which
                # are the user's identity-linked travel pattern.
                logger.warning(
                    "fli search error for %s->%s: %s",
                    request.origin,
                    request.destination,
                    type(exc).__name__,
                )
            results.append((request, offers))

        next_cursor = (cursor + count) % total
        return results, next_cursor, failed_count

    def coarse_scan(
        self, origin: str, destination: str, window_start: date, window_end: date
    ) -> list[tuple[date, date, float]]:
        # ROTATING branch (unchanged from google_flights.py's Phase 0
        # decision): no cheap calendar/date-grid sweep is wired up here --
        # the orchestrator instead rotates search() over a budget-limited
        # slice of the pattern-expanded candidates via confirm_candidates.
        # (fli does expose date-range search primitives, but adopting them
        # is out of scope for Phase 2's library swap.)
        raise NotImplementedError(
            "ROTATING branch: no coarse scan; orchestrator rotates "
            "search() over a budget-limited slice"
        )
