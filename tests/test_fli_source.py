"""Tests for the fli-backed FliSource.

fli (and fast_flights, used only by _build_tfs) are NOT installed in this
test venv (see fli_source.py's module docstring), so every test drives
FliSource with an injected fetch_fn/sleep_fn/rng and never exercises the
lazy real-fetch path.
"""
import json
from datetime import date
from pathlib import Path

import pytest

from poller.data_source.booking_url import build_booking_url
from poller.data_source.fli_source import FliSource, _extract_tfs_from_url
from poller.models import SearchRequest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "roundtrip_fli_jfk_yyz.json"


def load_fixture_pairs():
    with open(FIXTURE_PATH) as f:
        return json.load(f)["pairs"]


def make_request(origin="JFK", destination="YYZ", outbound=(2026, 8, 15), ret=(2026, 8, 17)):
    return SearchRequest(
        origin=origin,
        destination=destination,
        outbound_date=date(*outbound),
        return_date=date(*ret),
    )


def make_candidates(n):
    return [
        SearchRequest(
            origin="JFK",
            destination="YYZ",
            outbound_date=date(2026, 8, 1 + i),
            return_date=date(2026, 8, 10 + i),
        )
        for i in range(n)
    ]


class FakeFetch:
    """Records calls and returns the recorded fixture pairs + a fake tfs.

    `empty_first_n_calls_for` lets a test force the first N calls for a
    given outbound_date to return an empty result (simulating fli's
    observed soft-miss), so the retry-on-empty behavior can be exercised
    deterministically.
    """

    def __init__(self, pairs=None, raise_on=None, empty_first_n_calls_for=None):
        self.pairs = pairs if pairs is not None else load_fixture_pairs()
        self.calls: list[SearchRequest] = []
        self.raise_on = raise_on or set()
        # dict: outbound_date -> remaining empty-response count before a real result.
        self._empty_budget = dict(empty_first_n_calls_for or {})

    def __call__(self, request: SearchRequest):
        self.calls.append(request)
        if request.outbound_date in self.raise_on:
            raise RuntimeError("simulated fli failure")

        # keyed on the request's representative pair -- matches every
        # fixture offer's actual airports (all JFK->YYZ), so the shared
        # single-pair tests below (budget/rotation/pacing/retry) don't need
        # to care about the tfs_by_pair shape at all.
        tfs_by_pair = {(request.origin, request.destination): "FAKE_TFS"}
        remaining = self._empty_budget.get(request.outbound_date, 0)
        if remaining > 0:
            self._empty_budget[request.outbound_date] = remaining - 1
            return [], tfs_by_pair
        return self.pairs, tfs_by_pair


class FakeSleep:
    def __init__(self):
        self.calls: list[float] = []

    def __call__(self, seconds: float):
        self.calls.append(seconds)


class FixedRng:
    def uniform(self, a, b):
        return (a + b) / 2


def test_budget_limits_confirm_candidates_to_exactly_budget_searches():
    candidates = make_candidates(10)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=0)

    # each search() may call fetch_fn up to twice (retry-on-empty), so this
    # fixture (never empty) means exactly 1 call per candidate.
    assert len(fetch.calls) == 3
    assert len(offers_by_request) == 3
    processed = [req for req, _ in offers_by_request]
    assert processed == [candidates[0], candidates[1], candidates[2]]
    assert next_cursor == 3
    assert failed == 0


def test_rotation_wraps_around_end_of_candidate_list():
    candidates = make_candidates(10)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=8)

    processed = [c.outbound_date for c in fetch.calls]
    assert processed == [candidates[8].outbound_date, candidates[9].outbound_date, candidates[0].outbound_date]
    assert next_cursor == 1
    assert len({id(c) for c in fetch.calls}) == 3
    assert failed == 0


def test_pacing_sleeps_between_consecutive_searches_within_delay_range():
    candidates = make_candidates(5)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(
        budget=3, delay_range=(2.0, 6.0), fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng()
    )

    source.confirm_candidates(candidates, cursor=0)

    # 3 searches -> exactly 2 pauses (between consecutive searches only).
    assert len(sleep.calls) == 2
    for value in sleep.calls:
        assert 2.0 <= value <= 6.0


