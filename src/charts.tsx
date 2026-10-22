import { useState } from 'preact/hooks';
import { CATEGORIES, categoryColor, categoryLabel, type Category, type Display } from './types';
import { fmt, fmtCompact, historyRows, type ViewRow } from './calc';

const sorted = (totals: Record<Category, number>) => CATEGORIES.map((c) => ({ ...c, value: totals[c.id] })).filter((c) => c.value > 0);

export function Donut({ totals, display, total }: { totals: Record<Category, number>; display: Display; total: number }) {
  const [hover, setHover] = useState<Category | null>(null);
  const entries = sorted(totals);
  const sum = entries.reduce((a, c) => a + c.value, 0) || 1;
  const R = 58, C = 2 * Math.PI * R;
  let offset = 0;
  const active = entries.find((e) => e.id === hover);
  return (
    <div class="donut">
      <div class="donut-wrap">
        <svg viewBox="0 0 150 150" width="150" height="150" role="img" aria-label="Allocation by category">
          {entries.map((c) => {
            const len = (c.value / sum) * C;
            const el = (
              <circle cx="75" cy="75" r={R} fill="none" stroke-width={hover === c.id ? 22 : 18}
                style={{ stroke: c.color, opacity: hover && hover !== c.id ? 0.35 : 1, transition: 'opacity .15s' }}
                stroke-dasharray={`${Math.max(len - 2, 0)} ${C}`} stroke-dashoffset={-offset} transform="rotate(-90 75 75)"
                onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)} onClick={() => setHover(hover === c.id ? null : c.id)} />
            );
            offset += len;
            return el;
          })}
        </svg>
        <div class="donut-center">
          <b class="num">{active ? `${Math.round((active.value / sum) * 100)}%` : fmtCompact(total)}</b>
          <span>{active ? active.label : display}</span>
        </div>
      </div>
      <ul class="legend">
        {entries.map((c) => (
          <li class={hover === c.id ? 'on' : ''} onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)} onClick={() => setHover(hover === c.id ? null : c.id)}>
            <span class="swatch" style={{ background: c.color }} />
            <span>{c.label}</span>
            <b class="num">{Math.round((c.value / sum) * 100)}%</b>
            <small class="num">{fmt(c.value, display)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StackedArea({ rows, display }: { rows: ReturnType<typeof historyRows>; display: Display }) {
  const [hover, setHover] = useState<number | null>(null);
  if (rows.length < 2)
    return <p class="muted small">History builds up as you open the app, one point per day. {rows.length === 1 ? 'First point saved today.' : ''}</p>;
  const W = 340, H = 170, L = 38, B = 20, T = 8, R = 8;
  const t0 = new Date(rows[0].date).getTime(), t1 = new Date(rows.at(-1)!.date).getTime();
  const x = (d: string) => L + ((new Date(d).getTime() - t0) / (t1 - t0 || 1)) * (W - L - R);
  const max = Math.max(...rows.map((r) => r.total)) || 1;
  const step = 10 ** Math.floor(Math.log10(max / 3));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step).find((s) => max / s <= 4) ?? step * 10;
  const top = Math.ceil(max / nice) * nice;
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const cats = CATEGORIES.map((c) => c.id).filter((c) => rows.some((r) => (r.byCat[c] ?? 0) > 0));
  let lower = rows.map(() => 0);
  const bands = cats.map((c) => {
    const upper = rows.map((r, i) => lower[i] + (r.byCat[c] ?? 0));
    const d = `${rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.date).toFixed(1)} ${y(upper[i]).toFixed(1)}`).join(' ')} ${rows.map((r, i) => `L${x(rows[rows.length - 1 - i].date).toFixed(1)} ${y(lower[rows.length - 1 - i]).toFixed(1)}`).join(' ')} Z`;
    lower = upper;
    return { c, d };
  });
  const ticks = Array.from({ length: Math.round(top / nice) + 1 }, (_, i) => i * nice);
  const onMove = (e: PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    rows.forEach((r, i) => { if (Math.abs(x(r.date) - px) < Math.abs(x(rows[best].date) - px)) best = i; });
    setHover(best);
  };
  const h = hover != null ? rows[hover] : null;
  const hx = h ? x(h.date) : 0;
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Net worth history by category" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} style={{ stroke: 'var(--grid)' }} stroke-width="1" />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="10" style={{ fill: 'var(--muted)' }}>{fmtCompact(v)}</text>
          </g>
        ))}
        {bands.map(({ c, d }) => <path d={d} style={{ fill: categoryColor(c), stroke: 'var(--surface)' }} stroke-width="2" stroke-linejoin="round" />)}
        <text x={L} y={H - 4} font-size="10" style={{ fill: 'var(--muted)' }}>{rows[0].date.slice(5)}</text>
        <text x={W - R} y={H - 4} font-size="10" text-anchor="end" style={{ fill: 'var(--muted)' }}>{rows.at(-1)!.date.slice(5)}</text>
        {h && (
          <g>
            <line x1={hx} x2={hx} y1={T} y2={H - B} style={{ stroke: 'var(--ink-2)' }} stroke-width="1" />
            <circle cx={hx} cy={y(h.total)} r="4.5" style={{ fill: 'var(--ink)', stroke: 'var(--surface)' }} stroke-width="2" />
          </g>
        )}
      </svg>
      {h && (
        <div class="tip" style={{ top: 4, [hx > W / 2 ? 'right' : 'left']: `${((hx > W / 2 ? W - hx : hx) / W) * 100 + 2}%` }}>
          <div class="muted" style="margin-bottom:4px">{h.date}</div>
          {cats.map((c) => (
            <div class="r"><span><i class="swatch" style={{ background: categoryColor(c) }} />{categoryLabel(c)}</span><b class="num">{fmtCompact(h.byCat[c] ?? 0)}</b></div>
          ))}
          <div class="r" style="margin-top:4px;border-top:1px solid var(--grid);padding-top:4px"><span>Total</span><b class="num">{fmt(h.total, display)}</b></div>
        </div>
      )}
    </div>
  );
}

export interface Bar { key: string; name: string; value: number; color: string; note?: string }

/** Horizontal bars, value at the tip; the largest bar sets the scale. */
export function Bars({ bars, display, share }: { bars: Bar[]; display: Display; share?: number }) {
  const max = Math.max(...bars.map((b) => b.value), 1);
  return (
    <div>
      {bars.map((b) => (
        <div class="hbar" title={`${b.name}: ${fmt(b.value, display)}${share ? ` (${((b.value / share) * 100).toFixed(1)}%)` : ''}`}>
          <span class="name">{b.name}</span>
          <span class="track">
            <span class="fill" style={{ width: `calc((100% - 84px) * ${b.value / max})`, background: b.color }} />
            <span class="val num">{fmtCompact(b.value)}{share ? <span class="muted"> · {((b.value / share) * 100).toFixed(0)}%</span> : null}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function StackBar({ parts, display }: { parts: { label: string; value: number; color: string }[]; display: Display }) {
  const sum = parts.reduce((a, p) => a + p.value, 0) || 1;
  const shown = parts.filter((p) => p.value > 0);
  return (
    <div>
      <div class="stackbar" role="img" aria-label="Currency exposure">
        {shown.map((p) => <div title={`${p.label}: ${fmt(p.value, display)}`} style={{ flex: p.value / sum, background: p.color }} />)}
      </div>
      <div class="chips" style="margin-top:10px">
        {shown.map((p) => (
          <span class="row small" style="gap:6px"><i class="swatch" style={{ background: p.color }} /><span class="muted">{p.label}</span><b class="num">{Math.round((p.value / sum) * 100)}%</b></span>
        ))}
      </div>
    </div>
  );
}

export const signed = (n: number, d: Display) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), d)}`;
const niceStep = (max: number) => { const s = 10 ** Math.floor(Math.log10((max || 1) / 2)); return [1, 2, 2.5, 5, 10].map((m) => m * s).find((x) => max / x <= 3) ?? s * 10; };

/**
 * One bar per day from a single zero line: gains stack up, losses stack down. With `colors` each bar is split into its
 * parts (accounts or sub-accounts); parts without a colour are folded into one grey "Other" segment.
 */
export function SplitBars({ rows, display, colors, onPick, picked }: { rows: ViewRow[]; display: Display; colors?: Record<string, string>; onPick?: (date: string) => void; picked?: string | null }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!rows.length) return null;
  const OTHER = 'var(--muted)';
  // segments per day: [color, value, label]
  const segs = rows.map((r) => {
    if (!colors || !r.parts.length) return [{ color: r.pl >= 0 ? 'var(--good)' : 'var(--bad)', v: r.pl, label: 'Total' }];
    const out: { color: string; v: number; label: string }[] = [];
    let other = 0;
    for (const p of r.parts) { if (colors[p.key]) out.push({ color: colors[p.key], v: p.pl, label: p.label }); else other += p.pl; }
    if (Math.abs(other) >= 0.005) out.push({ color: OTHER, v: other, label: 'Other' });
    return out;
  });
  const W = 340, H = 190, L = 42, R = 6, T = 14, B = 20;
  const sums = segs.map((s) => ({ up: s.filter((x) => x.v > 0).reduce((a, x) => a + x.v, 0), down: -s.filter((x) => x.v < 0).reduce((a, x) => a + x.v, 0) }));
  const max = Math.max(...sums.map((s) => Math.max(s.up, s.down)), 0.01);
  const step = niceStep(max), top = Math.ceil(max / step) * step;
  const y = (v: number) => T + (1 - (v + top) / (2 * top)) * (H - T - B);
  const slot = (W - L - R) / rows.length, bw = Math.min(22, Math.max(1.5, slot - 2));
  const x = (i: number) => L + slot * i + (slot - bw) / 2;
  const zero = y(0);
  const label = rows.length <= 45 && !colors;
  const best = rows.reduce((a, r, i) => (r.pl > rows[a].pl ? i : a), 0), worst = rows.reduce((a, r, i) => (r.pl < rows[a].pl ? i : a), 0);
  const onMove = (e: PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(rows.length - 1, Math.floor((px - L) / slot))));
  };
  const h = hover != null ? rows[hover] : null;
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Profit and loss per day" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}
        onClick={() => hover != null && onPick?.(rows[hover].date)}>
        {[-top, 0, top].map((v) => (
          <g>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} style={{ stroke: v === 0 ? 'var(--axis)' : 'var(--grid)' }} stroke-width="1" />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="10" style={{ fill: 'var(--muted)' }}>{v > 0 ? '+' : ''}{fmtCompact(v)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          let up = 0, down = 0;
          const dim = hover != null && hover !== i ? 0.45 : picked && picked !== r.date ? 0.55 : 1;
          const ups = segs[i].filter((s) => s.v > 0).sort((a, b) => b.v - a.v), downs = segs[i].filter((s) => s.v < 0).sort((a, b) => a.v - b.v);
          return (
            <g style={{ opacity: dim }}>
              {ups.map((s, k) => { const y0 = y(up), y1 = y(up + s.v); up += s.v; return <rect x={x(i)} y={y1} width={bw} height={Math.max(y0 - y1 - (ups.length > 1 ? 1 : 0), 1)} rx={k === ups.length - 1 ? 3 : 0} style={{ fill: s.color }} />; })}
              {downs.map((s, k) => { const y0 = y(-down), y1 = y(-down + s.v); down -= s.v; return <rect x={x(i)} y={y0 + (downs.length > 1 ? 1 : 0)} width={bw} height={Math.max(y1 - y0 - (downs.length > 1 ? 1 : 0), 1)} rx={k === downs.length - 1 ? 3 : 0} style={{ fill: s.color }} />; })}
            </g>
          );
        })}
        {label && [best, worst].filter((i, k, a) => a.indexOf(i) === k).map((i) => (
          <text x={x(i) + bw / 2} y={rows[i].pl >= 0 ? y(rows[i].pl) - 4 : y(rows[i].pl) + 12} text-anchor="middle" font-size="9" style={{ fill: 'var(--ink-2)' }}>{fmtCompact(rows[i].pl)}</text>
        ))}
        <text x={L} y={H - 4} font-size="10" style={{ fill: 'var(--muted)' }}>{rows[0].date.slice(5)}</text>
        <text x={W - R} y={H - 4} font-size="10" text-anchor="end" style={{ fill: 'var(--muted)' }}>{rows.at(-1)!.date.slice(5)}</text>
      </svg>
      {h && (
        <div class="tip" style={{ top: 2, [hover! > rows.length / 2 ? 'left' : 'right']: '6%' }}>
          <div class="muted">{h.date}</div>
          {colors && segs[hover!].length > 0 && segs[hover!][0].label !== 'Total' && [...segs[hover!]].sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, 6).map((s) => (
            <div class="r"><span><i class="swatch" style={{ background: s.color }} />{s.label}</span><span class="num">{s.v >= 0 ? '+' : '−'}{fmtCompact(Math.abs(s.v))}</span></div>
          ))}
          <div class="r" style={colors ? 'margin-top:4px;border-top:1px solid var(--grid);padding-top:4px' : ''}><span>{h.pl >= 0 ? '▲' : '▼'} Gain / loss</span><b class={`num ${h.pl >= 0 ? 'up' : 'down'}`}>{signed(h.pl, display)}</b></div>
          <div class="r"><span>Change</span><span class="num">{h.plPct >= 0 ? '+' : ''}{h.plPct.toFixed(2)}%</span></div>
          {Math.abs(h.flow) > 0.5 && <div class="r"><span>Added / removed</span><span class="num">{signed(h.flow, display)}</span></div>}
          <div class="r"><span>Value</span><span class="num">{fmt(h.nw, display)}</span></div>
        </div>
      )}
    </div>
  );
}

