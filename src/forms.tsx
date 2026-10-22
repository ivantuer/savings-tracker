import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { CATEGORIES, type Category, type Fiat, type Position, type PositionType, type Wallet } from './types';
import { deleteWallet, deletePosition, recordDividend, state, uid, upsertPosition, upsertWallet } from './store';
import { addDays } from './calc';
import { fetchBondQuotes, INZHUR_FUNDS, QUICK_COINS, searchCoins, type CoinHit } from './rates';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  return (
    <div class="sheet-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function WalletForm({ wallet, onClose, onSaved }: { wallet?: Wallet; onClose: () => void; onSaved?: (id: string) => void }) {
  const [name, setName] = useState(wallet?.name ?? '');
  const [category, setCategory] = useState<Category>(wallet?.category ?? 'crypto');
  const save = () => {
    if (!name.trim()) return;
    const id = wallet?.id ?? uid();
    upsertWallet({ id, name: name.trim(), category });
    onSaved?.(id);
    onClose();
  };
  return (
    <Sheet title={wallet ? 'Edit wallet' : 'New wallet'} onClose={onClose}>
      <label>Name</label>
      <input value={name} placeholder="Binance, Monobank, Inzhur…" onInput={(e) => setName(e.currentTarget.value)} />
      <label>Category</label>
      <select value={category} onChange={(e) => setCategory(e.currentTarget.value as Category)}>
        {CATEGORIES.map((c) => <option value={c.id}>{c.label}</option>)}
      </select>
      <div class="actions">
        <button class="ghost" onClick={onClose}>Cancel</button>
        {wallet && <button class="danger" onClick={() => { if (confirm(`Delete ${wallet.name} and all its positions?`)) { deleteWallet(wallet.id); onClose(); } }}>Delete</button>}
        <button class="primary" onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}

const typeFor = (c: Category): PositionType => ({ cash: 'fiat', crypto: 'crypto', stocks: 'stock', inzhur: 'manual', ovdp: 'bond' } as const)[c];
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

export function PositionForm({ wallet, position, onClose, onDeleted }: { wallet: Wallet; position?: Position; onClose: () => void; onDeleted?: () => void }) {
  const type = position?.type ?? typeFor(wallet.category);
  const [name, setName] = useState(position?.name ?? '');
  const [symbol, setSymbol] = useState(position?.symbol ?? '');
  const [coinId, setCoinId] = useState(position?.coingeckoId ?? '');
  const [qty, setQty] = useState(position ? String(position.quantity) : '');
  const [cur, setCur] = useState<Fiat>(position?.currency ?? 'UAH');
  const [cost, setCost] = useState(position?.costBasis != null ? String(position.costBasis) : '');
  const [fund, setFund] = useState(position?.symbol ?? '');
  const [unitPrice, setUnitPrice] = useState(position?.unitPrice != null ? String(position.unitPrice) : '');
  const [manualPrice, setManualPrice] = useState(position?.manualPrice != null ? String(position.manualPrice) : '');
  const [face, setFace] = useState(String(position?.bond?.face ?? 1000));
  const [unitValue, setUnitValue] = useState(position?.bond?.unitValue != null ? String(position.bond.unitValue) : '');
  const [isin, setIsin] = useState(position?.bond?.isin ?? '');
  const [lookupMsg, setLookupMsg] = useState('');
  const [coupon, setCoupon] = useState(position?.bond?.couponRate != null ? String(position.bond.couponRate) : '');
  const [maturity, setMaturity] = useState(position?.bond?.maturity ?? '');
  const [kind, setKind] = useState<'buy' | 'dividend'>('buy');
  const [sourceId, setSourceId] = useState('');
  const [divAmount, setDivAmount] = useState('');
  const [onCredit, setOnCredit] = useState(!!position?.credit);
  const [bank, setBank] = useState(position?.credit?.bank ?? '');
  const [owed, setOwed] = useState(position?.credit ? String(position.credit.owed) : '');
  const [boughtOn, setBoughtOn] = useState(position?.credit?.boughtOn ?? new Date().toISOString().slice(0, 10));
  const [sellBy, setSellBy] = useState(position?.credit?.sellBy ?? '');
  const [hits, setHits] = useState<CoinHit[]>(QUICK_COINS);
  const [q, setQ] = useState('');

  const search = async (v: string) => {
    setQ(v);
    if (v.length < 2) return setHits(QUICK_COINS);
    try { setHits(await searchCoins(v)); } catch { /* keep previous hits */ }
  };
  const lookup = async () => {
    setLookupMsg('Looking up…');
    try {
      const q = (await fetchBondQuotes())[isin.trim().toUpperCase()];
      if (!q) return setLookupMsg('Not in the Inzhur catalog. Enter the value manually.');
      setUnitValue(String(q.sell));
      if (q.maturity) setMaturity(q.maturity);
      setLookupMsg(`Found: ₴${q.sell} per bond, matures ${q.maturity ?? '?'}${q.yieldPct ? `, ${q.yieldPct}% yield` : ''}. The price updates itself.`);
    } catch {
      setLookupMsg('Lookup failed. Try again later.');
    }
  };
  const pick = (c: CoinHit) => { setCoinId(c.id); setSymbol(c.symbol.toUpperCase()); setName(c.name); };

  const quantity = num(qty);
  const valid =
    quantity != null && !Number.isNaN(quantity) &&
    (type === 'crypto' ? !!coinId : type === 'stock' ? !!symbol.trim() : !!name.trim()) &&
    (type !== 'bond' || num(face) != null) &&
    (!onCredit || !!sellBy);

  const increased = !!position && quantity != null && !Number.isNaN(quantity) && quantity > position.quantity;
  const save = () => {
    if (!valid) return;
    const faceN = num(face) ?? 0;
    const p: Position = {
      id: position?.id ?? uid(),
      walletId: wallet.id,
      type,
      name: (name || symbol).trim(),
      symbol: (type === 'manual' ? fund : symbol.trim().toUpperCase()) || undefined,
      coingeckoId: coinId || undefined,
      quantity: quantity!,
      currency: type === 'crypto' || type === 'stock' ? undefined : cur,
      manualPrice: type === 'stock' ? num(manualPrice) : undefined,
      unitPrice: type === 'manual' ? num(unitPrice) : undefined,
      bond: type === 'bond' ? { face: faceN, unitValue: num(unitValue) ?? faceN, couponRate: num(coupon), maturity: maturity || undefined, isin: isin.trim().toUpperCase() || undefined } : undefined,
      credit: type === 'bond' && onCredit ? { bank: bank.trim() || undefined, owed: num(owed) ?? num(cost) ?? 0, boughtOn: boughtOn || undefined, sellBy } : undefined,
      costBasis: num(cost),
      history: position?.history,
      updatedAt: new Date().toISOString(),
    };
    upsertPosition(p, increased && kind === 'dividend' ? { dividend: { sourceId: sourceId || undefined } } : undefined);
    onClose();
  };

  const qtyLabel = { fiat: 'Balance', crypto: 'Amount', stock: 'Shares', manual: 'Certificates (units held)', bond: 'Number of bonds' }[type];
  const costLabel = type === 'crypto' || type === 'stock' ? 'Total cost in USD (optional)' : `Total invested in ${cur} (optional)`;

  return (
    <Sheet title={position ? 'Edit position' : 'Add position'} onClose={onClose}>
      {type === 'crypto' && (
        <>
          <label>Coin</label>
          <input placeholder="Search CoinGecko…" value={q} onInput={(e) => void search(e.currentTarget.value)} />
          <div class="chips">
            {hits.map((c) => <button class="chip" style={coinId === c.id ? 'border-color:var(--accent)' : ''} onClick={() => pick(c)}>{c.symbol.toUpperCase()} · {c.name}</button>)}
          </div>
          {coinId && <p class="muted small">Selected: {name || symbol} ({coinId})</p>}
        </>
      )}
      {type === 'stock' && (
        <>
          <label>Ticker</label>
          <input value={symbol} placeholder="COIN, MSTR, MARA…" onInput={(e) => setSymbol(e.currentTarget.value)} />
        </>
      )}
      {(type === 'fiat' || type === 'manual' || type === 'bond') && (
        <>
          <label>Name</label>
          <input value={name} placeholder={type === 'fiat' ? 'Wallet cash, Card…' : type === 'manual' ? 'REIT, MilTech, Energy…' : 'ОВДП UA4000…'} onInput={(e) => setName(e.currentTarget.value)} />
          <label>Currency</label>
          <select value={cur} onChange={(e) => setCur(e.currentTarget.value as Fiat)}>
            <option>UAH</option><option>USD</option><option>EUR</option>
          </select>
        </>
      )}
      <label>{qtyLabel}</label>
      <input inputMode="decimal" value={qty} onInput={(e) => setQty(e.currentTarget.value)} />
      {increased && (
        <>
          <label>This increase is</label>
          <div class="seg" style="display:flex"><button style="flex:1" class={kind === 'buy' ? 'on' : ''} onClick={() => setKind('buy')}>Bought with my money</button><button style="flex:1" class={kind === 'dividend' ? 'on' : ''} onClick={() => setKind('dividend')}>Dividend / income</button></div>
          <p class="muted small" style="margin:6px 0 0">{kind === 'buy' ? 'Counted as money you added, so it is left out of gains and losses.' : 'Counted as profit and added to your dividends.'}</p>
          {kind === 'dividend' && type === 'fiat' && (
            <>
              <label>Paid by (optional)</label>
              <select value={sourceId} onChange={(e) => setSourceId(e.currentTarget.value)}>
                <option value="">Not specified</option>
                {state.value.positions.filter((x) => x.type !== 'fiat' && x.id !== position!.id).map((x) => <option value={x.id}>{x.symbol ?? x.name}{state.value.wallets.find((w) => w.id === x.walletId) ? ` · ${state.value.wallets.find((w) => w.id === x.walletId)!.name}` : ''}</option>)}
              </select>
            </>
          )}
        </>
      )}
      {type === 'manual' && (
        <>
          <label>Live price from inzhur.reit</label>
          <select value={fund} onChange={(e) => setFund(e.currentTarget.value)}>
            <option value="">None (enter price manually)</option>
            {INZHUR_FUNDS.map((f) => <option value={f.key}>{f.key === 'REIT' ? 'Inzhur REIT' : f.key === 'MILTECH' ? 'Inzhur MilTech' : 'Inzhur Energy'}</option>)}
          </select>
          <label>{fund ? 'Fallback price' : 'Price'} per certificate in {cur} (blank = amount above is the total value)</label>
          <input inputMode="decimal" value={unitPrice} onInput={(e) => setUnitPrice(e.currentTarget.value)} />
        </>
      )}
      {type === 'stock' && (
        <>
          <label>Manual price in USD (used if no live quote)</label>
          <input inputMode="decimal" value={manualPrice} onInput={(e) => setManualPrice(e.currentTarget.value)} />
        </>
      )}
      {type === 'bond' && (
        <>
          <label>ISIN (optional, gives a live price)</label>
          <div class="row">
            <input value={isin} placeholder="UA4000…" onInput={(e) => setIsin(e.currentTarget.value)} />
            <button class="ghost" disabled={isin.trim().length < 12} onClick={() => void lookup()}>Look up</button>
          </div>
          {lookupMsg && <div class="muted small" style="margin-top:6px">{lookupMsg}</div>}
          <label>Face value per bond</label>
          <input inputMode="decimal" value={face} onInput={(e) => setFace(e.currentTarget.value)} />
          <label>{isin ? 'Fallback value' : 'Current value'} per bond (face + accrued; blank = face)</label>
          <input inputMode="decimal" value={unitValue} onInput={(e) => setUnitValue(e.currentTarget.value)} />
          <label>Coupon rate, % per year</label>
          <input inputMode="decimal" value={coupon} onInput={(e) => setCoupon(e.currentTarget.value)} />
          <label>Maturity date</label>
          <input type="date" value={maturity} onInput={(e) => setMaturity(e.currentTarget.value)} />
          <label class="row" style="margin-top:16px"><input type="checkbox" style="width:auto" checked={onCredit} onChange={(e) => setOnCredit(e.currentTarget.checked)} /> Bought with credit money (grace period)</label>
          {onCredit && (
            <>
              <label>Bank / card</label>
              <input value={bank} placeholder="e.g. Privat, Mono credit card" onInput={(e) => setBank(e.currentTarget.value)} />
              <label>Amount to repay in {cur} (blank = total invested)</label>
              <input inputMode="decimal" value={owed} onInput={(e) => setOwed(e.currentTarget.value)} />
              <label>Bought on</label>
              <input type="date" value={boughtOn} onInput={(e) => setBoughtOn(e.currentTarget.value)} />
              <label>Sell by</label>
              <input type="date" value={sellBy} onInput={(e) => setSellBy(e.currentTarget.value)} />
              <div class="chips">
                {[50, 55, 60].map((n) => <button class="chip" onClick={() => boughtOn && setSellBy(addDays(boughtOn, n))}>+{n} days</button>)}
              </div>
            </>
          )}
        </>
      )}
      {position && (type === 'manual' || type === 'crypto' || type === 'stock') && (
        <>
          <label>Record a reinvested dividend ({type === 'manual' ? cur : 'USD'})</label>
          <div class="row">
            <input inputMode="decimal" value={divAmount} placeholder="Amount received" onInput={(e) => setDivAmount(e.currentTarget.value)} />
            <button class="ghost" disabled={!(num(divAmount)! > 0)} onClick={() => { if (recordDividend(position.id, num(divAmount)!)) onClose(); }}>Add</button>
          </div>
          <p class="muted small" style="margin:6px 0 0">Buys more {type === 'manual' ? 'certificates' : 'units'} at the current price and counts it as profit.</p>
        </>
      )}
      <label>{costLabel}</label>
      <input inputMode="decimal" value={cost} onInput={(e) => setCost(e.currentTarget.value)} />
      <div class="actions">
        <button class="ghost" onClick={onClose}>Cancel</button>
        {position && <button class="danger" onClick={() => { deletePosition(position.id); onDeleted?.(); onClose(); }}>Delete</button>}
        <button class="primary" disabled={!valid} onClick={save}>Save</button>
      </div>
    </Sheet>
  );
}
