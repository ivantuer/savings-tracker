import { useState } from 'preact/hooks';
import { state } from './store';
import { CATEGORIES, categoryColor, type Category } from './types';
import { RANGES, cumulativePl, dailyRows, dailySummary, fmt, fmtCompact, rowsIn, topMovers, type DayRow, type Range } from './calc';
import { CumulativeLine, DailyBars, signed } from './charts';

const sign = (n: number) => (n >= 0 ? 'up' : 'down');
const arrow = (n: number) => (n >= 0 ? '▲' : '▼');

export function DailyView() {
  const s = state.value;
  const d = s.settings.display;
  const [range, setRange] = useState<Range>('30D');
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(14);
  const all = dailyRows(s, d);
  const rows = rowsIn(all, range);
  const sum = dailySummary(rows);

  const posName = (id: string) => {
    const p = s.positions.find((x) => x.id === id);
    if (!p) return 'Removed position';
    const w = s.wallets.find((x) => x.id === p.walletId);
    return `${p.type === 'fiat' ? p.name : (p.symbol ?? p.name)}${w ? ` · ${w.name}` : ''}`;
  };

  if (!all.length)
    return (
      <div class="card">
        <h2>Daily gains and losses</h2>
        <p class="muted">
          This builds up from the days you open the app: one snapshot a day, so the first day-to-day numbers appear after your second day. Money you add or remove by hand is kept apart from market moves, so a deposit never looks like a profit.
        </p>
        <p class="muted small">Snapshots so far: {s.snapshots.length}</p>
      </div>
    );

  const catTotals = CATEGORIES.map((c) => ({ ...c, pl: rows.reduce((a, r) => a + (r.byCat[c.id] ?? 0), 0) })).filter((c) => Math.abs(c.pl) >= 0.005);
  const movers = topMovers(rows);
  const gainers = movers.filter((m) => m.pl > 0).slice(0, 5);
  const losers = movers.filter((m) => m.pl < 0).sort((a, b) => a.pl - b.pl).slice(0, 5);
  const latest = rows.at(-1);
  const list = [...rows].reverse();

  return (
    <>
      <div class="card">
        <div class="row between">
          <h2 style="margin:0">Daily gains and losses</h2>
          <div class="seg small">{RANGES.filter((x) => x !== '1D').map((x) => <button class={range === x ? 'on' : ''} onClick={() => setRange(x)}>{x}</button>)}</div>
        </div>
        {sum ? (
          <>
            <div class={`hero num ${sign(sum.total)}`} style="font-size:40px">{arrow(sum.total)} {signed(sum.total, d)}</div>
            <div class="muted small">
              <span class={`num ${sign(sum.totalPct)}`}>{sum.totalPct >= 0 ? '+' : ''}{sum.totalPct.toFixed(2)}%</span> over {sum.days} {sum.days === 1 ? 'day' : 'days'}, market moves only
              {Math.abs(sum.flow) > 0.5 && <> · money added or removed: <span class="num">{signed(sum.flow, d)}</span></>}
            </div>
          </>
        ) : <p class="muted small">No days in this range yet.</p>}
      </div>

      {sum && (
        <div class="tiles">
          <div class="card">
            <div class="tile-label">Latest day · {latest!.date.slice(5)}</div>
            <div class={`tile-value num ${sign(latest!.pl)}`}>{arrow(latest!.pl)} {fmtCompact(Math.abs(latest!.pl))}</div>
            <div class="small muted num">{latest!.plPct >= 0 ? '+' : ''}{latest!.plPct.toFixed(2)}%</div>
          </div>
          <div class="card">
            <div class="tile-label">Average per day</div>
            <div class={`tile-value num ${sign(sum.avg)}`}>{arrow(sum.avg)} {fmtCompact(Math.abs(sum.avg))}</div>
            <div class="small muted">{Math.round(sum.winRate)}% of days up</div>
          </div>
          <div class="card">
            <div class="tile-label">Best day · {sum.best.date.slice(5)}</div>
            <div class="tile-value num up">▲ {fmtCompact(sum.best.pl)}</div>
            <div class="small muted num">{sum.best.plPct >= 0 ? '+' : ''}{sum.best.plPct.toFixed(2)}%</div>
          </div>
          <div class="card">
            <div class="tile-label">Worst day · {sum.worst.date.slice(5)}</div>
            <div class={`tile-value num ${sign(sum.worst.pl)}`}>{arrow(sum.worst.pl)} {fmtCompact(Math.abs(sum.worst.pl))}</div>
            <div class="small muted num">{sum.worst.plPct >= 0 ? '+' : ''}{sum.worst.plPct.toFixed(2)}%</div>
          </div>
        </div>
      )}

      <div class="card"><h2>Gain or loss per day</h2><DailyBars rows={rows} display={d} picked={open} onPick={(date) => { setOpen(date); setShown(Math.max(shown, 14)); document.getElementById(`day-${date}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} /></div>

      <div class="card"><h2>Running total</h2><CumulativeLine points={cumulativePl(rows)} display={d} /></div>

      {catTotals.length > 0 && (
        <div class="card">
          <h2>By category</h2>
          {catTotals.map((c) => (
            <div class="item" style="cursor:default">
              <div class="row"><span class="swatch" style={{ background: c.color }} />{c.label}</div>
              <div class={`r num ${sign(c.pl)}`}>{arrow(c.pl)} {signed(c.pl, d)}</div>
            </div>
          ))}
        </div>
      )}

      {(gainers.length > 0 || losers.length > 0) && (
        <div class="card">
          <h2>Biggest movers</h2>
          {[...gainers, ...losers].map((m) => (
            <div class="item" style="cursor:default">
              <div class="l"><div>{posName(m.id)}</div></div>
              <div class={`r num ${sign(m.pl)}`}>{arrow(m.pl)} {signed(m.pl, d)}</div>
            </div>
          ))}
        </div>
      )}

      <div class="card">
        <h2>Day by day</h2>
        {list.slice(0, shown).map((r) => <DayItem r={r} open={open === r.date} toggle={() => setOpen(open === r.date ? null : r.date)} posName={posName} />)}
        {list.length > shown && <button class="ghost" style="width:100%;margin-top:10px" onClick={() => setShown(shown + 14)}>Show more days</button>}
      </div>
    </>
  );
}

function DayItem({ r, open, toggle, posName }: { r: DayRow; open: boolean; toggle: () => void; posName: (id: string) => string }) {
  const d = state.value.settings.display;
  const cats = (Object.entries(r.byCat) as [Category, number][]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return (
    <div id={`day-${r.date}`} style="border-top:1px solid var(--grid)">
      <div class="item" style="border-top:0" onClick={toggle}>
        <div class="l">
          <div>{r.date}</div>
          <div class="muted small num">{fmt(r.nw, d)}{Math.abs(r.flow) > 0.5 ? ` · ${r.flow > 0 ? 'added' : 'removed'} ${fmt(Math.abs(r.flow), d)}` : ''}</div>
        </div>
        <div class={`r num ${sign(r.pl)}`}>
          <b>{arrow(r.pl)} {signed(r.pl, d)}</b>
          <div class="small">{r.plPct >= 0 ? '+' : ''}{r.plPct.toFixed(2)}%</div>
        </div>
      </div>
      {open && (
        <div style="padding:0 0 12px">
          {cats.length > 0 && (
            <div class="chips" style="margin:0 0 8px">
              {cats.map(([c, v]) => (
                <span class="chip" style="cursor:default"><i class="swatch" style={{ background: categoryColor(c), display: 'inline-block', marginRight: '6px' }} />{CATEGORIES.find((x) => x.id === c)!.label} <b class={`num ${sign(v)}`}>{arrow(v)} {fmtCompact(Math.abs(v))}</b></span>
              ))}
            </div>
          )}
          {r.movers.slice(0, 4).map((m) => (
            <div class="row between small" style="padding:3px 0"><span class="muted">{posName(m.id)}</span><span class={`num ${sign(m.pl)}`}>{arrow(m.pl)} {signed(m.pl, d)}</span></div>
          ))}
          {r.movers.length === 0 && cats.length === 0 && <p class="muted small" style="margin:0">No detail recorded for this day.</p>}
        </div>
      )}
    </div>
  );
}
