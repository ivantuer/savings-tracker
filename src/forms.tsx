import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { CATEGORIES, type Category, type Fiat, type Position, type PositionType, type Wallet } from './types';
import { deleteWallet, deletePosition, uid, upsertPosition, upsertWallet } from './store';
import { INZHUR_FUNDS, QUICK_COINS, searchCoins, type CoinHit } from './rates';

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
  const [coupon, setCoupon] = useState(position?.bond?.couponRate != null ? String(position.bond.couponRate) : '');
  const [maturity, setMaturity] = useState(position?.bond?.maturity ?? '');
  const [hits, setHits] = useState<CoinHit[]>(QUICK_COINS);
  const [q, setQ] = useState('');

  const search = async (v: string) => {
    setQ(v);
    if (v.length < 2) return setHits(QUICK_COINS);
    try { setHits(await searchCoins(v)); } catch { /* keep previous hits */ }
  };
  const pick = (c: CoinHit) => { setCoinId(c.id); setSymbol(c.symbol.toUpperCase()); setName(c.name); };

  const quantity = num(qty);
  const valid =
    quantity != null && !Number.isNaN(quantity) &&
    (type === 'crypto' ? !!coinId : type === 'stock' ? !!symbol.trim() : !!name.trim()) &&
    (type !== 'bond' || num(face) != null);

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
      bond: type === 'bond' ? { face: faceN, unitValue: num(unitValue) ?? faceN, couponRate: num(coupon), maturity: maturity || undefined } : undefined,
      costBasis: num(cost),
      history: position?.history,
      updatedAt: new Date().toISOString(),
    };
    upsertPosition(p);
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
          <label>Face value per bond</label>
          <input inputMode="decimal" value={face} onInput={(e) => setFace(e.currentTarget.value)} />
          <label>Current value per bond (face + accrued; blank = face)</label>
          <input inputMode="decimal" value={unitValue} onInput={(e) => setUnitValue(e.currentTarget.value)} />
          <label>Coupon rate, % per year</label>
          <input inputMode="decimal" value={coupon} onInput={(e) => setCoupon(e.currentTarget.value)} />
          <label>Maturity date</label>
          <input type="date" value={maturity} onInput={(e) => setMaturity(e.currentTarget.value)} />
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
