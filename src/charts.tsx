import type { Display, Snapshot } from './types';
import { categoryColor, categoryLabel, type Category } from './types';
import { fmt, snapshotValue } from './calc';

export function Donut({ totals, display }: { totals: Record<Category, number>; display: Display }) {
  const entries = (Object.entries(totals) as [Category, number][]).filter(([, v]) => v > 0);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  const R = 52, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div class="donut">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Allocation by category">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--line)" stroke-width="18" />
        {entries.map(([c, v]) => {
          const len = (v / sum) * C;
          const el = (
            <circle cx="70" cy="70" r={R} fill="none" stroke={categoryColor(c)} stroke-width="18"
              stroke-dasharray={`${Math.max(len - 1.5, 0)} ${C}`} stroke-dashoffset={-offset} transform="rotate(-90 70 70)" />
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul class="legend">
        {entries.map(([c, v]) => (
          <li>
            <span class="dot" style={{ background: categoryColor(c) }} />
            <span>{categoryLabel(c)}</span>
            <b>{Math.round((v / sum) * 100)}%</b>
            <small>{fmt(v, display)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LineChart({ snaps, display }: { snaps: Snapshot[]; display: Display }) {
  if (snaps.length < 2) return <p class="muted">History builds up as you open the app each day. One point so far.</p>;
  const W = 320, H = 110, P = 6;
  const vals = snaps.map((s) => snapshotValue(s, display));
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pts = vals.map((v, i) => [P + (i / (vals.length - 1)) * (W - 2 * P), H - P - ((v - min) / span) * (H - 2 * P)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Net worth history">
        <path d={`${d} L${W - P} ${H} L${P} ${H} Z`} fill="var(--accent)" opacity="0.12" />
        <path d={d} fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />
      </svg>
      <div class="row between muted small">
        <span>{snaps[0].date}</span>
        <span>{snaps.at(-1)!.date}</span>
      </div>
    </div>
  );
}
