"""Tests for the ROTATING-branch Google Flights scraper.

fast_flights is NOT installed in this test venv (see google_flights.py's
module docstring), so every test drives GoogleFlightsSource with an injected
fetch_fn/sleep_fn/rng and never exercises the lazy real-scrape path. That
path (_default_fetch) is only reachable if fast_flights is actually
importable, which it deliberately isn't here.
"""
import json
from datetime import date
from pathlib import Path

import pytest

from poller.data_source.google_flights import GoogleFlightsSource, _build_query_kwargs
from poller.models import SearchRequest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "roundtrip_jfk_yyz.json"


def load_fixture():
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def make_request(origin="JFK", destination="YYZ", outbound=(2026, 8, 4), ret=(2026, 8, 7)):
    return SearchRequest(
        origin=origin,
        destination=destination,
        outbound_date=date(*outbound),
        return_date=date(*ret),
    )


def make_candidates(n):
    # distinct requests so call order / identity is easy to assert on --
    # outbound day offset by index keeps every candidate unique.
    return [
        SearchRequest(
            origin="JFK",
            destination="YYZ",
            outbound_date=date(2026, 8, 1 + i),
            return_date=date(2026, 8, 10 + i),
        )
        for i in range(n)
    ]


class FlightsNotFound(Exception):
    """Local stand-in for fast_flights' FlightsNotFound -- confirm_candidates
    distinguishes it by exception class NAME (never imports fast_flights),
    so a same-named local class is all that's needed to exercise that path.
    """


class FakeFetch:
    """Records calls and returns the recorded fixture + a fake booking URL."""

    def __init__(self, raw=None, raise_on=None, raise_exc_by_date=None):
        self.raw = raw if raw is not None else load_fixture()
        self.calls: list[SearchRequest] = []
        # optional set of request identities (by outbound_date) to raise on,
        # for the best-effort partial-failure test.
        self.raise_on = raise_on or set()
        # optional dict of outbound_date -> exception instance, for tests
        # that need to distinguish which exception type is raised per date.
        self.raise_exc_by_date = raise_exc_by_date or {}

    def __call__(self, request: SearchRequest):
        self.calls.append(request)
        if request.outbound_date in self.raise_exc_by_date:
            raise self.raise_exc_by_date[request.outbound_date]
        if request.outbound_date in self.raise_on:
            raise RuntimeError("simulated scrape failure")
        return self.raw, "https://www.google.com/travel/flights/search?tfs=fake"


class FakeSleep:
    def __init__(self):
        self.calls: list[float] = []

    def __call__(self, seconds: float):
        self.calls.append(seconds)


class FixedRng:
    """Deterministic stand-in for random.Random -- always returns a fixed value
    within [a, b], so pacing assertions don't need real randomness."""

    def uniform(self, a, b):
        return (a + b) / 2


def test_budget_limits_confirm_candidates_to_exactly_budget_searches():
    candidates = make_candidates(10)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(
        budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng()
    )

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=0)

    assert len(fetch.calls) == 3
    assert len(offers_by_request) == 3
    # SearchRequest is an unhashable plain dataclass (see snapshots.py's own
    # Iterable[tuple[...]] contract, not a dict), so this is a list of
    # (request, offers) pairs -- compare processed requests by identity.
    processed = [req for req, _ in offers_by_request]
    assert processed == [candidates[0], candidates[1], candidates[2]]
    assert next_cursor == 3
    assert failed == 0


def test_rotation_wraps_around_end_of_candidate_list():
    candidates = make_candidates(10)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(
        budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng()
    )

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=8)

    processed = [c.outbound_date for c in fetch.calls]
    assert processed == [candidates[8].outbound_date, candidates[9].outbound_date, candidates[0].outbound_date]
    assert next_cursor == 1
    # no duplicate processing within one poll
    assert len({id(c) for c in fetch.calls}) == 3
    assert failed == 0


def test_pacing_sleeps_between_consecutive_searches_within_delay_range():
    candidates = make_candidates(5)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(
        budget=3,
        delay_range=(2.0, 6.0),
        fetch_fn=fetch,
        sleep_fn=sleep,
        rng=FixedRng(),
    )

    source.confirm_candidates(candidates, cursor=0)

    # 3 searches -> exactly 2 pauses (between consecutive searches only)
    assert len(sleep.calls) == 2
    for value in sleep.calls:
        assert 2.0 <= value <= 6.0


