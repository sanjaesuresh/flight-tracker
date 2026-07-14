"""DataSource interface: the seam between the poller's scheduling/rules logic
and whatever flight-search backend actually fetches prices (fast-flights for
now; swappable later without touching callers).

Task 6 implements this against fast-flights; this module only defines the
contract so Task 5's normalizer can be built and tested without a network
dependency.
"""
from abc import ABC, abstractmethod
from datetime import date

from poller.models import Offer, SearchRequest


class DataSource(ABC):
    @abstractmethod
    def coarse_scan(
        self, origin: str, destination: str, window_start: date, window_end: date
    ) -> list[tuple[date, date, float]]:
        """Cheap/low-fidelity scan over a date window.

        Returns candidate (outbound_date, return_date, indicative_price)
        tuples used to narrow down which date pairs are worth a full search.
        """
        raise NotImplementedError

    @abstractmethod
    def search(self, request: SearchRequest) -> list[Offer]:
        """Full search for one exact O-D + date pair, returning normalized offers."""
        raise NotImplementedError
