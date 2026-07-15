// Add / edit / remove trip patterns: outbound weekday + time window, return weekday
// + time window (all New York local). Each pattern is live-validated with the shared
// contract; an invalid one (e.g. end before start) shows why and blocks Save upstream.
import type { Pattern } from '../lib/types.ts';
import { patternError } from '../lib/settingsSchema.ts';
import { WEEKDAY_NAMES } from '../lib/timezone.ts';

interface Props {
  patterns: Pattern[];
  onChange: (next: Pattern[]) => void;
}

function WeekdaySelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {WEEKDAY_NAMES.map((name, i) => (
          <option value={i} key={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

function TimeWindow({
  label,
  start,
  end,
  onStart,
  onEnd,
}: {
  label: string;
  start: string | null;
  end: string | null;
  onStart: (v: string | null) => void;
  onEnd: (v: string | null) => void;
}) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 560 }}>
        {label} <span className="muted">(blank = any time)</span>
      </legend>
      <div className="leg-times">
        <input
          type="time"
          aria-label={`${label} from`}
          value={start ?? ''}
          onChange={(e) => onStart(e.target.value || null)}
        />
        <input
          type="time"
          aria-label={`${label} until`}
          value={end ?? ''}
          onChange={(e) => onEnd(e.target.value || null)}
        />
      </div>
    </fieldset>
  );
}

export function PatternEditor({ patterns, onChange }: Props) {
  const update = (i: number, patch: Partial<Pattern>) =>
    onChange(patterns.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const remove = (i: number) => onChange(patterns.filter((_, idx) => idx !== i));
  const add = () =>
    onChange([
      ...patterns,
      {
        outbound_weekday: 4,
        outbound_start: null,
        outbound_end: null,
        return_weekday: 6,
        return_start: null,
        return_end: null,
      },
    ]);

  return (
    <div className="stack" style={{ gap: '0.8rem' }}>
      {patterns.map((p, i) => {
        const err = patternError(p);
        return (
          <div className="pattern" key={i}>
            <div className="row-between">
              <span className="field-label">Pattern {i + 1}</span>
              <button
                className="btn btn-ghost"
                onClick={() => remove(i)}
                aria-label={`Remove pattern ${i + 1}`}
              >
                Remove
              </button>
            </div>
            <div className="pattern-legs">
              <div className="stack" style={{ gap: '0.5rem' }}>
                <WeekdaySelect
                  id={`ob-wd-${i}`}
                  label="Outbound weekday"
                  value={p.outbound_weekday}
                  onChange={(v) => update(i, { outbound_weekday: v })}
                />
                <TimeWindow
                  label="Outbound window"
                  start={p.outbound_start}
                  end={p.outbound_end}
                  onStart={(v) => update(i, { outbound_start: v })}
                  onEnd={(v) => update(i, { outbound_end: v })}
                />
              </div>
              <div className="stack" style={{ gap: '0.5rem' }}>
                <WeekdaySelect
                  id={`rt-wd-${i}`}
                  label="Return weekday"
                  value={p.return_weekday}
                  onChange={(v) => update(i, { return_weekday: v })}
                />
                <TimeWindow
                  label="Return window"
                  start={p.return_start}
                  end={p.return_end}
                  onStart={(v) => update(i, { return_start: v })}
                  onEnd={(v) => update(i, { return_end: v })}
                />
              </div>
            </div>
            {err && (
              <span className="error" role="alert">
                {err}
              </span>
            )}
          </div>
        );
      })}
      <div>
        <button className="btn" onClick={add}>
          + Add pattern
        </button>
      </div>
    </div>
  );
}
