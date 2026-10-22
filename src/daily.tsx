import { useState } from 'preact/hooks';
import { deleteIncome, state } from './store';
import { CATEGORIES, categoryColor, type Category } from './types';
import { RANGES, cumulativePl, dailyRows, dailySummary, dividendStats, fmtCompact, partTotals, rowsIn, topMovers, viewRows, positionLabel, fmt, type Range, type ViewRow } from './calc';
import { CumulativeLine, MonthBars, SplitBars, signed } from './charts';

const sign = (n: number) => (n >= 0 ? 'up' : 'down');
const arrow = (n: number) => (n >= 0 ? '▲' : '▼');
/** The five categorical slots, then everything else folds into one grey "Other". */
const SLOTS = ['var(--c-cash)', 'var(--c-crypto)', 'var(--c-stocks)', 'var(--c-inzhur)', 'var(--c-ovdp)'];
const saved = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* not available */ } };

export function DailyView() {
  const s = state.value;
  const d = s.settings.display;
  const [range, setRange] = useState<Range>('30D');
  const [scope, setScope] = useState(saved('daily-scope', 'all'));
  const [split, setSplit] = useState(saved('daily-split', 'on') === 'on');
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(14);
  const all = dailyRows(s, d);
  const wallet = s.wallets.find((w) => w.id === scope);
  const effectiveScope = wallet ? scope : 'all';
  const { rows: scoped, missing } = viewRows(all, s, effectiveScope);
  const rows = rowsIn(scoped, range);
  const sum = dailySummary(rows);

  const posName = (id: string) => {
    const p = s.positions.find((x) => x.id === id);
    if (!p) return 'Removed position';
    const w = s.wallets.find((x) => x.id === p.walletId);
    return `${positionLabel(p)}${w ? ` · ${w.name}` : ''}`;
  };

  if (!all.length)
    return (
      <>
        <div class="card">
          <h2>Daily gains and losses</h2>
          <p class="muted">
            This builds up from the days you open the app: one snapshot a day, so the first day-to-day numbers appear after your second day. Money you add or remove by hand is kept apart from market moves, so a deposit never looks like a profit.
          </p>
          <p class="muted small">Snapshots so far: {s.snapshots.length}</p>
        </div>
        <Dividends />
      </>
    );

  // colours by rank within what is on screen
  const totals = partTotals(rows);
  const colors: Record<string, string> = {};
  totals.slice(0, SLOTS.length).forEach((p, i) => { colors[p.key] = SLOTS[i]; });
  const otherTotal = totals.slice(SLOTS.length).reduce((a, p) => a + p.pl, 0);
  const legend = [...totals.slice(0, SLOTS.length).map((p) => ({ label: p.label, pl: p.pl, color: colors[p.key] })), ...(totals.length > SLOTS.length ? [{ label: `Other (${totals.length - SLOTS.length})`, pl: otherTotal, color: 'var(--muted)' }] : [])];
  const withParts = wallets(s).filter((w) => s.positions.some((p) => p.walletId === w.id && !p.credit));
  const catTotals = CATEGORIES.map((c) => ({ ...c, pl: rows.reduce((a, r) => a + (r.byCat[c.id] ?? 0), 0) })).filter((c) => Math.abs(c.pl) >= 0.005);
  const movers = topMovers(rows);
  const gainers = movers.filter((m) => m.pl > 0).slice(0, 5);
  const losers = movers.filter((m) => m.pl < 0).sort((a, b) => a.pl - b.pl).slice(0, 5);
  const latest = rows.at(-1);
  const list = [...rows].reverse();
  const title = wallet ? wallet.name : 'All accounts';

  const colorFor = (key: string) => colors[key] ?? 'var(--muted)';

  return (
    <>
      <div class="card">
        <div class="row between" style="margin-bottom:10px">
          <h2 style="margin:0">Daily gains and losses</h2>
          <div class="seg small">{RANGES.filter((x) => x !== '1D').map((x) => <button class={range === x ? 'on' : ''} onClick={() => setRange(x)}>{x}</button>)}</div>
        </div>
        <label style="margin-top:0">Account</label>
        <select value={effectiveScope} onChange={(e) => { setScope(e.currentTarget.value); save('daily-scope', e.currentTarget.value); setOpen(null); setShown(14); }}>
          <option value="all">All accounts</option>
          {CATEGORIES.map((c) => {
            const ws = withParts.filter((w) => w.category === c.id);
            return ws.length ? <optgroup label={c.label}>{ws.map((w) => <option value={w.id}>{w.name}</option>)}</optgroup> : null;
          })}
        </select>
        {wallet && missing > 0 && <p class="muted small" style="margin:8px 0 0">Account detail starts after the app began keeping per-position values, so {missing} earlier {missing === 1 ? 'day is' : 'days are'} left out here.</p>}
        {sum ? (
          <>
            <div class={`hero num ${sign(sum.total)}`} style="font-size:40px;margin-top:10px">{arrow(sum.total)} {signed(sum.total, d)}</div>
            <div class="muted small">
              {title} · <span class={`num ${sign(sum.totalPct)}`}>{sum.totalPct >= 0 ? '+' : ''}{sum.totalPct.toFixed(2)}%</span> over {sum.days} {sum.days === 1 ? 'day' : 'days'}, market moves only
              {Math.abs(sum.flow) > 0.5 && <> · money added or removed: <span class="num">{signed(sum.flow, d)}</span></>}
            </div>
            {sum.dividends > 0.5 && (
              <div class="row small" style="margin-top:8px;gap:16px"><span>Price changes <b class={`num ${sign(sum.total - sum.dividends)}`}>{signed(sum.total - sum.dividends, d)}</b></span><span>Dividends <b class="num up">{signed(sum.dividends, d)}</b></span></div>
            )}
          </>
        ) : <p class="muted small" style="margin-top:10px">No days in this range yet.</p>}
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

      <div class="card">
        <div class="row between" style="margin-bottom:10px">
          <h2 style="margin:0">Gain or loss per day</h2>
          <div class="seg small"><button class={split ? 'on' : ''} onClick={() => { setSplit(true); save('daily-split', 'on'); }}>Split</button><button class={!split ? 'on' : ''} onClick={() => { setSplit(false); save('daily-split', 'off'); }}>Total</button></div>
        </div>
        <SplitBars rows={rows} display={d} colors={split ? colors : undefined} picked={open}
          onPick={(date) => { setOpen(date); setShown(Math.max(shown, 14)); document.getElementById(`day-${date}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }} />
        {split && legend.length > 0 && (
          <div style="margin-top:10px">
            <div class="muted small" style="margin-bottom:4px">{wallet ? `Sub-accounts in ${wallet.name}` : 'By account'}, whole range</div>
            {legend.map((l) => (
              <div class="row between small" style="padding:4px 0">
                <span class="row" style="gap:8px"><i class="swatch" style={{ background: l.color }} />{l.label}</span>
                <span class={`num ${sign(l.pl)}`}>{arrow(l.pl)} {signed(l.pl, d)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div class="card"><h2>Running total</h2><CumulativeLine points={cumulativePl(rows)} display={d} /></div>

      {!wallet && catTotals.length > 0 && (
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

      {!wallet && (gainers.length > 0 || losers.length > 0) && (
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

      <Dividends />

      <div class="card">
        <h2>Day by day · {title}</h2>
        {list.slice(0, shown).map((r) => <DayItem r={r} open={open === r.date} toggle={() => setOpen(open === r.date ? null : r.date)} colorFor={colorFor} />)}
        {list.length > shown && <button class="ghost" style="width:100%;margin-top:10px" onClick={() => setShown(shown + 14)}>Show more days</button>}
      </div>
    </>
  );
}

const wallets = (s: { wallets: { id: string; name: string; category: Category }[] }) => s.wallets;

function DayItem({ r, open, toggle, colorFor }: { r: ViewRow; open: boolean; toggle: () => void; colorFor: (key: string) => string }) {
  const d = state.value.settings.display;
  const cats = (Object.entries(r.byCat) as [Category, number][]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const parts = [...r.parts].sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl));
  return (
    <div id={`day-${r.date}`} style="border-top:1px solid var(--grid)">
      <div class="item" style="border-top:0" onClick={toggle}>
        <div class="l">
          <div>{r.date}</div>
          <div class="muted small num">{fmt(r.nw, d)}{Math.abs(r.flow) > 0.5 ? ` · ${r.flow > 0 ? 'added' : 'removed'} ${fmt(Math.abs(r.flow), d)}` : ''}{r.income > 0.5 ? ` · incl. dividends ${fmt(r.income, d)}` : ''}</div>
        </div>
        <div class={`r num ${sign(r.pl)}`}>
          <b>{arrow(r.pl)} {signed(r.pl, d)}</b>
          <div class="small">{r.plPct >= 0 ? '+' : ''}{r.plPct.toFixed(2)}%</div>
        </div>
      </div>
      {open && (
        <div style="padding:0 0 12px">
          {parts.map((p) => (
            <div class="row between small" style="padding:3px 0"><span class="row" style="gap:8px"><i class="swatch" style={{ background: colorFor(p.key) }} /><span>{p.label}</span></span><span class={`num ${sign(p.pl)}`}>{arrow(p.pl)} {signed(p.pl, d)}</span></div>
          ))}
          {parts.length === 0 && cats.length > 0 && (
            <div class="chips" style="margin:0">
              {cats.map(([c, v]) => (
                <span class="chip" style="cursor:default"><i class="swatch" style={{ background: categoryColor(c), display: 'inline-block', marginRight: '6px' }} />{CATEGORIES.find((x) => x.id === c)!.label} <b class={`num ${sign(v)}`}>{arrow(v)} {fmtCompact(Math.abs(v))}</b></span>
              ))}
            </div>
          )}
          {parts.length === 0 && cats.length === 0 && <p class="muted small" style="margin:0">No detail recorded for this day.</p>}
        </div>
      )}
    </div>
  );
}

function Dividends() {
  const s = state.value;
  const d = s.settings.display;
  const st = dividendStats(s, d);
  const [all, setAll] = useState(false);
  return (
    <div class="card">
      <h2>Dividends</h2>
      {st.items.length === 0 ? (
        <p class="muted small" style="margin:0">
          Nothing recorded yet. When a dividend arrives, open the position and use "Record a reinvested dividend", or raise the amount and choose "Dividend / income". It then counts as profit and shows up here.
        </p>
      ) : (
        <>
          <div class="row between" style="margin-bottom:6px">
            <div><div class="tile-label">Received so far</div><div class="tile-value num up">{fmt(st.total, d)}</div></div>
            <div style="text-align:right"><div class="tile-label">Average per month</div><div class="tile-value num">{fmt(st.avgPerMonth, d)}</div></div>
          </div>
          <MonthBars months={st.months} display={d} />
          <div class="muted small" style="margin:10px 0 4px">By source</div>
          {st.bySource.map((x) => (
            <div class="row between small" style="padding:3px 0"><span>{x.label} <span class="muted">· {x.count}×</span></span><span class="num up">{fmt(x.value, d)}</span></div>
          ))}
          <div class="muted small" style="margin:10px 0 4px">Entries</div>
          {(all ? st.items : st.items.slice(0, 6)).map((i) => (
            <div class="row between small" style="padding:4px 0">
              <span class="muted">{i.at.slice(0, 10)}</span>
              <span class="row" style="gap:10px"><span class="num up">+{fmt(i.value, d)}</span><button class="link" aria-label="Delete entry" onClick={() => { if (confirm('Delete this dividend entry? Your balance stays as it is.')) deleteIncome(i.id); }}>✕</button></span>
            </div>
          ))}
          {st.items.length > 6 && <button class="ghost" style="width:100%;margin-top:8px" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${st.items.length}`}</button>}
        </>
      )}
    </div>
  );
}
