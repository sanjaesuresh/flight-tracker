// Filter controls driving the pure applyFilters(). Airlines, stops, price range,
// and per-leg time-of-day windows. Because return-leg times are frequently null and
// the filter deliberately keeps unknown times, that behavior is stated inline so a
// bounded return-time window never looks like it "lost" flights.
import type { FilterState } from '../lib/types';
import { emptyFilter } from '../lib/filter';

interface Props {
  filter: FilterState;
  onChange: (next: FilterState) => void;
  airlines: string[];
}

function TimeRange({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string;
  from: string | null;
  to: string | null;
  onFrom: (v: string | null) => void;
  onTo: (v: string | null) => void;
}) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="label" style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
        {label}
      </legend>
      <div className="leg-times">
        <input
          type="time"
          aria-label={`${label} from`}
          value={from ?? ''}
          onChange={(e) => onFrom(e.target.value || null)}
        />
        <input
          type="time"
          aria-label={`${label} to`}
          value={to ?? ''}
          onChange={(e) => onTo(e.target.value || null)}
        />
      </div>
    </fieldset>
  );
}

export function Filters({ filter, onChange, airlines }: Props) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filter, ...patch });

  const toggleAirline = (a: string) => {
    const has = filter.airlines.includes(a);
    set({ airlines: has ? filter.airlines.filter((x) => x !== a) : [...filter.airlines, a] });
  };

  return (
    <aside className="sidebar">
      <div className="panel form-section">
        <div className="row-between" style={{ marginBottom: '0.9rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Filters</h2>
          <button className="btn btn-ghost" onClick={() => onChange(emptyFilter())}>
            Reset
          </button>
        </div>

        <div className="stack" style={{ gap: '1rem' }}>
          {airlines.length > 0 && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label" style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
                Airline
              </legend>
              <div className="choice-set">
                {airlines.map((a) => (
                  <label className="choice" key={a} style={{ fontFamily: 'var(--font-sans)' }}>
                    <input
                      type="checkbox"
                      checked={filter.airlines.includes(a)}
                      onChange={() => toggleAirline(a)}
                    />
                    {a}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          <div className="field">
            <label htmlFor="stops">Stops</label>
            <select
              id="stops"
              value={filter.maxStops === null ? 'any' : String(filter.maxStops)}
              onChange={(e) =>
                set({ maxStops: e.target.value === 'any' ? null : Number(e.target.value) })
              }
            >
              <option value="any">Any</option>
              <option value="0">Non-stop only</option>
              <option value="1">1 stop or fewer</option>
              <option value="2">2 stops or fewer</option>
            </select>
          </div>

          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ fontSize: '0.82rem', color: 'var(--muted)' }}>
              Price (USD)
            </legend>
            <div className="leg-times">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="min"
                aria-label="Minimum price"
                value={filter.priceMin ?? ''}
                onChange={(e) => set({ priceMin: e.target.value ? Number(e.target.value) : null })}
              />
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="max"
                aria-label="Maximum price"
                value={filter.priceMax ?? ''}
                onChange={(e) => set({ priceMax: e.target.value ? Number(e.target.value) : null })}
              />
            </div>
          </fieldset>

          <TimeRange
            label="Outbound departs"
            from={filter.outboundDepFrom}
            to={filter.outboundDepTo}
            onFrom={(v) => set({ outboundDepFrom: v })}
            onTo={(v) => set({ outboundDepTo: v })}
          />
          <TimeRange
            label="Outbound arrives"
            from={filter.outboundArrFrom}
            to={filter.outboundArrTo}
            onFrom={(v) => set({ outboundArrFrom: v })}
            onTo={(v) => set({ outboundArrTo: v })}
          />
          <TimeRange
            label="Return departs"
            from={filter.returnDepFrom}
            to={filter.returnDepTo}
            onFrom={(v) => set({ returnDepFrom: v })}
            onTo={(v) => set({ returnDepTo: v })}
          />
          <TimeRange
            label="Return arrives"
            from={filter.returnArrFrom}
            to={filter.returnArrTo}
            onFrom={(v) => set({ returnArrFrom: v })}
            onTo={(v) => set({ returnArrTo: v })}
          />
          <p className="hint" style={{ fontSize: '0.75rem' }}>
            Flights whose return times weren’t captured are always kept — a return-time filter
            won’t silently hide them.
          </p>
        </div>
      </div>
    </aside>
  );
}