/** Running total of daily gains and losses, from a zero line. */
export function CumulativeLine({ points, display }: { points: { date: string; value: number }[]; display: Display }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return <p class="muted small">Needs at least two days.</p>;
  const W = 340, H = 130, L = 42, R = 8, T = 10, B = 20;
  const vals = points.map((p) => p.value);
  const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const x = (i: number) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / span) * (H - T - B);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const onMove = (e: PointerEvent) => {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    setHover(Math.max(0, Math.min(points.length - 1, Math.round((((e.clientX - box.left) / box.width) * W - L) / ((W - L - R) / (points.length - 1))))));
  };
  const last = points.at(-1)!;
  const h = hover != null ? points[hover] : null;
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative gain or loss" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {[lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i).map((v) => (
          <g>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} style={{ stroke: v === 0 ? 'var(--axis)' : 'var(--grid)' }} stroke-width="1" />
            <text x={L - 6} y={y(v) + 4} text-anchor="end" font-size="10" style={{ fill: 'var(--muted)' }}>{v > 0 ? '+' : ''}{fmtCompact(v)}</text>
          </g>
        ))}
        <path d={`${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`} style={{ fill: 'var(--accent)' }} opacity="0.1" />
        <path d={line} fill="none" style={{ stroke: 'var(--accent)' }} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx={x(h ? hover! : points.length - 1)} cy={y((h ?? last).value)} r="4.5" style={{ fill: 'var(--accent)', stroke: 'var(--surface)' }} stroke-width="2" />
        <text x={L} y={H - 4} font-size="10" style={{ fill: 'var(--muted)' }}>{points[0].date.slice(5)}</text>
        <text x={W - R} y={H - 4} font-size="10" text-anchor="end" style={{ fill: 'var(--muted)' }}>{last.date.slice(5)}</text>
      </svg>
      {h && (
        <div class="tip" style={{ top: 2, [hover! > points.length / 2 ? 'left' : 'right']: '6%' }}>
          <div class="muted">{h.date}</div>
          <div class="r"><span>Total so far</span><b class={`num ${h.value >= 0 ? 'up' : 'down'}`}>{signed(h.value, display)}</b></div>
        </div>
      )}
    </div>
  );
}