def test_no_sleep_for_a_single_search_slice():
    candidates = make_candidates(5)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(budget=1, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    source.confirm_candidates(candidates, cursor=0)

    assert len(fetch.calls) == 1
    assert len(sleep.calls) == 0


def test_confirm_candidates_produces_real_normalized_offers():
    candidates = make_candidates(2)
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(budget=2, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, _, failed = source.confirm_candidates(candidates, cursor=0)

    assert failed == 0
    for request, offers in offers_by_request:
        assert len(offers) >= 1
        for offer in offers:
            assert offer.price_usd > 0
            assert offer.booking_url.startswith(
                "https://www.google.com/travel/flights/booking?"
            )
            # the return-leg win: never None under fli.
            assert offer.return_dep is not None
            assert offer.return_arr is not None


def test_empty_candidates_returns_untouched_cursor_without_fetch_or_sleep():
    fetch = FakeFetch()
    sleep = FakeSleep()
    source = FliSource(budget=5, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

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
    source = FliSource(budget=3, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, next_cursor, failed = source.confirm_candidates(candidates, cursor=0)

    by_request = dict(zip((id(r) for r, _ in offers_by_request), (o for _, o in offers_by_request)))
    assert next_cursor == 0  # (0 + 3) % 3 wraps back to the start
    assert by_request[id(candidates[1])] == []
    assert len(by_request[id(candidates[0])]) >= 1
    assert len(by_request[id(candidates[2])]) >= 1
    assert failed == 1


def test_every_raised_exception_counts_as_a_failure_no_flightsnotfound_carveout():
    # unlike GoogleFlightsSource, FliSource has no legitimate-empty-result
    # exception type to carve out -- fli's soft-miss is absorbed by
    # search()'s own retry, so anything that still raises is a real failure.
    candidates = make_candidates(2)
    fetch = FakeFetch(raise_on={candidates[0].outbound_date, candidates[1].outbound_date})
    sleep = FakeSleep()
    source = FliSource(budget=2, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    _, _, failed = source.confirm_candidates(candidates, cursor=0)

    assert failed == 2


# --- C1 regression guard: tfs must survive parse_qs-style corruption ---


def test_tfs_with_plus_slash_equals_survives_extraction_and_assembly_verbatim():
    # parse_qs (the old extraction) decodes `+` to a space and this value is
    # a standard base64 tfs token -- `+`, `/`, `=` are all routine there.
    # Simulates create_query(...).url()'s shape (tfs=<token>&other=x) without
    # needing fast_flights installed.
    fake_query_url = "https://www.google.com/travel/flights?tfs=AA+BB/CC==&curr=USD"

    extracted = _extract_tfs_from_url(fake_query_url)
    # byte-for-byte identical to the substring that appeared in query.url() --
    # no plus-to-space decoding, no re-encoding.
    assert extracted == "AA+BB/CC=="

    booking_url = build_booking_url(tfs=extracted, booking_token="tok123", currency="USD")

    assert "tfs=AA+BB/CC==" in booking_url
    # a `+` corrupted to a literal space would show up as this substring instead.
    assert "tfs=AA BB/CC==" not in booking_url


def test_coarse_scan_raises_not_implemented():
    source = FliSource(fetch_fn=FakeFetch(), sleep_fn=FakeSleep(), rng=FixedRng())

    with pytest.raises(NotImplementedError):
        source.coarse_scan("JFK", "YYZ", date(2026, 8, 1), date(2026, 9, 1))


def test_search_calls_fetch_fn_and_normalizes():
    request = make_request()
    fetch = FakeFetch()
    source = FliSource(fetch_fn=fetch, sleep_fn=FakeSleep(), rng=FixedRng())

    offers = source.search(request)

    assert fetch.calls == [request]
    assert len(offers) >= 1


# --- retry-on-empty (the reliability note from Verdict A/the rework plan) ---


def test_empty_then_results_retries_once_and_returns_the_results():
    request = make_request()
    fetch = FakeFetch(empty_first_n_calls_for={request.outbound_date: 1})

    source = FliSource(fetch_fn=fetch, sleep_fn=FakeSleep(), rng=FixedRng())
    offers = source.search(request)

    assert len(fetch.calls) == 2  # first empty, retry succeeded
    assert len(offers) >= 1


def test_empty_then_empty_again_counts_as_zero_offers_not_an_exception():
    request = make_request()
    fetch = FakeFetch(empty_first_n_calls_for={request.outbound_date: 2})

    source = FliSource(fetch_fn=fetch, sleep_fn=FakeSleep(), rng=FixedRng())
    offers = source.search(request)

    assert len(fetch.calls) == 2  # exactly one retry, no more
    assert offers == []


def test_retry_on_empty_within_confirm_candidates_does_not_inflate_failed_count():
    candidates = make_candidates(1)
    fetch = FakeFetch(empty_first_n_calls_for={candidates[0].outbound_date: 2})
    sleep = FakeSleep()
    source = FliSource(budget=1, fetch_fn=fetch, sleep_fn=sleep, rng=FixedRng())

    offers_by_request, _, failed = source.confirm_candidates(candidates, cursor=0)

    assert len(fetch.calls) == 2
    assert offers_by_request == [(candidates[0], [])]
    assert failed == 0  # empty after retry is zero offers, not a failure
