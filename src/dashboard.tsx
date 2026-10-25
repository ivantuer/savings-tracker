import { useState } from 'preact/hooks';
import { state, refreshError } from './store';
import { CATEGORIES, categoryColor, type Display } from './types';
import { RANGES, monoMid, realReturn, categoryTotals, convert, creditRows, daysAgo, exposure, fmt, fmtCompact, historyRows, holdings, netWorth, periodChange, pnlSummary, ratesOf, snapshotsIn, walletTotal, type Range } from './calc';
import { Bars, Donut, StackBar, StackedArea } from './charts';
import { downloadSellReminder } from './ics';

const OTHERS: Record<Display, Display[]> = { UAH: ['USD', 'USDT'], USD: ['UAH', 'USDT'], USDT: ['UAH', 'USD'] };

export function Dashboard({ goWallet }: { goWallet: (id: string) => void }) {
  const s = state.value;
  const d = s.settings.display;
  const [range, setRange] = useState<Range>('30D');
  if (!s.positions.length)
    return (
      <div class="card">
        <h2>Welcome</h2>
        <p class="muted">Start in the Wallets tab: add a wallet (an exchange, Inzhur, a card…), then add what it holds. Or import a backup in Settings.</p>
      </div>
    );

  const total = netWorth(s, d);
  const totals = categoryTotals(s, d);
  const ch = periodChange(s, d, range);
  const r = ratesOf(s);
  const all = holdings(s, d);
  const pnl = pnlSummary(s, d);
  const exp = exposure(s, d);
  const rows = historyRows(snapshotsIn(s, range), d);
  const walletBars = s.wallets
    .map((w) => ({ key: w.id, name: w.name, value: walletTotal(w.id, s, d), color: categoryColor(w.category) }))
    .filter((b) => b.value > 0)
    .sort((a, b) => b.value - a.value);
  const topBars = all.slice(0, 8).map((h) => ({ key: h.position.id, name: h.position.type === 'fiat' ? h.wallet.name : `${h.position.symbol ?? h.position.name} · ${h.wallet.name}`, value: h.value, color: categoryColor(h.wallet.category) }));
  const ageDays = s.prices.fetchedAt ? daysAgo(s.prices.fetchedAt) : null;

  return (
    <>
      <div class="card">
        <div class="row between">
          <span class="muted small">Net worth</span>
          <div class="seg small">{RANGES.map((x) => <button class={range === x ? 'on' : ''} onClick={() => setRange(x)}>{x}</button>)}</div>
        </div>
        <Hero text={fmt(total, d)} />
        {ch ? (
          <div class="row" style="gap:10px;flex-wrap:wrap">
            <span class={`delta num ${ch.delta >= 0 ? 'up' : 'down'}`}>{ch.delta >= 0 ? '▲ +' : '▼ −'}{Math.abs(ch.pct).toFixed(1)}%</span>
            <span class="small num">{ch.delta >= 0 ? '+' : '−'}{fmt(Math.abs(ch.delta), d)} <span class="muted">since {ch.since}{Math.abs(ch.flow) > 0.5 && ` · excludes ${fmt(Math.abs(ch.flow), d)} ${ch.flow > 0 ? 'added' : 'removed'} by you`}</span></span>
          </div>
        ) : (
          <div class="muted small">Change appears after the next daily snapshot</div>
        )}
        <div class="muted small num" style="margin-top:8px">
          {OTHERS[d].map((o) => fmt(convert(total, d, o, r), o)).join(' · ')}
        </div>
        <div class="muted small" style="margin-top:2px">
          1 USD = ₴{r.usdUah.toFixed(2)} ({s.settings.uahRate === 'market' && monoMid(s) ? 'Monobank' : 'NBU'}) · 1 USDT = ₴{r.usdtUah.toFixed(2)}
          {ageDays != null && ageDays > 0 && <span class="stale"> · prices {ageDays}d old</span>}
        </div>
        {refreshError.value && <div class="err">Some prices failed to refresh; showing the last known ones.</div>}
      </div>

      <CreditCard goWallet={goWallet} />

      <div class="card"><h2>Allocation</h2><Donut totals={totals} display={d} total={total} /></div>

      <div class="card">
        <h2>History</h2>
        <StackedArea rows={rows} display={d} />
        <div class="chips" style="margin-top:8px">
          {CATEGORIES.filter((c) => totals[c.id] > 0).map((c) => <span class="row small" style="gap:6px"><i class="swatch" style={{ background: c.color }} /><span class="muted">{c.label}</span></span>)}
        </div>
      </div>

      <RealReturnCard range={range} />

      <div class="card"><h2>Top holdings</h2><Bars bars={topBars} display={d} share={total} /></div>

      <div class="tiles">
        <div class="card">
          <div class="tile-label">Unrealized P&L</div>
          {pnl.count ? (
            <>
              <div class={`tile-value num ${pnl.pnl >= 0 ? 'up' : 'down'}`}>{pnl.pnl >= 0 ? '▲ +' : '▼ −'}{fmtCompact(Math.abs(pnl.pnl))}</div>
              <div class="small muted num">{pnl.pct >= 0 ? '+' : ''}{pnl.pct.toFixed(1)}% on {fmtCompact(pnl.cost)} · {pnl.count} positions</div>
            </>
          ) : <div class="small muted">Add a cost to positions to see P&L</div>}
        </div>
        <div class="card">
          <div class="tile-label">Assets / wallets</div>
          <div class="tile-value num">{all.length}</div>
          <div class="small muted">positions in {s.wallets.length} wallets</div>
        </div>
      </div>

      {(pnl.best.length > 0 || pnl.worst.length > 0) && (
        <div class="card">
          <h2>Winners & losers</h2>
          {[...pnl.best, ...pnl.worst].map((h) => (
            <div class="item" style="cursor:default">
              <div class="l"><div>{h.position.symbol ?? h.position.name}</div><div class="muted small">{h.wallet.name}</div></div>
              <div class={`r num ${h.pnl! >= 0 ? 'up' : 'down'}`}>
                <b>{h.pnl! >= 0 ? '▲ +' : '▼ −'}{fmt(Math.abs(h.pnl!), d)}</b>
                <div class="small">{h.pnl! >= 0 ? '+' : ''}{((h.pnl! / h.cost!) * 100).toFixed(1)}%</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div class="card">
        <h2>Currency exposure</h2>
        <StackBar display={d} parts={[
          { label: 'UAH', value: exp.uah, color: 'var(--accent)' },
          { label: 'USD-linked (USD, USDT, crypto, stocks)', value: exp.usd, color: 'var(--ink-2)' },
          { label: 'EUR', value: exp.eur, color: 'var(--axis)' },
        ]} />
      </div>

      <div class="card"><h2>Wallets</h2><Bars bars={walletBars} display={d} share={total} /></div>

      <div class="card">
        <h2>By category</h2>
        {CATEGORIES.map((c) => (
          <div class="item" style="cursor:default">
            <div class="row"><span class="swatch" style={{ background: c.color }} />{c.label}</div>
            <div class="r num">{fmt(totals[c.id], d)}</div>
          </div>
        ))}
        <div class="item" style="cursor:default;font-weight:700">
          <div>Total</div>
          <div class="r num">{fmt(total, d)}</div>
        </div>
      </div>
    </>
  );
}

function CreditCard({ goWallet }: { goWallet: (id: string) => void }) {
  const s = state.value;
  const d = s.settings.display;
  const rows = creditRows(s, d);
  if (!rows.length) return null;
  const owed = rows.reduce((a, r) => a + r.owed, 0);
  const value = rows.reduce((a, r) => a + r.value, 0);
  return (
    <div class="card">
      <h2 style="margin-bottom:2px">Credit-funded ОВДП</h2>
      <div class="muted small" style="margin-bottom:8px">Not counted in net worth until you cash out.</div>
      <div class="muted small" style="margin-bottom:6px">
        Worth <span class="num">{fmt(value, d)}</span> · owed <span class="num">{fmt(owed, d)}</span> · if sold now <b class={`num ${value - owed >= 0 ? 'up' : 'down'}`}>{value - owed >= 0 ? '▲ +' : '▼ −'}{fmt(Math.abs(value - owed), d)}</b>
      </div>
      {rows.map(({ position: p, value: v, owed: o, days }) => (
        <div class="item" onClick={() => goWallet(p.walletId)}>
          <div class="l">
            <div>{p.name}</div>
            <div class={days <= 7 ? 'neg small' : 'muted small'}>
              {days < 0 ? `${-days}d overdue` : days === 0 ? 'sell today' : `${days}d left`} · by {p.credit!.sellBy}{p.credit!.bank ? ` · ${p.credit!.bank}` : ''}
            </div>
          </div>
          <div class="r">
            <div class="num">{fmt(v, d)}</div>
            <div class={`small num ${v - o >= 0 ? 'pos' : 'neg'}`}>{v - o >= 0 ? '▲ +' : '▼ −'}{fmt(Math.abs(v - o), d)}</div>
            <button class="link small" onClick={(e) => { e.stopPropagation(); downloadSellReminder(p); }}>🔔 Remind me</button>
          </div>
        </div>
      ))}
    </div>
  );
}

const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
const tone = (x: number) => (x >= 0 ? 'up' : 'down');

function RealReturnCard({ range }: { range: Range }) {
  const s = state.value;
  const rr = realReturn(s, range);
  const [help, setHelp] = useState(false);
  return (
    <div class="card">
      <div class="row between" style="margin-bottom:6px">
        <h2 style="margin:0">Real return</h2>
        <button class="link small" onClick={() => setHelp(!help)}>{help ? 'Hide' : 'How it works'}</button>
      </div>
      {help && (
        <p class="muted small" style="margin-top:0">
          Your gain over the period, with money you added or removed left out, set against what you would have got by simply keeping dollars (they gain whenever the hryvnia weakens) and against inflation. If your hryvnia return is below the dollar's gain, you did worse than holding dollars. Set the expected inflation in Settings to see the after-inflation line.
        </p>
      )}
      {!rr ? (
        <p class="muted small" style="margin:0">Needs at least two daily snapshots in this range. Open the app on another day, or pick a longer range.</p>
      ) : (
        <>
          <div class="muted small" style="margin-bottom:6px">{range === 'All' ? 'Since the first snapshot' : `Last ${range}`} · {rr.days} {rr.days === 1 ? 'day' : 'days'} since {rr.since}</div>
          <div class="item" style="cursor:default"><div class="l"><div>Your return in hryvnia</div>{rr.annualUah != null && <div class="muted small">≈ {pct(rr.annualUah)} a year</div>}</div><div class={`r num ${tone(rr.uah)}`}><b>{pct(rr.uah, 2)}</b></div></div>
          <div class="item" style="cursor:default"><div class="l"><div>Plain dollars would have made</div><div class="muted small">hryvnia {rr.fx >= 0 ? 'weakened' : 'strengthened'} against the dollar</div></div><div class={`r num ${tone(rr.fx)}`}>{pct(rr.fx, 2)}</div></div>
          <div class="item" style="cursor:default"><div class="l"><div>Your return in dollars</div>{rr.annualUsd != null && <div class="muted small">≈ {pct(rr.annualUsd)} a year</div>}</div><div class={`r num ${tone(rr.usd)}`}><b>{pct(rr.usd, 2)}</b></div></div>
          {rr.inflation != null && (
            <div class="item" style="cursor:default"><div class="l"><div>Hryvnia return after inflation</div><div class="muted small">inflation {pct(rr.inflation, 2)} at {s.settings.inflationPct}% a year</div></div><div class={`r num ${tone(rr.realUah!)}`}><b>{pct(rr.realUah!, 2)}</b></div></div>
          )}
          <p class="small" style="margin:10px 0 0">
            {rr.usd >= 0.0005
              ? <>You beat plain dollars by <b class="up">{pct(rr.usd, 2)}</b>: your savings grew even measured in dollars.</>
              : rr.usd <= -0.0005
                ? <>You trailed plain dollars by <b class="down">{pct(Math.abs(rr.usd), 2).replace('+', '')}</b>: holding dollars would have done better.</>
                : <>You roughly matched plain dollars.</>}
          </p>
        </>
      )}
    </div>
  );
}

/** The net worth with its decimals set small, so the whole number leads. */
function Hero({ text }: { text: string }) {
  const i = text.indexOf('.');
  return <div class="hero num">{i < 0 ? text : <>{text.slice(0, i)}<span class="cents">{text.slice(i)}</span></>}</div>;
}
