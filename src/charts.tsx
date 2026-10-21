import { useState } from 'preact/hooks';
import { CATEGORIES, categoryColor, categoryLabel, type Category, type Display } from './types';
import { fmt, fmtCompact, historyRows } from './calc';

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
