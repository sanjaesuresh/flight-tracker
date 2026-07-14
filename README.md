# flight-tracker

A personal NYC↔Toronto cheap-flight alerter: an hourly GitHub-Actions poller scrapes Google
Flights prices into Supabase and emails a booking link when a round-trip drops below a set
threshold. The `spike/` directory is a throwaway Phase-0 feasibility check and is not part of
the production poller.
