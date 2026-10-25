import { useState } from 'preact/hooks';
import { addTxn, deleteTxn, setCostBasis, state } from './store';
import type { Fiat, Position, Txn, TxnKind } from './types';
import { convert, fmt, fmtNative, fmtQty, localDate, nativeCur, positionLabel, ratesOf } from './calc';
import { ledgerCost, ledgerTotals, positionReturns, MIN_XIRR_DAYS } from './ledger';
import { Sheet } from './forms';
import { signed } from './charts';

const KIND: Record<TxnKind, string> = { buy: 'Bought', sell: 'Sold', dividend: 'Dividend' };
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
const pct = (x: number, digits = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(digits)}%`;
const tone = (x: number) => (x >= 0 ? 'up' : 'down');
const sgn = (n: number, cur: Fiat) => `${n >= 0 || Math.abs(n) < 0.005 ? '+' : '−'}${fmtNative(Math.abs(n), cur)}`;

export function TradesView() {
  const s = state.value;
  const d = s.settings.display;
  const [form, setForm] = useState<Txn | 'new' | null>(null);
  const [filter, setFilter] = useState('all');
  const [shown, setShown] = useState(20);
  const totals = ledgerTotals(s, d);
  const per = positionReturns(s, d);
  const walletName = (p?: Position) => s.wallets.find((w) => w.id === p?.walletId)?.name;
  const list = [...s.txns].filter((t) => filter === 'all' || t.positionId === filter).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const filterable = per.map((r) => ({ id: r.positionId, label: r.position ? positionLabel(r.position) : `${r.label} (removed)` }));
  const canAdd = s.positions.some((p) => p.type !== 'fiat');

  return (
    <>
      <div class="card">
        <details open={s.txns.length === 0}>
          <summary style="cursor:pointer;font-weight:600">What is the trade ledger?</summary>
          <div class="small" style="margin-top:10px">
            <p style="margin:0 0 8px">
              The ledger is a diary of every <b>purchase</b>, <b>sale</b> and <b>dividend</b>, one line each, per position. It only keeps records: it never changes a balance by itself.
            </p>
            <p style="margin:0 0 4px"><b>Why keep it</b></p>
            <ol style="margin:0 0 8px;padding-left:20px">
              <li><b>Real profit.</b> Profit you have already locked in by selling (realized) is shown apart from profit that only exists on paper while you still hold (unrealized).</li>
              <li><b>True cost.</b> The average price you actually paid, worked out from your purchases, instead of one number you typed by hand.</li>
              <li><b>Your yearly return.</b> A percentage per year that takes into account <i>when</i> each amount went in. Adding money a month ago and adding it a year ago are not the same thing.</li>
            </ol>
            <p style="margin:0 0 4px"><b>How entries appear</b></p>
            <ul style="margin:0 0 8px;padding-left:20px">
              <li>Automatically, when you change a position's amount: a bigger amount is recorded as <b>bought</b>, a smaller one as <b>sold</b>, and a raise marked "Dividend / income" as a <b>dividend</b>.</li>
              <li>If you do not type what you paid or received, the app estimates it from the price at that moment and marks the line with <b>≈</b>. Open it and enter the real amount when you know it.</li>
              <li>Or add an old trade yourself with "+ Add past trade". That only records history and never changes your balance.</li>
            </ul>
            <p style="margin:0 0 4px"><b>Terms</b></p>
            <ul class="muted" style="margin:0;padding-left:20px">
              <li><b>Average cost:</b> total paid for the units you still hold, divided by those units.</li>
              <li><b>Realized profit:</b> what a sale paid, minus the average cost of the units sold.</li>
              <li><b>Unrealized profit:</b> what you would gain if you sold now, minus what you paid. Not yours until you sell.</li>
              <li><b>Yearly return (XIRR):</b> the steady yearly rate that explains all your deposits, sales and the current value. Shown once there are {MIN_XIRR_DAYS} days of history, because a short period gives wild numbers.</li>
            </ul>
          </div>
        </details>
      </div>

      {s.txns.length > 0 && (
        <>
          <div class="tiles">
            <div class="card">
              <div class="tile-label">Realized profit</div>
              <div class={`tile-value num ${tone(totals.realized)}`}>{signed(totals.realized, d)}</div>
              <div class="small muted">from sales</div>
            </div>
            <div class="card">
              <div class="tile-label">Dividends</div>
              <div class="tile-value num up">{fmt(totals.dividends, d)}</div>
              <div class="small muted">logged in the ledger</div>
            </div>
            <div class="card">
              <div class="tile-label">Money invested</div>
              <div class="tile-value num">{fmt(totals.invested, d)}</div>
              <div class="small muted num">fees {fmt(totals.fees, d)}</div>
            </div>
            <div class="card">
              <div class="tile-label">Yearly return</div>
              {totals.xirr != null ? <div class={`tile-value num ${tone(totals.xirr)}`}>{pct(totals.xirr)}</div> : <div class="tile-value muted">–</div>}
              <div class="small muted">{totals.xirr != null ? 'all logged trades' : `after ${MIN_XIRR_DAYS} days of history`}</div>
            </div>
          </div>

          {per.map((r) => {
            const cur = r.cur;
            const lc = ledgerCost(r);
            const showUse = lc != null && r.position && (r.position.costBasis == null || Math.abs(r.position.costBasis - lc) > 0.005);
            const partial = r.position && r.coverage < 0.99;
            return (
              <div class="card">
                <div class="row between" style="align-items:flex-start">
                  <div style="min-width:0">
                    <b>{r.position ? positionLabel(r.position) : r.label}</b>
                    <div class="muted small">{r.position ? walletName(r.position) : 'Removed position'} · {r.count} {r.count === 1 ? 'entry' : 'entries'}</div>
                  </div>
                  <div style="text-align:right">
                    {r.totalReturn != null && <div class={`num ${tone(r.totalReturn)}`}><b>{pct(r.totalReturn)}</b></div>}
                    {r.xirr != null && <div class={`small num ${tone(r.xirr)}`}>{pct(r.xirr)} a year</div>}
                  </div>
                </div>
                <table class="prices" style="margin-top:8px"><tbody>
                  <tr><td>Held per ledger</td><td class="num">{fmtQty(Math.max(0, r.held))}</td></tr>
                  <tr><td>Average cost{r.held > 0 ? ' per unit' : ''}</td><td class="num">{r.held > 0 ? fmtNative(r.cost / r.held, cur) : '–'}</td></tr>
                  <tr><td>Invested</td><td class="num">{fmtNative(r.invested, cur)}</td></tr>
                  <tr><td>Realized profit</td><td class={`num ${tone(r.realized)}`}>{sgn(r.realized, cur)}</td></tr>
                  <tr><td>Dividends</td><td class="num">{fmtNative(r.dividends, cur)}</td></tr>
                </tbody></table>
                {partial && <p class="stale" style="margin:8px 0 0">The ledger covers {Math.round(r.coverage * 100)}% of this position, so its returns are partial. Add your earlier purchases to complete it.</p>}
                {r.incomplete && <p class="stale" style="margin:8px 0 0">The ledger shows more sold than bought, so realized profit covers only part of the sales. Add the missing purchase.</p>}
                {showUse && (
                  <button class="ghost" style="width:100%;margin-top:10px" onClick={() => setCostBasis(r.positionId, lc!)}>
                    Use ledger cost as cost basis ({fmtNative(lc!, cur)})
                  </button>
                )}
              </div>
            );
          })}

          <div class="card">
            <div class="row between" style="margin-bottom:10px">
              <h2 style="margin:0">Entries</h2>
              {canAdd && <button class="primary" onClick={() => setForm('new')}>+ Add past trade</button>}
            </div>
            <select value={filter} onChange={(e) => { setFilter(e.currentTarget.value); setShown(20); }}>
              <option value="all">All positions</option>
              {filterable.map((f) => <option value={f.id}>{f.label}</option>)}
            </select>
            <div style="margin-top:6px">
              {list.slice(0, shown).map((t) => (
                <div class="item" onClick={() => setForm(t)}>
                  <div class="l">
                    <div>{KIND[t.kind]} · {t.label}</div>
                    <div class="muted small num">{localDate(new Date(t.at))}{t.quantity > 0 ? ` · ${fmtQty(t.quantity)} units` : ''}{t.fee ? ` · fee ${fmtNative(t.fee, t.cur)}` : ''}</div>
                  </div>
                  <div class={`r num ${t.kind === 'dividend' ? 'up' : ''}`}>
                    {t.est && <span class="muted" title="Estimated from the price at the time">≈ </span>}{fmtNative(t.amount, t.cur)}
                  </div>
                </div>
              ))}
              {list.length === 0 && <p class="muted small">No entries for this position.</p>}
            </div>
            {list.length > shown && <button class="ghost" style="width:100%;margin-top:10px" onClick={() => setShown(shown + 20)}>Show more</button>}
          </div>
        </>
      )}

      {s.txns.length === 0 && (
        <div class="card">
          <p class="muted small" style="margin-top:0">Nothing logged yet. Entries are added when you change a position's amount, or you can add an earlier trade by hand.</p>
          {canAdd
            ? <button class="primary" onClick={() => setForm('new')}>+ Add past trade</button>
            : <p class="muted small" style="margin-bottom:0">Add a crypto, stock, Inzhur or ОВДП position first (cash balances are not trades).</p>}
        </div>
      )}

      {form && <TxnForm txn={form === 'new' ? undefined : form} onClose={() => setForm(null)} />}
    </>
  );
}

function TxnForm({ txn, onClose }: { txn?: Txn; onClose: () => void }) {
  const s = state.value;
  const options = s.positions.filter((p) => p.type !== 'fiat');
  const [positionId, setPositionId] = useState(txn?.positionId ?? options[0]?.id ?? '');
  const [kind, setKind] = useState<TxnKind>(txn?.kind ?? 'buy');
  const [date, setDate] = useState(txn ? localDate(new Date(txn.at)) : localDate());
  const [qty, setQty] = useState(txn ? String(txn.quantity) : '');
  const [amount, setAmount] = useState(txn ? String(txn.amount) : '');
  const [fee, setFee] = useState(txn?.fee ? String(txn.fee) : '');
  const [rate, setRate] = useState('');
  const [note, setNote] = useState(txn?.note ?? '');

  const position = s.positions.find((p) => p.id === positionId);
  const cur: Fiat = position ? nativeCur(position) : (txn?.cur ?? 'USD');
  const amountN = num(amount), qtyN = num(qty), feeN = num(fee) ?? 0, rateN = num(rate);
  const unitsOk = kind === 'dividend' || (qtyN != null && !Number.isNaN(qtyN) && qtyN > 0);
  const valid = (!!position || (!!txn && positionId === txn.positionId)) && amountN != null && !Number.isNaN(amountN) && amountN > 0 && unitsOk && !Number.isNaN(feeN) && feeN >= 0;

  const save = () => {
    if (!valid) return;
    const f = kind === 'dividend' ? 0 : feeN;
    const net = kind === 'buy' ? amountN! + f : amountN! - f;
    const usd = cur === 'UAH' && rateN && rateN > 0 ? net / rateN : convert(net, cur, 'USD', ratesOf(s));
    // keep the original moment when the day was not changed, so entries on the same day keep their order
    const at = txn && localDate(new Date(txn.at)) === date ? txn.at : new Date(`${date}T12:00:00`).toISOString();
    addTxn({
      id: txn?.id, at, positionId, label: position ? positionLabel(position) : txn!.label, kind,
      quantity: qtyN != null && !Number.isNaN(qtyN) ? qtyN : 0, amount: amountN!, cur, fee: f > 0 ? f : undefined,
      usd: Math.round(usd * 100) / 100, note: note.trim() || undefined,
    });
    onClose();
  };

  return (
    <Sheet title={txn ? 'Edit entry' : 'Add past trade'} onClose={onClose}>
      <label>Position</label>
      <select value={positionId} onChange={(e) => setPositionId(e.currentTarget.value)}>
        {txn && !s.positions.some((p) => p.id === txn.positionId) && <option value={txn.positionId}>{txn.label} (removed)</option>}
        {options.map((p) => <option value={p.id}>{positionLabel(p)}{s.wallets.find((w) => w.id === p.walletId) ? ` · ${s.wallets.find((w) => w.id === p.walletId)!.name}` : ''}</option>)}
      </select>
      <label>Type</label>
      <div class="seg" style="display:flex">
        {(['buy', 'sell', 'dividend'] as TxnKind[]).map((k) => <button style="flex:1" class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{KIND[k]}</button>)}
      </div>
      <label>Date</label>
      <input type="date" value={date} onInput={(e) => setDate(e.currentTarget.value)} />
      <label>{kind === 'dividend' ? 'Units received (optional)' : kind === 'buy' ? 'Units bought' : 'Units sold'}</label>
      <input inputMode="decimal" value={qty} onInput={(e) => setQty(e.currentTarget.value)} />
      <label>{kind === 'buy' ? 'Total paid' : kind === 'sell' ? 'Total received' : 'Amount received'} in {cur}</label>
      <input inputMode="decimal" value={amount} onInput={(e) => setAmount(e.currentTarget.value)} />
      {kind !== 'dividend' && (
        <>
          <label>Fee in {cur} (optional)</label>
          <input inputMode="decimal" value={fee} onInput={(e) => setFee(e.currentTarget.value)} />
        </>
      )}
      {cur === 'UAH' && (
        <>
          <label>Dollar rate that day, ₴ per $ (optional)</label>
          <input inputMode="decimal" value={rate} placeholder="blank = today's rate" onInput={(e) => setRate(e.currentTarget.value)} />
        </>
      )}
      <label>Note (optional)</label>
      <input value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      <p class="muted small" style="margin:10px 0 0">This only records history. It does not change your balance.</p>
      <div class="actions">
        <button class="ghost" onClick={onClose}>Cancel</button>
        {txn && <button class="danger" onClick={() => { if (confirm('Delete this entry? Your balance stays as it is.')) { deleteTxn(txn.id); onClose(); } }}>Delete</button>}
        <button class="primary" disabled={!valid} onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}