def test_no_sleep_for_a_single_search_slice():
    candidates = make_candidates(5)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(budget=1, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    source.confirm_candidates(candidates, cursor=0)

    assert len(fetch.calls) == 1
    assert len(sleep.calls) == 0


def test_build_query_kwargs_requests_usd_and_swaps_legs():
    request = make_request(origin="JFK", destination="YYZ", outbound=(2026, 8, 4), ret=(2026, 8, 7))

    kwargs = _build_query_kwargs(request)

    assert kwargs["currency"] == "USD"
    assert kwargs["seat"] == "economy"
    assert kwargs["trip"] == "round-trip"
    flights = kwargs["flights"]
    assert len(flights) == 2
    outbound_leg, return_leg = flights
    assert outbound_leg["date"] == "2026-08-04"
    assert outbound_leg["from_airport"] == "JFK"
    assert outbound_leg["to_airport"] == "YYZ"
    assert return_leg["date"] == "2026-08-07"
    assert return_leg["from_airport"] == "YYZ"
    assert return_leg["to_airport"] == "JFK"


def test_confirm_candidates_produces_real_normalized_offers():
    candidates = make_candidates(2)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(budget=2, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, _, failed = source.confirm_candidates(candidates, cursor=0)

    assert failed == 0
    for request, offers in offers_by_request:
        assert len(offers) >= 1
        for offer in offers:
            assert offer.price_usd > 0
            assert offer.booking_url == "https://www.google.com/travel/flights/search?tfs=fake"


def test_empty_candidates_returns_untouched_cursor_without_fetch_or_sleep():
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = GoogleFlightsSource(budget=5, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates([], cursor=4)

    assert offers_by_request == []
    assert next_cursor == 4
    assert failed == 0
    assert fetch.calls == []
    assert sleep.calls == []


def test_a_single_failing_search_is_best_effort_and_does_not_abort_the_slice():
    candidates = make_candidates(3)
    failing_date = candidates[1].outbound_date
    fetch = FakeFetch(raise_on={failing_date})
    sleep = FakeSleep()
    source = GoogleFlightsSource(budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=0)

    by_request = dict(zip((id(r) for r, _ in offers_by_request), (o for _, o in offers_by_request)))
    assert len(fetch.calls) == 3
    assert next_cursor == 0  # (0 + 3) % 3 wraps back to the start
    # the failing candidate recorded no offers, but the other two succeeded
    assert by_request[id(candidates[1])] == []
    assert len(by_request[id(candidates[0])]) >= 1
    assert len(by_request[id(candidates[2])]) >= 1
    assert failed == 1


def test_flights_not_found_is_an_empty_result_not_a_failure():
    candidates = make_candidates(3)
    not_found_date = candidates[0].outbound_date
    real_error_date = candidates[1].outbound_date
    fetch = FakeFetch(
        raise_exc_by_date={
            not_found_date: FlightsNotFound("no flights"),
            real_error_date: RuntimeError("simulated scrape failure"),
        }
    )
    sleep = FakeSleep()
    source = GoogleFlightsSource(budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=0)

    by_request = dict(zip((id(r) for r, _ in offers_by_request), (o for _, o in offers_by_request)))
    assert len(fetch.calls) == 3
    # both failing candidates still show up with an empty offers list --
    # best-effort continues regardless of exception type.
    assert by_request[id(candidates[0])] == []
    assert by_request[id(candidates[1])] == []
    assert len(by_request[id(candidates[2])]) >= 1
    # only the RuntimeError counts as a failure; FlightsNotFound is a
    # legitimate empty result and must not inflate failed_count.
    assert failed == 1
    assert next_cursor == 0  # (0 + 3) % 3 wraps back to the start


def test_coarse_scan_raises_not_implemented():
    source = GoogleFlightsSource(fetch_fn=FakeFetch(), sleep_fn=FakeSleep(), rng=FixedRng())

    with pytest.raises(NotImplementedError):
        source.coarse_scan("JFK", "YYZ", date(2026, 8, 1), date(2026, 9, 1))


def test_search_calls_fetch_fn_and_normalizes_with_booking_url():
    request = make_request()
    fetch = FakeFetch()
    source = GoogleFlightsSource(fetch_fn=fetch, sleep_fn=FakeSleep(), rng=FixedRng())

    offers = source.search(request)

    assert fetch.calls == [request]
    assert len(offers) >= 1
    assert offers[0].booking_url == "https://www.google.com/travel/flights/search?tfs=fake"
